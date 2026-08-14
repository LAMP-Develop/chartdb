package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestMux(t *testing.T) (*http.ServeMux, string) {
	t.Helper()
	dataDir := t.TempDir()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /diagrams/{id}", handleGetDiagram(dataDir))
	mux.HandleFunc("PUT /diagrams/{id}", handlePutDiagram(dataDir))
	mux.HandleFunc("GET /diagrams/{id}/snapshots", handleListSnapshots(dataDir))
	mux.HandleFunc("POST /diagrams/{id}/restore", handleRestoreSnapshot(dataDir))

	return mux, dataDir
}

func TestGetDiagram_NotFound(t *testing.T) {
	mux, _ := newTestMux(t)

	req := httptest.NewRequest(http.MethodGet, "/diagrams/takeeats", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestPutThenGetDiagram_RoundTrips(t *testing.T) {
	mux, _ := newTestMux(t)

	body := `{"id":"takeeats","tables":[]}`
	putReq := httptest.NewRequest(http.MethodPut, "/diagrams/takeeats", strings.NewReader(body))
	putRec := httptest.NewRecorder()
	mux.ServeHTTP(putRec, putReq)

	if putRec.Code != http.StatusNoContent {
		t.Fatalf("want 204 on put, got %d: %s", putRec.Code, putRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/diagrams/takeeats", nil)
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("want 200 on get, got %d", getRec.Code)
	}

	if got := getRec.Body.String(); got != body {
		t.Fatalf("want body %q, got %q", body, got)
	}
}

func TestPutDiagram_RejectsInvalidJSON(t *testing.T) {
	mux, dataDir := newTestMux(t)

	req := httptest.NewRequest(http.MethodPut, "/diagrams/takeeats", strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "takeeats.json")); err == nil {
		t.Fatalf("expected no file to be written for invalid JSON")
	}
}

func TestPutDiagram_RejectsPathTraversal(t *testing.T) {
	mux, _ := newTestMux(t)

	req := httptest.NewRequest(http.MethodPut, "/diagrams/..%2Fescape", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for path traversal id, got %d", rec.Code)
	}
}

// 位置も含めて後勝ちで揃える方針なので、後から来た内容が丸ごと勝つ。
func TestPutDiagram_LastWriteWins(t *testing.T) {
	mux, _ := newTestMux(t)

	for _, body := range []string{
		`{"id":"takeeats","tables":[{"id":"t1","x":10}]}`,
		`{"id":"takeeats","tables":[{"id":"t1","x":99}]}`,
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/diagrams/takeeats", strings.NewReader(body)))

		if rec.Code != http.StatusNoContent {
			t.Fatalf("want 204 on put, got %d: %s", rec.Code, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/diagrams/takeeats", nil))

	want := `{"id":"takeeats","tables":[{"id":"t1","x":99}]}`
	if got := rec.Body.String(); got != want {
		t.Fatalf("want body %q, got %q", want, got)
	}
}

func TestPutDiagram_RejectsOversizedBody(t *testing.T) {
	mux, dataDir := newTestMux(t)

	body := `{"id":"takeeats","pad":"` + strings.Repeat("x", maxDiagramBytes) + `"}`
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/diagrams/takeeats", strings.NewReader(body)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}

	if _, err := os.Stat(filepath.Join(dataDir, "takeeats.json")); !os.IsNotExist(err) {
		t.Fatalf("rejected body must not be stored, stat err: %v", err)
	}
}
