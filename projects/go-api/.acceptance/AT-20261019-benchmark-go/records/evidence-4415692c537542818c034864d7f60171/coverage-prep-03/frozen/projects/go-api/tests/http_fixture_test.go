package main

import (
 "net/http/httptest"
 "net/http"
 "testing"
)

// Project fixture: exercise the actual Store handler over a real loopback HTTP
// socket. Each test has an isolated state directory and server. No product mocks.
func acceptanceHTTPServer(t *testing.T) *httptest.Server {
 t.Helper()
 store, err := load(t.TempDir())
 if err != nil { t.Fatal(err) }
 server := httptest.NewServer(http.HandlerFunc(store.serve))
 t.Cleanup(server.Close)
 return server
}
