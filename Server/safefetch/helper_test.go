package safefetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
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
	mustDo(t, "SplitHostPort", err)
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
	mustDo(t, "New", err)
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

// gzipRepeated compresses chunk written n times, which is how the bomb tests
// get a tiny wire body that inflates to something large.
func gzipRepeated(t *testing.T, chunk []byte, n int) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	for range n {
		if _, err := zw.Write(chunk); err != nil {
			t.Fatalf("gzip write: %v", err)
		}
	}
	mustDo(t, "gzip close", zw.Close())
	return buf.Bytes()
}

// flushHeaders sends a 200 and its headers immediately, so a handler can then
// stall with the response already in flight.
func flushHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	if fl, ok := w.(http.Flusher); ok {
		fl.Flush()
	}
}

// newTLSChainFetcher builds a fetcher that trusts the given TLS servers and may
// reach every server's port, for the redirect-chain tests.
func newTLSChainFetcher(t *testing.T, schemes []string, servers ...*httptest.Server) *Fetcher {
	t.Helper()
	pool := x509.NewCertPool()
	ports := make([]int, 0, len(servers))
	for _, s := range servers {
		if s.TLS != nil {
			pool.AddCert(s.Certificate())
		}
		ports = append(ports, serverPort(t, s))
	}
	f, err := New(Policy{
		Schemes:              schemes,
		Ports:                ports,
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         3,
		Deadline:             5 * time.Second,
		MaxBytes:             64 << 10,
		MaxDecompressedBytes: 256 << 10,
		MaxConcurrent:        4,
		Classify:             allowLoopback,
		TLSConfig:            &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	})
	mustDo(t, "New", err)
	return f
}
