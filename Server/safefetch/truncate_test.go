package safefetch

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"sync/atomic"
	"testing"
)

// With Truncate, a body past the ceiling comes back cut to it rather than
// refused, and an endless body still stops near the ceiling.
func TestFetch_TruncateKeepsThePrefixOfAnEndlessBody(t *testing.T) {
	var written atomic.Int64
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		chunk := bytes.Repeat([]byte("A"), 32<<10)
		for written.Load() < 256<<20 {
			n, err := w.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				return
			}
		}
	})
	f := newFetcher(t, srv, func(p *Policy) {
		p.MaxBytes = 64 << 10
		p.MaxDecompressedBytes = 16 << 10
		p.Truncate = true
	})
	resp, err := get(f, srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(resp.Body) != 16<<10 {
		t.Fatalf("body is %d bytes, want the %d-byte prefix", len(resp.Body), 16<<10)
	}
	if got := written.Load(); got > 16<<20 {
		t.Fatalf("upstream wrote %d bytes; the read did not stop at the ceiling", got)
	}
}

// A gzip bomb under Truncate inflates only as far as the ceiling.
func TestFetch_TruncateStopsInflatingAtTheCeiling(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	chunk := bytes.Repeat([]byte("B"), 64<<10)
	for range 256 {
		if _, err := zw.Write(chunk); err != nil {
			t.Fatalf("gzip write: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	bomb := buf.Bytes()
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(bomb)
	})
	f := newFetcher(t, srv, func(p *Policy) {
		p.MaxBytes = 64 << 10
		p.MaxDecompressedBytes = 8 << 10
		p.Truncate = true
	})
	resp, err := get(f, srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if len(resp.Body) != 8<<10 || resp.Header.Get("Content-Length") != "8192" {
		t.Fatalf("body %d bytes, Content-Length %q; want the 8192-byte prefix", len(resp.Body), resp.Header.Get("Content-Length"))
	}
}

// A body under the ceiling is untouched by Truncate.
func TestFetch_TruncateLeavesAShortBodyWhole(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	f := newFetcher(t, srv, func(p *Policy) { p.Truncate = true })
	resp, err := get(f, srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if string(resp.Body) != `{"ok":true}` {
		t.Fatalf("body = %q", resp.Body)
	}
}
