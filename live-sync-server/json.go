package main

import "encoding/json"

func isValidJSON(body []byte) bool {
	return json.Valid(body)
}

// countCollections reports what the picker shows for a generation. Only the
// lengths matter, so the elements stay raw instead of being decoded into the
// full diagram shape (which this server otherwise knows nothing about).
func countCollections(body []byte) (tables, areas, notes int) {
	var doc struct {
		Tables []json.RawMessage `json:"tables"`
		Areas  []json.RawMessage `json:"areas"`
		Notes  []json.RawMessage `json:"notes"`
	}

	if err := json.Unmarshal(body, &doc); err != nil {
		return 0, 0, 0
	}

	return len(doc.Tables), len(doc.Areas), len(doc.Notes)
}
