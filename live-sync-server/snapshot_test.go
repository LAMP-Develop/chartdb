package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSnapshot(t *testing.T, dataDir, id, ts, body string) {
	t.Helper()

	dir := snapshotDir(dataDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}

	if err := os.WriteFile(filepath.Join(dir, ts+".json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write snapshot %s: %v", ts, err)
	}
}

func put(t *testing.T, mux *http.ServeMux, id, body string) {
	t.Helper()

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/diagrams/"+id, strings.NewReader(body)))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204 on put, got %d: %s", rec.Code, rec.Body.String())
	}
}

func snapshotNames(t *testing.T, dataDir, id string) []string {
	t.Helper()

	timestamps, err := snapshotTimestamps(dataDir, id)
	if err != nil {
		t.Fatalf("list snapshots: %v", err)
	}

	return timestamps
}

func TestPutDiagram_KeepsOneGenerationPerDay(t *testing.T) {
	mux, dataDir := newTestMux(t)

	// The first push has nothing to back up yet, and the ones right after it
	// would only duplicate the same day.
	put(t, mux, "takeeats", `{"id":"takeeats","tables":[]}`)
	put(t, mux, "takeeats", `{"id":"takeeats","tables":[{"id":"t1"}]}`)

	if got := snapshotNames(t, dataDir, "takeeats"); len(got) != 1 {
		t.Fatalf("want 1 generation after two pushes, got %v", got)
	}

	// Whatever was on disk before the write is what gets kept.
	body, err := os.ReadFile(snapshotPath(dataDir, "takeeats", snapshotNames(t, dataDir, "takeeats")[0]))
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}

	if want := `{"id":"takeeats","tables":[]}`; string(body) != want {
		t.Fatalf("want snapshot %q, got %q", want, string(body))
	}
}

func TestPutDiagram_TakesANewGenerationAfterADay(t *testing.T) {
	mux, dataDir := newTestMux(t)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[]}`)
	yesterday := time.Now().UTC().Add(-25 * time.Hour).Format(snapshotLayout)
	writeSnapshot(t, dataDir, "takeeats", yesterday, `{"id":"takeeats"}`)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[{"id":"t1"}]}`)

	if got := snapshotNames(t, dataDir, "takeeats"); len(got) != 2 {
		t.Fatalf("want 2 generations across two days, got %v", got)
	}
}

func TestPutDiagram_DropsTheOldestGenerations(t *testing.T) {
	mux, dataDir := newTestMux(t)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[]}`)

	base := time.Now().UTC().Add(-100 * 24 * time.Hour)
	for i := 0; i < snapshotKeep+5; i++ {
		writeSnapshot(t, dataDir, "takeeats",
			base.Add(time.Duration(i)*24*time.Hour).Format(snapshotLayout), `{"id":"takeeats"}`)
	}
	oldest := base.Format(snapshotLayout)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[]}`)

	got := snapshotNames(t, dataDir, "takeeats")
	if len(got) != snapshotKeep {
		t.Fatalf("want %d generations kept, got %d", snapshotKeep, len(got))
	}

	if got[0] == oldest {
		t.Fatalf("oldest generation %s should have been dropped", oldest)
	}
}

func TestListSnapshots_ReportsCountsNewestFirst(t *testing.T) {
	mux, dataDir := newTestMux(t)

	writeSnapshot(t, dataDir, "takeeats", "2026-08-10T00:00:00Z", `{"tables":[{"id":"t1"}],"areas":[],"notes":[]}`)
	writeSnapshot(t, dataDir, "takeeats", "2026-08-11T00:00:00Z",
		`{"tables":[{"id":"t1"},{"id":"t2"}],"areas":[{"id":"a1"}],"notes":[{"id":"n1"},{"id":"n2"}]}`)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/diagrams/takeeats/snapshots", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}

	var metas []snapshotMeta
	if err := json.Unmarshal(rec.Body.Bytes(), &metas); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(metas) != 2 {
		t.Fatalf("want 2 generations, got %d", len(metas))
	}

	if metas[0].TS != "2026-08-11T00:00:00Z" {
		t.Fatalf("want newest first, got %s", metas[0].TS)
	}

	if metas[0].Tables != 2 || metas[0].Areas != 1 || metas[0].Notes != 2 {
		t.Fatalf("want 2/1/2 counts, got %d/%d/%d", metas[0].Tables, metas[0].Areas, metas[0].Notes)
	}
}

