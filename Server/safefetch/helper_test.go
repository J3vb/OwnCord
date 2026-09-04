package safefetch

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

// allowLoopback is the Policy.Classify a test uses to reach an httptest
// server. It is the only reason the seam exists; production leaves
// Policy.Classify nil, and TestNoProductionOverrideOfClassify proves it.
func allowLoopback(addr netip.Addr) error {
	if addr.Unmap().IsLoopback() {
		return nil
	}
	return ClassifyAddr(addr)
}

// testPolicy is a deliberately tight policy: small ceilings so a breach is
// cheap to provoke, and the stub server's own port so the port allowlist is
// exercised rather than bypassed.
func testPolicy(t *testing.T, srv *httptest.Server) Policy {
	t.Helper()
	return Policy{
		Schemes:              []string{"http", "https"},
		Ports:                []int{serverPort(t, srv)},
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         3,
		Deadline:             5 * time.Second,
		MaxBytes:             64 << 10,
		MaxDecompressedBytes: 256 << 10,
		MaxConcurrent:        4,
		Classify:             allowLoopback,
	}
}

func serverPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		t.Fatalf("Atoi(%q): %v", port, err)
	}
	return n
}

// newFetcher builds a Fetcher for srv, letting the caller tighten or loosen
// one field without restating the whole policy.
func newFetcher(t *testing.T, srv *httptest.Server, tweak func(*Policy)) *Fetcher {
	t.Helper()
	p := testPolicy(t, srv)
	if tweak != nil {
		tweak(&p)
	}
	f, err := New(p)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

// stub starts a server whose handler the test controls.
func stub(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// get is the common one-line fetch used by most cases below.
func get(f *Fetcher, url string) (*Response, error) {
	return f.Fetch(context.Background(), Request{URL: url})
}
