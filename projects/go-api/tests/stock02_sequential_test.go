package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Decode with UseNumber first, then compare exact values rather than JSON text.
// Rational arithmetic also avoids rounding a nearby fractional value to want.
func stock02MatchesInteger(value any, want int) bool {
	number, ok := value.(json.Number)
	if !ok {
		return false
	}
	actual, ok := new(big.Rat).SetString(number.String())
	return ok && actual.IsInt() && actual.Cmp(big.NewRat(int64(want), 1)) == 0
}

func TestStock02IntegerResponseValues(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		matches    bool
	}{
		{"integer", `{"value":7}`, true},
		{"exponent", `{"value":7e0}`, true},
		{"decimal", `{"value":7.0}`, true},
		{"scaled exponent", `{"value":70e-1}`, true},
		{"string", `{"value":"7"}`, false},
		{"missing", `{}`, false},
		{"null", `{"value":null}`, false},
		{"boolean", `{"value":true}`, false},
		{"array", `{"value":[7]}`, false},
		{"object", `{"value":{}}`, false},
		{"wrong integer", `{"value":8}`, false},
		{"fraction", `{"value":7.5}`, false},
		{"nearby fraction", `{"value":7.00000000000000001}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var decoded map[string]any
			decoder := json.NewDecoder(strings.NewReader(tc.body))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				t.Fatal(err)
			}
			if got := stock02MatchesInteger(decoded["value"], 7); got != tc.matches {
				t.Errorf("body %s: matches=%v want %v", tc.body, got, tc.matches)
			}
		})
	}
}

// Coverage checklist: fresh stock 10; POST 3 -> 201, echoed fields, 7;
// independent GET -> 7; distinct POST 2 -> 201, echoed fields, 5; GET -> 5.
// Only public HTTP responses establish business expectations.
func TestStock02SequentialReservations(t *testing.T) {
	root := os.Getenv("ACCEPTANCE_CASE_ROOT")
	if !filepath.IsAbs(root) {
		t.Fatal("ACCEPTANCE_CASE_ROOT must be an absolute fresh output directory")
	}
	run, err := os.MkdirTemp(root, "stock02-")
	if err != nil {
		t.Fatal(err)
	}
	// Keep the shared fixture's fresh t.TempDir state inside this execution.
	t.Setenv("TMPDIR", run)
	evidencePath := filepath.Join(run, "http-observations.jsonl")
	evidence, err := os.Create(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := evidence.Close(); err != nil {
			t.Error(err)
		}
	})
	t.Logf("HTTP evidence: %s", evidencePath)
	server := acceptanceHTTPServer(t)
	client := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	call := func(label, method, path, body string, status int, fields map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s HTTP: %v", label, err)
		}
		raw, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if err := json.NewEncoder(evidence).Encode(map[string]any{
			"label": label, "method": method, "url": req.URL.String(),
			"request_body": body, "status": response.StatusCode,
			"response_body": string(raw), "read_error": fmt.Sprint(readErr),
		}); err != nil {
			t.Fatal(err)
		}
		if readErr != nil {
			t.Fatalf("%s response: %v", label, readErr)
		}
		if response.StatusCode != status {
			t.Errorf("%s status: got %d want %d; body=%s", label, response.StatusCode, status, raw)
		}
		var got map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&got); err != nil {
			t.Fatalf("%s JSON object: %v; body=%s", label, err, raw)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			t.Errorf("%s response contains trailing data: %v", label, err)
		}
		for key, want := range fields {
			if integer, ok := want.(int); ok {
				if !stock02MatchesInteger(got[key], integer) {
					t.Errorf("%s field %s: got %#v want JSON integer value %d", label, key, got[key], integer)
				}
			} else if got[key] != want {
				t.Errorf("%s field %s: got %#v want %#v", label, key, got[key], want)
			}
		}
	}
	call("initial stock", "GET", "/stock", "", 200, map[string]any{"available": 10})
	for i, step := range []struct {
		id                  string
		quantity, available int
	}{
		{"ordinary-first", 3, 7},
		{"ordinary-second", 2, 5},
	} {
		body, err := json.Marshal(map[string]any{"request_id": step.id, "quantity": step.quantity})
		if err != nil {
			t.Fatal(err)
		}
		call(fmt.Sprintf("reservation %d", i+1), "POST", "/reserve", string(body), 201,
			map[string]any{"request_id": step.id, "quantity": step.quantity,
				"available": step.available})
		call(fmt.Sprintf("stock after reservation %d", i+1), "GET", "/stock", "", 200,
			map[string]any{"available": step.available})
	}
}
