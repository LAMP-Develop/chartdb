package main

import "encoding/json"

func isValidJSON(body []byte) bool {
	return json.Valid(body)
}
