// chartdb-live-sync is a minimal REST store for ChartDB's live collaboration
// feature. Each browser polls GET /diagrams/{id} and PUTs its local diagram
// JSON back whenever it changes; conflicts resolve last-write-wins. It sits
// behind the same Caddy vhost + oauth2-proxy gate as te-chartdb, so it does
// not authenticate requests itself.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const maxDiagramBytes = 10 << 20 // 10MiB

var diagramIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func main() {
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "/data/live-sync"
	}

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("create data dir %s: %v", dataDir, err)
	}

	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /diagrams/{id}", handleGetDiagram(dataDir))
	mux.HandleFunc("PUT /diagrams/{id}", handlePutDiagram(dataDir))
	mux.HandleFunc("GET /diagrams/{id}/snapshots", handleListSnapshots(dataDir))
	mux.HandleFunc("POST /diagrams/{id}/restore", handleRestoreSnapshot(dataDir))

	log.Printf("chartdb-live-sync listening on %s (data dir %s)", addr, dataDir)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func diagramPath(dataDir, id string) string {
	return filepath.Join(dataDir, id+".json")
}

// writeFileAtomically keeps a reader from ever seeing a half-written diagram.
// The temp file is created with a unique name because two writers (a PUT and
// a restore) can be in flight at the same time, and a shared temp name would
// let them interleave into one corrupt file.
func writeFileAtomically(path string, body []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	defer os.Remove(tmpPath)

	if _, err := f.Write(body); err != nil {
		f.Close()

		return err
	}

	if err := f.Close(); err != nil {
		return err
	}

	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return err
	}

	return os.Rename(tmpPath, path)
}

func handleGetDiagram(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !diagramIDPattern.MatchString(id) {
			http.Error(w, "invalid diagram id", http.StatusBadRequest)
			return
		}

		f, err := os.Open(diagramPath(dataDir, id))
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		defer f.Close()

		info, err := f.Stat()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		// http.ServeContent handles If-Modified-Since/ETag negotiation for us,
		// so a poll that hasn't changed costs a 304 with no body.
		http.ServeContent(w, r, id+".json", info.ModTime(), f)
	}
}

func handlePutDiagram(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !diagramIDPattern.MatchString(id) {
			http.Error(w, "invalid diagram id", http.StatusBadRequest)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxDiagramBytes)

		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "body too large or unreadable", http.StatusBadRequest)
			return
		}

		if !isValidJSON(body) {
			http.Error(w, "body is not valid JSON", http.StatusBadRequest)
			return
		}

		// The generation is taken from what is on disk *before* this write,
		// so the picker offers states the diagram actually had.
		if dueForSnapshot(dataDir, id, time.Now()) {
			if err := saveSnapshot(dataDir, id, time.Now()); err != nil {
				// A failed backup must not cost the user their edit.
				log.Printf("snapshot %s: %v", id, err)
			}
		}

		if err := writeFileAtomically(diagramPath(dataDir, id), body); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleListSnapshots(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !diagramIDPattern.MatchString(id) {
			http.Error(w, "invalid diagram id", http.StatusBadRequest)
			return
		}

		metas, err := listSnapshots(dataDir, id)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(metas); err != nil {
			log.Printf("encode snapshots %s: %v", id, err)
		}
	}
}

func handleRestoreSnapshot(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !diagramIDPattern.MatchString(id) {
			http.Error(w, "invalid diagram id", http.StatusBadRequest)
			return
		}

		var request struct {
			TS string `json:"ts"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&request); err != nil ||
			!snapshotTSPattern.MatchString(request.TS) {
			http.Error(w, "invalid snapshot timestamp", http.StatusBadRequest)
			return
		}

		body, err := os.ReadFile(snapshotPath(dataDir, id, request.TS))
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		// Restoring a truncated generation would replace a good diagram with
		// something no browser can parse, and the browsers would then push
		// nothing back to repair it.
		if !isValidJSON(body) {
			http.Error(w, "snapshot is not valid JSON", http.StatusConflict)
			return
		}

		// Unconditional: undoing a restore is the whole reason this is safe
		// to offer, and it must work even twice in the same day.
		if err := saveSnapshot(dataDir, id, time.Now()); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		if err := writeFileAtomically(diagramPath(dataDir, id), body); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
