package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// A generation is kept per day, not per edit: the point is "get back the
	// layout we had on some earlier day", and every PUT is one keystroke.
	snapshotInterval = 24 * time.Hour
	snapshotKeep     = 30
	snapshotLayout   = time.RFC3339
)

var snapshotTSPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)

type snapshotMeta struct {
	TS     string `json:"ts"`
	Tables int    `json:"tables"`
	Areas  int    `json:"areas"`
	Notes  int    `json:"notes"`
	Size   int64  `json:"size"`
}

func snapshotDir(dataDir, id string) string {
	return filepath.Join(dataDir, "snapshots", id)
}

func snapshotPath(dataDir, id, ts string) string {
	return filepath.Join(snapshotDir(dataDir, id), ts+".json")
}

// snapshotTimestamps returns the generations of one diagram, oldest first.
// The timestamp lives in the file name and is always UTC RFC3339, so a
// lexicographic sort is also a chronological one.
func snapshotTimestamps(dataDir, id string) ([]string, error) {
	entries, err := os.ReadDir(snapshotDir(dataDir, id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	timestamps := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ts := strings.TrimSuffix(entry.Name(), ".json")
		if ts != entry.Name() && snapshotTSPattern.MatchString(ts) {
			timestamps = append(timestamps, ts)
		}
	}
	sort.Strings(timestamps)

	return timestamps, nil
}

func listSnapshots(dataDir, id string) ([]snapshotMeta, error) {
	timestamps, err := snapshotTimestamps(dataDir, id)
	if err != nil {
		return nil, err
	}

	metas := make([]snapshotMeta, 0, len(timestamps))
	// Newest first: that is the order the picker shows them in.
	for i := len(timestamps) - 1; i >= 0; i-- {
		ts := timestamps[i]
		body, err := os.ReadFile(snapshotPath(dataDir, id, ts))
		if err != nil {
			continue
		}
		tables, areas, notes := countCollections(body)
		metas = append(metas, snapshotMeta{
			TS:     ts,
			Tables: tables,
			Areas:  areas,
			Notes:  notes,
			Size:   int64(len(body)),
		})
	}

	return metas, nil
}

func dueForSnapshot(dataDir, id string, now time.Time) bool {
	timestamps, err := snapshotTimestamps(dataDir, id)
	if err != nil || len(timestamps) == 0 {
		return true
	}

	latest, err := time.Parse(snapshotLayout, timestamps[len(timestamps)-1])
	if err != nil {
		return true
	}

	return now.Sub(latest) >= snapshotInterval
}

// saveSnapshot copies the diagram as it stands right now into a new
// generation, then drops the oldest ones. A diagram nobody has pushed yet has
// nothing to keep, which is not an error.
func saveSnapshot(dataDir, id string, now time.Time) error {
	body, err := os.ReadFile(diagramPath(dataDir, id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}

	dir := snapshotDir(dataDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	ts := now.UTC().Format(snapshotLayout)
	if err := writeFileAtomically(filepath.Join(dir, ts+".json"), body); err != nil {
		return err
	}

	return pruneSnapshots(dataDir, id)
}

func pruneSnapshots(dataDir, id string) error {
	timestamps, err := snapshotTimestamps(dataDir, id)
	if err != nil {
		return err
	}

	for i := 0; i < len(timestamps)-snapshotKeep; i++ {
		if err := os.Remove(snapshotPath(dataDir, id, timestamps[i])); err != nil {
			return err
		}
	}

	return nil
}
