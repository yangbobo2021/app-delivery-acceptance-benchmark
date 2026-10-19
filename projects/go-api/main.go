package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type Reservation struct {
	RequestID string `json:"request_id"`
	Quantity  int    `json:"quantity"`
	Available int    `json:"available"`
}
type State struct {
	Available int                    `json:"available"`
	Requests  map[string]Reservation `json:"requests"`
}
type Store struct {
	mu    sync.Mutex
	state State
	path  string
}

func load(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "stock.json"), state: State{10, map[string]Reservation{}}}
	if b, err := os.ReadFile(s.path); err == nil {
		if err = json.Unmarshal(b, &s.state); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	s.state.Requests = map[string]Reservation{}
	return s, nil
}
func (s *Store) persist(next State) error {
	b, e := json.Marshal(next)
	if e != nil {
		return e
	}
	tmp := s.path + ".tmp"
	if e = os.WriteFile(tmp, b, 0600); e != nil {
		return e
	}
	return os.Rename(tmp, s.path)
}
func send(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}
func (s *Store) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == "GET" && r.URL.Path == "/stock" {
		send(w, 200, map[string]int{"available": s.state.Available})
		return
	}
	if r.Method != "POST" || r.URL.Path != "/reserve" {
		send(w, 404, map[string]string{"error": "not found"})
		return
	}
	var raw map[string]json.RawMessage
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1048576))
	if d.Decode(&raw) != nil {
		send(w, 400, map[string]string{"error": "invalid json"})
		return
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		send(w, 400, map[string]string{"error": "trailing input"})
		return
	}
	var id string
	var quantity int
	if json.Unmarshal(raw["request_id"], &id) != nil || id == "" || json.Unmarshal(raw["quantity"], &quantity) != nil || quantity < 1 || quantity > 10 {
		send(w, 400, map[string]string{"error": "invalid fields"})
		return
	}
	if old, ok := s.state.Requests[id]; ok {
		if old.Quantity != quantity {
			send(w, 409, map[string]string{"error": "conflicting retry"})
		} else {
			send(w, 200, old)
		}
		return
	}
	if quantity > s.state.Available {
		send(w, 409, map[string]string{"error": "insufficient stock"})
		return
	}
	result := Reservation{id, quantity, s.state.Available - quantity}
	next := State{result.Available, map[string]Reservation{}}
	for k, v := range s.state.Requests {
		next.Requests[k] = v
	}
	next.Requests[id] = result
	if s.persist(next) != nil {
		send(w, 500, map[string]string{"error": "storage failure"})
		return
	}
	s.state = next
	send(w, 201, result)
}
func main() {
	port := flag.Int("port", 8080, "local port")
	dir := flag.String("state-dir", "state", "state directory")
	flag.Parse()
	s, e := load(*dir)
	if e != nil {
		log.Fatal(e)
	}
	host := "127.0.0.1"
	address := fmt.Sprintf("%s:%d", host, *port)
	log.Printf("Listening at %s", address)
	log.Fatal(http.ListenAndServe(address, http.HandlerFunc(s.serve)))
}