func TestRestoreSnapshot_KeepsTheStateItReplaces(t *testing.T) {
	mux, dataDir := newTestMux(t)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[{"id":"t1"}]}`)
	writeSnapshot(t, dataDir, "takeeats", "2026-08-10T00:00:00Z", `{"id":"takeeats","tables":[]}`)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/diagrams/takeeats/restore",
		strings.NewReader(`{"ts":"2026-08-10T00:00:00Z"}`)))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d: %s", rec.Code, rec.Body.String())
	}

	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/diagrams/takeeats", nil))

	if want := `{"id":"takeeats","tables":[]}`; getRec.Body.String() != want {
		t.Fatalf("want restored body %q, got %q", want, getRec.Body.String())
	}

	// Undoing the restore has to be possible, so the replaced state is kept
	// even though a generation was already taken today.
	var found bool
	for _, ts := range snapshotNames(t, dataDir, "takeeats") {
		body, err := os.ReadFile(snapshotPath(dataDir, "takeeats", ts))
		if err != nil {
			t.Fatalf("read snapshot: %v", err)
		}
		if string(body) == `{"id":"takeeats","tables":[{"id":"t1"}]}` {
			found = true
		}
	}

	if !found {
		t.Fatalf("the state that was replaced was not kept: %v", snapshotNames(t, dataDir, "takeeats"))
	}
}

func TestRestoreSnapshot_RejectsABrokenGeneration(t *testing.T) {
	mux, dataDir := newTestMux(t)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[{"id":"t1"}]}`)
	writeSnapshot(t, dataDir, "takeeats", "2026-08-10T00:00:00Z", `{"id":"takeeats","tabl`)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/diagrams/takeeats/restore",
		strings.NewReader(`{"ts":"2026-08-10T00:00:00Z"}`)))

	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d", rec.Code)
	}

	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, httptest.NewRequest(http.MethodGet, "/diagrams/takeeats", nil))

	if want := `{"id":"takeeats","tables":[{"id":"t1"}]}`; getRec.Body.String() != want {
		t.Fatalf("diagram must be untouched, got %q", getRec.Body.String())
	}
}

func TestRestoreSnapshot_RejectsPathEscapes(t *testing.T) {
	mux, dataDir := newTestMux(t)

	writeSnapshot(t, dataDir, "takeeats", "2026-08-10T00:00:00Z", `{"id":"takeeats"}`)

	for _, ts := range []string{"../../takeeats", "2026-08-10T00:00:00Z/../../../etc/passwd", ""} {
		body, err := json.Marshal(map[string]string{"ts": ts})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/diagrams/takeeats/restore",
			strings.NewReader(string(body))))

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("want 400 for ts %q, got %d", ts, rec.Code)
		}
	}
}

// Everyone shares one server, so one diagram's backups must never reach into
// another's -- neither when a generation is taken nor when one is restored.
func TestRestoreSnapshot_LeavesOtherDiagramsAlone(t *testing.T) {
	mux, dataDir := newTestMux(t)

	put(t, mux, "takeeats", `{"id":"takeeats","tables":[{"id":"t1"}]}`)
	put(t, mux, "ritel", `{"id":"ritel","tables":[{"id":"r1"}]}`)
	writeSnapshot(t, dataDir, "takeeats", "2026-08-10T00:00:00Z", `{"id":"takeeats","tables":[]}`)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/diagrams/takeeats/restore",
		strings.NewReader(`{"ts":"2026-08-10T00:00:00Z"}`)))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d: %s", rec.Code, rec.Body.String())
	}

	other, err := os.ReadFile(diagramPath(dataDir, "ritel"))
	if err != nil {
		t.Fatalf("read other diagram: %v", err)
	}

	if want := `{"id":"ritel","tables":[{"id":"r1"}]}`; string(other) != want {
		t.Fatalf("want other diagram untouched %q, got %q", want, string(other))
	}

	if got := snapshotNames(t, dataDir, "ritel"); len(got) != 0 {
		t.Fatalf("restoring one diagram must not touch another's backups, got %v", got)
	}
}
