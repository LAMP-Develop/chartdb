// chartdb-live-sync is a minimal REST store for ChartDB's live collaboration
// feature. Each browser polls GET /diagrams/{id} and PUTs its local diagram
// JSON back whenever it changes; conflicts resolve last-write-wins. It sits
// behind the same Caddy vhost + oauth2-proxy gate as te-chartdb, so it does
// not authenticate requests itself.
package main

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
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

	log.Printf("chartdb-live-sync listening on %s (data dir %s)", addr, dataDir)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func handleGetDiagram(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !diagramIDPattern.MatchString(id) {
			http.Error(w, "invalid diagram id", http.StatusBadRequest)
			return
		}

		path := filepath.Join(dataDir, id+".json")

		f, err := os.Open(path)
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

		path := filepath.Join(dataDir, id+".json")
		tmpPath := path + ".tmp"

		if err := os.WriteFile(tmpPath, body, 0o644); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		if err := os.Rename(tmpPath, path); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
