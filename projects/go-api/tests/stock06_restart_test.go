package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The helper runs the real loader and HTTP handler in a fresh process. Closing
// stdin requests an orderly HTTP shutdown, after all responses have been read.
func TestStock06ServiceProcess(t *testing.T) {
	if os.Getenv("STOCK06_SERVICE") != "1" {
		return
	}
	store, err := load(os.Getenv("STOCK06_STATE"))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(store.serve)}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	if err := os.WriteFile(os.Getenv("STOCK06_READY"), []byte("http://"+listener.Addr().String()), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != http.ErrServerClosed {
		t.Fatalf("serve: %v", err)
	}
}

func TestStock06RestartIdempotency(t *testing.T) {
	root := os.Getenv("ACCEPTANCE_CASE_ROOT")
	if !filepath.IsAbs(root) {
		t.Fatal("ACCEPTANCE_CASE_ROOT must be an absolute fresh output directory")
	}
	run, err := os.MkdirTemp(root, "stock06-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("evidence directory: %s", run)
	state := filepath.Join(run, "state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	evidence, err := os.Create(filepath.Join(run, "http-observations.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer evidence.Close()
	record := func(v any) {
		t.Helper()
		if err := json.NewEncoder(evidence).Encode(v); err != nil {
			t.Fatal(err)
		}
	}
	start := func(phase string) (string, func()) {
		t.Helper()
		ready := filepath.Join(run, phase+"-ready")
		coverdir := filepath.Join(run, phase+"-covdata")
		if err := os.Mkdir(coverdir, 0700); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestStock06ServiceProcess$", "-test.v", "-test.gocoverdir="+coverdir)
		cmd.Env = append(os.Environ(), "STOCK06_SERVICE=1", "STOCK06_STATE="+state, "STOCK06_READY="+ready, "GOCOVERDIR="+coverdir)
		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		log, err := os.Create(filepath.Join(run, phase+"-service.log"))
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stdout, cmd.Stderr = log, log
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		waited := make(chan error, 1)
		go func() { waited <- cmd.Wait() }()
		stopped := false
		stop := func() {
			t.Helper()
			if stopped {
				return
			}
			stopped = true
			stdin.Close()
			select {
			case err := <-waited:
				log.Close()
				record(map[string]any{"phase": phase, "event": "normal_shutdown", "pid": cmd.Process.Pid, "error": fmt.Sprint(err)})
				if err != nil {
					t.Fatalf("%s shutdown: %v", phase, err)
				}
			case <-time.After(5 * time.Second):
				cmd.Process.Kill()
				<-waited
				log.Close()
				t.Fatalf("%s failed to shut down normally", phase)
			}
		}
		t.Cleanup(stop)
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(ready); err == nil {
				record(map[string]any{"phase": phase, "event": "started", "pid": cmd.Process.Pid, "state_dir": state, "url": string(b)})
				return string(b), stop
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("%s readiness timed out; see service log", phase)
		return "", stop
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	call := func(base, label, method, path, body string, wantStatus int) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		record(map[string]any{"label": label, "method": method, "path": path, "request_body": body, "status": response.StatusCode, "response_body": string(raw)})
		if response.StatusCode != wantStatus {
			t.Errorf("%s status: got %d want %d; body=%s", label, response.StatusCode, wantStatus, raw)
		}
		var decoded map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			t.Fatalf("%s JSON: %v", label, err)
		}
		return decoded
	}
	stock := func(base, label string, want int) {
		t.Helper()
		got := call(base, label, "GET", "/stock", "", 200)
		if got["available"] != json.Number(fmt.Sprint(want)) {
			t.Errorf("%s available: got %v want %d", label, got["available"], want)
		}
	}
	checkFields := func(label string, got, want map[string]any) {
		t.Helper()
		for key, expected := range want {
			if got[key] != expected {
				t.Errorf("%s field %s: got %v want %v", label, key, got[key], expected)
			}
		}
	}
	firstURL, stop := start("before")
	stock(firstURL, "initial stock", 10)
	bodies := []string{`{"request_id":"restart-first","quantity":2}`, `{"request_id":"restart-second","quantity":3}`}
	first := make([]map[string]any, 2)
	for i, body := range bodies {
		first[i] = call(firstURL, fmt.Sprintf("first reservation %d", i+1), "POST", "/reserve", body, 201)
		want := map[string]any{"request_id": []string{"restart-first", "restart-second"}[i], "quantity": json.Number([]string{"2", "3"}[i]), "available": json.Number([]string{"8", "5"}[i])}
		checkFields(fmt.Sprintf("first reservation %d", i+1), first[i], want)
	}
	stock(firstURL, "before shutdown", 5)
	stop()
	secondURL, stopAgain := start("after")
	stock(secondURL, "after restart", 5)
	for i, body := range bodies {
		retry := call(secondURL, fmt.Sprintf("retry %d", i+1), "POST", "/reserve", body, 200)
		if !reflect.DeepEqual(retry, first[i]) {
			t.Errorf("retry %d differs from complete first response: got %v want %v", i+1, retry, first[i])
		}
		stock(secondURL, fmt.Sprintf("after retry %d", i+1), 5)
	}
	call(secondURL, "changed quantity", "POST", "/reserve", `{"request_id":"restart-first","quantity":1}`, 409)
	stock(secondURL, "after changed quantity", 5)
	stopAgain()

	// A retry can recreate a lost quantity binding. Independently check the
	// restored binding before allowing either original request to be retried.
	state = filepath.Join(run, "binding-state")
	if err := os.Mkdir(state, 0700); err != nil {
		t.Fatal(err)
	}
	bindingURL, stopBinding := start("binding-before")
	stock(bindingURL, "binding initial stock", 10)
	for i, body := range bodies {
		got := call(bindingURL, fmt.Sprintf("binding seed %d", i+1), "POST", "/reserve", body, 201)
		checkFields(fmt.Sprintf("binding seed %d", i+1), got,
			map[string]any{"request_id": []string{"restart-first", "restart-second"}[i],
				"quantity": json.Number([]string{"2", "3"}[i]),
				"available": json.Number([]string{"8", "5"}[i])})
	}
	stock(bindingURL, "binding before shutdown", 5)
	stopBinding()
	bindingRestartURL, stopBindingRestart := start("binding-after")
	stock(bindingRestartURL, "binding after restart", 5)
	call(bindingRestartURL, "changed quantity before any retry", "POST", "/reserve", `{"request_id":"restart-first","quantity":1}`, 409)
	stock(bindingRestartURL, "binding after changed quantity", 5)
	stopBindingRestart()
}
