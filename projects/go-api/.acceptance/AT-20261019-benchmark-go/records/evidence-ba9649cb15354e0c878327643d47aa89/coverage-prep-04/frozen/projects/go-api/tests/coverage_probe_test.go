package main

import (
 "io"
 "testing"
)

// Toolchain probe only; not an acceptance judgment or business case.
func TestCoverageProbe(t *testing.T) {
 server := acceptanceHTTPServer(t)
 response, err := server.Client().Get(server.URL+"/stock")
 if err != nil { t.Fatal(err) }
 defer response.Body.Close()
 if _,err := io.Copy(io.Discard,response.Body); err != nil { t.Fatal(err) }
}
