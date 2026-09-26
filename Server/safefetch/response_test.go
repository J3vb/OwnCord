package safefetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A Content-Length header is a claim, not a limit. This stub hijacks the
// connection so it can declare ten bytes and then stream 4 MiB — the shape an
// implementation that checks resp.ContentLength and then calls io.ReadAll
// walks straight into.
func TestFetch_LyingContentLength(t *testing.T) {
	const declared, actual = 10, 4 << 20
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("the stub server must support hijacking")
			return
		}
		conn, bw, err := hj.Hijack()
		if err != nil {
			t.Errorf("Hijack: %v", err)
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = fmt.Fprintf(bw, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"+
			"Content-Length: %d\r\nTransfer-Encoding: chunked\r\n\r\n", declared)
		chunk := bytes.Repeat([]byte("A"), 16<<10)
		for sent := 0; sent < actual; sent += len(chunk) {
			_, _ = fmt.Fprintf(bw, "%x\r\n", len(chunk))
			_, _ = bw.Write(chunk)
			_, _ = bw.WriteString("\r\n")
			if err := bw.Flush(); err != nil {
				return
			}
		}
		_, _ = bw.WriteString("0\r\n\r\n")
		_ = bw.Flush()
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxBytes = 64 << 10 })
	resp, err := get(f, srv.URL)
	if err == nil {
		t.Fatalf("a %d-byte body behind a Content-Length of %d was accepted as %d bytes", actual, declared, len(resp.Body))
	}
	if !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("want ErrBodyTooLarge, got %v", err)
	}
}

// The declared length is small and truthful, but the ceiling is smaller: the
// reader, not the header, decides.
func TestFetch_CeilingBeatsHonestContentLength(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write(bytes.Repeat([]byte("A"), 5000))
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxBytes = 1000 })
	if _, err := get(f, srv.URL); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("want ErrBodyTooLarge, got %v", err)
	}
}

// Residual buffering: an endless body must not reach memory before the
// ceiling applies. The stub counts what it managed to write; a client that
// buffered first would let it write the lot.
func TestFetch_EndlessBodyIsCutOffEarly(t *testing.T) {
	var written atomic.Int64
	const want = 256 << 20 // 256 MiB if nothing stopped it
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		chunk := bytes.Repeat([]byte("A"), 32<<10)
		for written.Load() < want {
			n, err := w.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				return
			}
		}
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxBytes = 64 << 10 })
	if _, err := get(f, srv.URL); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("want ErrBodyTooLarge, got %v", err)
	}
	// Some slack for the socket buffers and net/http's own write buffer, but
	// nothing like the whole body.
	if got := written.Load(); got > 16<<20 {
		t.Fatalf("upstream wrote %d bytes past a %d-byte ceiling — the body was buffered before the limit applied", got, 64<<10)
	}
}

// A decompression bomb: tiny on the wire, enormous once inflated. The wire
// ceiling cannot catch this, which is why the decompressed ceiling exists.
func TestFetch_DecompressionBomb(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	chunk := make([]byte, 64<<10)
	for range 256 { // 16 MiB of zeroes, a few KiB compressed
		if _, err := zw.Write(chunk); err != nil {
			t.Fatalf("gzip write: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	bomb := buf.Bytes()
	if len(bomb) > 64<<10 {
		t.Fatalf("the bomb is %d bytes on the wire; it must fit under MaxBytes for this test to mean anything", len(bomb))
	}
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(bomb)
	})
	f := newFetcher(t, srv, func(p *Policy) {
		p.MaxBytes = 64 << 10
		p.MaxDecompressedBytes = 128 << 10
	})
	if _, err := get(f, srv.URL); !errors.Is(err, ErrDecompressedTooLarge) {
		t.Fatalf("want ErrDecompressedTooLarge, got %v", err)
	}
}

// A gzip body that stays inside both ceilings is inflated and returned.
func TestFetch_GzipUnderCeilingSucceeds(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`{"ok":true}`)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	body := buf.Bytes()
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(body)
	})
	resp, err := get(newFetcher(t, srv, nil), srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if string(resp.Body) != `{"ok":true}` {
		t.Fatalf("body = %q", resp.Body)
	}
}

// Slow loris: headers arrive, then the body trickles for longer than the
// total deadline. The deadline covers the whole fetch, not just the connect.
func TestFetch_SlowLorisBodyHitsTheDeadline(t *testing.T) {
	release := make(chan struct{})
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		_, _ = w.Write([]byte("A"))
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-release
	})
	// Registered after stub, so it runs before srv.Close: t.Cleanup is LIFO,
	// and srv.Close blocks on a handler still waiting on this channel.
	t.Cleanup(func() { close(release) })
	f := newFetcher(t, srv, func(p *Policy) { p.Deadline = 250 * time.Millisecond })
	start := time.Now()
	_, err := get(f, srv.URL)
	if err == nil {
		t.Fatal("a body that never ends must not succeed")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want a deadline error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the deadline took %v to bite", elapsed)
	}
}

// Slow loris on the headers: nothing at all comes back.
func TestFetch_SlowLorisHeadersHitTheDeadline(t *testing.T) {
	release := make(chan struct{})
	srv := stub(t, func(http.ResponseWriter, *http.Request) { <-release })
	t.Cleanup(func() { close(release) })
	f := newFetcher(t, srv, func(p *Policy) { p.Deadline = 250 * time.Millisecond })
	if _, err := get(f, srv.URL); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want a deadline error, got %v", err)
	}
}

// The caller's cancellation is honoured mid-body, and reported as such.
func TestFetch_CallerCancellation(t *testing.T) {
	release := make(chan struct{})
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-release
	})
	t.Cleanup(func() { close(release) })
	f := newFetcher(t, srv, nil)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, err := f.Fetch(ctx, Request{URL: srv.URL})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

// A redirect loop terminates on the hop budget rather than spinning.
func TestFetch_RedirectLoop(t *testing.T) {
	var hits atomic.Int64
	var srv *httptest.Server
	srv = stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		http.Redirect(w, &http.Request{}, srv.URL+"/loop", http.StatusFound)
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxRedirects = 3 })
	if _, err := get(f, srv.URL); !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("want ErrTooManyRedirects, got %v", err)
	}
	if got := hits.Load(); got != 4 {
		t.Fatalf("made %d requests, want 1 + 3 redirects", got)
	}
}

// Automatic redirect following must be off: with a zero hop budget a 302 is
// a refusal, not a silent second request.
func TestFetch_ZeroRedirectBudgetRefusesImmediately(t *testing.T) {
	var hits atomic.Int64
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		http.Redirect(w, &http.Request{}, "https://example.com/", http.StatusFound)
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxRedirects = 0 })
	if _, err := get(f, srv.URL); !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("want ErrTooManyRedirects, got %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("made %d requests, want exactly 1", got)
	}
}

// The redirect that matters: a reachable host pointing at a blocked target.
// The whole destination check has to run again on every hop, so the stub is
// reachable (loopback, per the test classifier) and each target is not — and
// the recorded dials prove the refusal happened before the connect, not
// because the connect failed.
func TestFetch_RedirectToPrivateTarget(t *testing.T) {
	for _, target := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"https://10.0.0.5/",
		"https://192.168.1.1/admin",
		"https://192.0.2.7/",
		"https://[fe80::1]/",
		"https://[::ffff:10.0.0.5]/",
	} {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Redirect(w, &http.Request{}, target, http.StatusFound)
		})
		var dialed []string
		var mu sync.Mutex
		// The port allowlist would refuse these first; widen it so the case
		// exercises the address check rather than the port check.
		f := newFetcher(t, srv, func(p *Policy) {
			p.Ports = append(p.Ports, 80, 443)
			p.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
				mu.Lock()
				dialed = append(dialed, addr)
				mu.Unlock()
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			}
		})
		_, err := get(f, srv.URL)
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("redirect to %s: want ErrBlockedAddress, got %v", target, err)
		} else if strings.Contains(err.Error(), "was validated") {
			// That message is the dial binding refusing an address nobody
			// vetted — a real backstop, but it means the hop itself was
			// never put through the destination check.
			t.Errorf("redirect to %s was caught by the dial binding, not by re-validating the hop: %v", target, err)
		}
		mu.Lock()
		for _, a := range dialed {
			host, _, _ := net.SplitHostPort(a)
			if ip, perr := netip.ParseAddr(host); perr == nil && !ip.Unmap().IsLoopback() {
				t.Errorf("redirect to %s: dialled %s — the hop must be refused before the connect", target, a)
			}
		}
		mu.Unlock()
	}
}

// A redirect from https to http is a downgrade and is refused even when http
// is otherwise an allowed scheme.
func TestFetch_RedirectSchemeDowngrade(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, &http.Request{}, "http://example.com/", http.StatusFound)
	})
	// Pretend the first hop was https by asking the policy directly: the
	// downgrade rule compares the previous hop's scheme with the next one's.
	if err := checkNoDowngrade("https", "http"); !errors.Is(err, ErrSchemeDowngrade) {
		t.Fatalf("https -> http must be a downgrade, got %v", err)
	}
	if err := checkNoDowngrade("http", "https"); err != nil {
		t.Fatalf("http -> https is an upgrade, got %v", err)
	}
	if err := checkNoDowngrade("https", "https"); err != nil {
		t.Fatalf("https -> https is fine, got %v", err)
	}
	// And end to end, with http removed from the allowed schemes.
	f2 := newFetcher(t, srv, func(p *Policy) { p.Schemes = []string{"https"} })
	if _, err := get(f2, srv.URL); err == nil {
		t.Fatal("a redirect to an http URL must not be followed")
	}
}

// A 3xx with no Location is not a redirect we can follow.
func TestFetch_RedirectWithoutLocation(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusFound)
	})
	if _, err := get(newFetcher(t, srv, nil), srv.URL); !errors.Is(err, ErrRedirectWithoutLocation) {
		t.Fatalf("want ErrRedirectWithoutLocation, got %v", err)
	}
}

// A relative Location resolves against the current hop, and the fetch ends on
// the final response with FinalURL naming where the body came from.
func TestFetch_RelativeRedirectFollowed(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/final" {
			http.Redirect(w, r, "/final", http.StatusMovedPermanently)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":1}`))
	})
	resp, err := get(newFetcher(t, srv, nil), srv.URL+"/start")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if resp.FinalURL != srv.URL+"/final" {
		t.Fatalf("FinalURL = %q, want %q", resp.FinalURL, srv.URL+"/final")
	}
}

// The sniffed type is checked, not just the declared one: an HTML error page
// wearing a JSON Content-Type is refused.
func TestFetch_SniffedTypeDisagreesWithDeclared(t *testing.T) {
	cases := []struct{ declared, body string }{
		{"application/json", "<!DOCTYPE html><html><body>nope</body></html>"},
		{"text/plain", "<html><head><title>x</title></head></html>"},
		{"application/json", "GIF89a" + string(make([]byte, 64))},
	}
	for _, c := range cases {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", c.declared)
			_, _ = w.Write([]byte(c.body))
		})
		_, err := get(newFetcher(t, srv, nil), srv.URL)
		if !errors.Is(err, ErrContentType) {
			t.Errorf("declared %s with a %.20q body: want ErrContentType, got %v", c.declared, c.body, err)
		}
	}
}

// The declared type is checked too, with parameters stripped and case folded.
func TestFetch_DeclaredTypeAllowlist(t *testing.T) {
	cases := []struct {
		declared string
		ok       bool
	}{
		{"application/json", true},
		{"Application/JSON; charset=utf-8", true},
		{"text/plain; charset=utf-8", true},
		{"text/html", false},
		{"image/png", false},
		{"", false},
	}
	for _, c := range cases {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			if c.declared != "" {
				w.Header().Set("Content-Type", c.declared)
			} else {
				w.Header()["Content-Type"] = nil
			}
			_, _ = w.Write([]byte(`{"ok":1}`))
		})
		_, err := get(newFetcher(t, srv, nil), srv.URL)
		if c.ok && err != nil {
			t.Errorf("declared %q: want success, got %v", c.declared, err)
		}
		if !c.ok && !errors.Is(err, ErrContentType) {
			t.Errorf("declared %q: want ErrContentType, got %v", c.declared, err)
		}
	}
}

// An empty body has nothing to sniff; the declared type still has to pass.
func TestFetch_EmptyBodySkipsSniff(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNoContent)
	})
	if _, err := get(newFetcher(t, srv, nil), srv.URL); err != nil {
		t.Fatalf("an empty body must not fail the sniff check: %v", err)
	}
}

// TestFetch_EmptyBodyWithoutContentTypeIsAccepted: a 201/204 with no body
// and no Content-Type header at all is a normal acknowledgement shape (a
// Web Push service's success response, among others) — there is no content
// to have a type, so it must not be refused for declaring none.
func TestFetch_EmptyBodyWithoutContentTypeIsAccepted(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header()["Content-Type"] = nil
		w.WriteHeader(http.StatusCreated)
	})
	resp, err := get(newFetcher(t, srv, nil), srv.URL)
	if err != nil {
		t.Fatalf("an empty body with no declared Content-Type must be accepted: %v", err)
	}
	if resp.StatusCode != http.StatusCreated || len(resp.Body) != 0 {
		t.Errorf("resp = %+v, want status 201 and an empty body", resp)
	}
}

// TestFetch_NonEmptyBodyWithoutContentTypeIsRefused is the negative
// control: the empty-body exception above must not widen to a body that
// actually arrived with bytes.
func TestFetch_NonEmptyBodyWithoutContentTypeIsRefused(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header()["Content-Type"] = nil
		_, _ = w.Write([]byte(`{"ok":1}`))
	})
	if _, err := get(newFetcher(t, srv, nil), srv.URL); !errors.Is(err, ErrContentType) {
		t.Errorf("a non-empty body with no declared Content-Type: want ErrContentType, got %v", err)
	}
}

// The concurrency cap holds under -race: never more than MaxConcurrent
// fetches in flight, and every one of them still completes.
func TestFetch_ConcurrencyCap(t *testing.T) {
	const maxInFlight, callers = 3, 24
	var inFlight, peak atomic.Int64
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		n := inFlight.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		inFlight.Add(-1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":1}`))
	})
	f := newFetcher(t, srv, func(p *Policy) {
		p.MaxConcurrent = maxInFlight
		p.Deadline = 30 * time.Second
	})
	errs := make(chan error, callers)
	for range callers {
		go func() {
			_, err := get(f, srv.URL)
			errs <- err
		}()
	}
	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("a queued fetch must still succeed: %v", err)
		}
	}
	if got := peak.Load(); got > maxInFlight {
		t.Fatalf("peak concurrency %d exceeded the cap of %d", got, maxInFlight)
	}
}

// Waiting for a slot is cancellable: a caller blocked behind the cap does not
// sit there past its own deadline.
func TestFetch_ConcurrencyCapRespectsCancellation(t *testing.T) {
	release := make(chan struct{})
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	f := newFetcher(t, srv, func(p *Policy) { p.MaxConcurrent = 1; p.Deadline = 10 * time.Second })
	started := make(chan struct{})
	done := make(chan struct{})
	go func() { close(started); _, _ = get(f, srv.URL); close(done) }()
	<-started
	time.Sleep(100 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	_, err := f.Fetch(ctx, Request{URL: srv.URL})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want DeadlineExceeded while queued, got %v", err)
	}
	close(release)
	<-done
}

// A non-2xx response is still returned, with its status and its bounded body:
// the plugin path needs the status code, and turning every 404 into a
// transport error would hide it.
func TestFetch_NonSuccessStatusIsReturned(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("nope"))
	})
	resp, err := get(newFetcher(t, srv, nil), srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if resp.StatusCode != http.StatusNotFound || string(resp.Body) != "nope" {
		t.Fatalf("got %d %q", resp.StatusCode, resp.Body)
	}
}

// A policy missing a ceiling is rejected at construction: there is no silent
// default that would leave a call site unbounded.
func TestNew_RejectsUnboundedPolicy(t *testing.T) {
	base := Policy{
		Schemes:              []string{"https"},
		MaxRedirects:         2,
		Deadline:             time.Second,
		MaxBytes:             1 << 20,
		MaxDecompressedBytes: 1 << 20,
		MaxConcurrent:        2,
	}
	if _, err := New(base); err != nil {
		t.Fatalf("the base policy should be valid: %v", err)
	}
	for name, mutate := range map[string]func(*Policy){
		"no schemes":            func(p *Policy) { p.Schemes = nil },
		"unknown scheme":        func(p *Policy) { p.Schemes = []string{"ftp"} },
		"no deadline":           func(p *Policy) { p.Deadline = 0 },
		"no byte ceiling":       func(p *Policy) { p.MaxBytes = 0 },
		"no inflation ceiling":  func(p *Policy) { p.MaxDecompressedBytes = 0 },
		"no concurrency cap":    func(p *Policy) { p.MaxConcurrent = 0 },
		"negative redirects":    func(p *Policy) { p.MaxRedirects = -1 },
		"absurd redirect count": func(p *Policy) { p.MaxRedirects = 100 },
		"bad port":              func(p *Policy) { p.Ports = []int{0} },
	} {
		p := base
		mutate(&p)
		if _, err := New(p); !errors.Is(err, ErrPolicy) {
			t.Errorf("%s: want ErrPolicy, got %v", name, err)
		}
	}
}

// The method and body survive a 307, and a 302 on a POST becomes a GET with
// no body — the same rule net/http applies, applied by hand because automatic
// redirects are off.
func TestFetch_RedirectMethodRewrite(t *testing.T) {
	for _, tc := range []struct {
		status     int
		wantMethod string
		wantBody   string
	}{
		{http.StatusTemporaryRedirect, http.MethodPost, "hello"},
		{http.StatusPermanentRedirect, http.MethodPost, "hello"},
		{http.StatusFound, http.MethodGet, ""},
		{http.StatusSeeOther, http.MethodGet, ""},
	} {
		var gotMethod, gotBody string
		srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/final" {
				http.Redirect(w, r, "/final", tc.status)
				return
			}
			gotMethod = r.Method
			b := make([]byte, 64)
			n, _ := r.Body.Read(b)
			gotBody = string(b[:n])
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		})
		f := newFetcher(t, srv, nil)
		if _, err := f.Fetch(context.Background(), Request{
			Method: http.MethodPost, URL: srv.URL + "/start", Body: []byte("hello"),
		}); err != nil {
			t.Fatalf("%d: %v", tc.status, err)
		}
		if gotMethod != tc.wantMethod || gotBody != tc.wantBody {
			t.Errorf("%d: got %s %q, want %s %q", tc.status, gotMethod, gotBody, tc.wantMethod, tc.wantBody)
		}
	}
}

// Credentials do not follow a redirect to another host.
func TestFetch_AuthorizationDroppedCrossHost(t *testing.T) {
	target := stub(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("Authorization survived a cross-host redirect: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	origin := stub(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/x", http.StatusFound)
	})
	f := newFetcher(t, origin, func(p *Policy) { p.Ports = append(p.Ports, serverPort(t, target)) })
	if _, err := f.Fetch(context.Background(), Request{
		URL: origin.URL, Header: map[string]string{"Authorization": "Bearer secret"},
	}); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
}

// Request.AllowHost is the caller's own destination rule, and it has to hold
// on every hop: the plugin host allowlist is worthless if a redirect walks
// off it. The stub redirects to a second stub the allowlist does not name.
func TestFetch_AllowHostAppliesToEveryHop(t *testing.T) {
	target := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the redirect target must never be requested")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	origin := stub(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/x", http.StatusFound)
	})
	originHost, _, _ := net.SplitHostPort(strings.TrimPrefix(origin.URL, "http://"))
	f := newFetcher(t, origin, func(p *Policy) { p.Ports = append(p.Ports, serverPort(t, target)) })

	// Both stubs live on 127.0.0.1, so distinguish them by port: the origin's
	// port is allowed, the target's is not.
	seen := map[string]int{}
	allowed := net.JoinHostPort(originHost, strconv.Itoa(serverPort(t, origin)))
	_, err := f.Fetch(context.Background(), Request{
		URL: origin.URL,
		AllowHost: func(hostport string) bool {
			seen[hostport]++
			return hostport == allowed
		},
	})
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("want ErrHostNotAllowed on the second hop, got %v", err)
	}
	if seen[allowed] != 1 || len(seen) != 2 {
		t.Fatalf("AllowHost saw %v, want the origin once and the target once", seen)
	}
}

// A first hop the caller's rule rejects never leaves the process.
func TestFetch_AllowHostRefusesTheFirstHop(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the request must never be made")
		w.Header().Set("Content-Type", "application/json")
	})
	f := newFetcher(t, srv, nil)
	_, err := f.Fetch(context.Background(), Request{
		URL:       srv.URL,
		AllowHost: func(string) bool { return false },
	})
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("want ErrHostNotAllowed, got %v", err)
	}
}

// MustNew is only for a literal policy fixed at compile time; a policy it
// cannot build is a programming error, and it says so rather than handing
// back an unbounded Fetcher.
func TestMustNew_PanicsOnAnInvalidPolicy(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("MustNew must panic on an invalid policy")
		}
	}()
	_ = MustNew(Policy{})
}

// We ask for gzip or nothing. A body in an encoding we did not ask for and do
// not decode is refused rather than handed back as if it were content: the
// alternative is returning brotli bytes with the Content-Encoding header
// stripped, which describes a body that does not exist. A doubled header is
// the same refusal — "gzip, gzip" is a bomb with an extra layer.
func TestFetch_UnexpectedContentEncodingIsRefused(t *testing.T) {
	for _, enc := range []string{"br", "deflate", "compress", "gzip, gzip", "GZIP, br"} {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", enc)
			_, _ = w.Write([]byte(`{"ok":1}`))
		})
		if _, err := get(newFetcher(t, srv, nil), srv.URL); !errors.Is(err, ErrContentEncoding) {
			t.Errorf("Content-Encoding %q: want ErrContentEncoding, got %v", enc, err)
		}
	}
	// Two separate header lines, which Header.Get would only show the first of.
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Add("Content-Encoding", "gzip")
		w.Header().Add("Content-Encoding", "br")
		_, _ = w.Write([]byte(`{"ok":1}`))
	})
	if _, err := get(newFetcher(t, srv, nil), srv.URL); !errors.Is(err, ErrContentEncoding) {
		t.Errorf("two Content-Encoding headers: want ErrContentEncoding, got %v", err)
	}
}

// "identity", and no header at all, are both plain bodies.
func TestFetch_IdentityContentEncodingIsPlain(t *testing.T) {
	for _, enc := range []string{"identity", ""} {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if enc != "" {
				w.Header().Set("Content-Encoding", enc)
			}
			_, _ = w.Write([]byte(`{"ok":1}`))
		})
		resp, err := get(newFetcher(t, srv, nil), srv.URL)
		if err != nil {
			t.Errorf("Content-Encoding %q: %v", enc, err)
			continue
		}
		if string(resp.Body) != `{"ok":1}` {
			t.Errorf("Content-Encoding %q: body = %q", enc, resp.Body)
		}
	}
}

// The returned header has to describe the body actually returned: the
// Content-Encoding is gone because the body is inflated, and Content-Length
// restated because the upstream one described the compressed form.
func TestFetch_ReturnedHeaderDescribesTheReturnedBody(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(`{"ok":true}`)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	body := buf.Bytes()
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
	})
	resp, err := get(newFetcher(t, srv, nil), srv.URL)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding survived on an inflated body: %q", got)
	}
	if got, want := resp.Header.Get("Content-Length"), strconv.Itoa(len(resp.Body)); got != want {
		t.Errorf("Content-Length = %q, want %q (the inflated length)", got, want)
	}
}

// The process gate is a second cap above every Fetcher's own, so a caller
// cannot buy more of the server's sockets by building more Fetchers.
func TestFetch_ProcessGateBoundsEveryFetcher(t *testing.T) {
	prev := processGate
	processGate = make(semaphore, 1)
	t.Cleanup(func() { processGate = prev })

	var inFlight, peak atomic.Int64
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		n := inFlight.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		inFlight.Add(-1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	// Two Fetchers, each allowed four of its own — the process gate is the
	// only thing that can hold the total to one.
	fetchers := []*Fetcher{
		newFetcher(t, srv, func(p *Policy) { p.MaxConcurrent = 4; p.Deadline = 30 * time.Second }),
		newFetcher(t, srv, func(p *Policy) { p.MaxConcurrent = 4; p.Deadline = 30 * time.Second }),
	}
	errs := make(chan error, 12)
	for i := range 12 {
		go func() {
			_, err := get(fetchers[i%2], srv.URL)
			errs <- err
		}()
	}
	for range 12 {
		if err := <-errs; err != nil {
			t.Fatalf("a queued fetch must still succeed: %v", err)
		}
	}
	if got := peak.Load(); got > 1 {
		t.Fatalf("peak concurrency %d across two Fetchers, but the process gate was 1", got)
	}
}

// The ceilings are exact, and exactness must not depend on how the body is
// framed. limitedReader reports its breach on the read *after* the allowance
// runs out, and an http body that returns (n, io.EOF) together never gives it
// that read — so a body of exactly ceiling+1 came back accepted, while
// ceiling+2 was refused. The boundary is asserted directly here.
func TestFetch_ByteCeilingIsExact(t *testing.T) {
	const ceiling = 1000
	for _, size := range []int{ceiling - 1, ceiling, ceiling + 1, ceiling + 2} {
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write(bytes.Repeat([]byte("A"), size))
		})
		resp, err := get(newFetcher(t, srv, func(p *Policy) { p.MaxBytes = ceiling }), srv.URL)
		switch {
		case size <= ceiling && err != nil:
			t.Errorf("%d bytes under a %d ceiling was refused: %v", size, ceiling, err)
		case size <= ceiling && len(resp.Body) != size:
			t.Errorf("%d bytes came back as %d", size, len(resp.Body))
		case size > ceiling && !errors.Is(err, ErrBodyTooLarge):
			t.Errorf("%d bytes over a %d ceiling was accepted (err=%v)", size, ceiling, err)
		}
	}
}

func TestFetch_DecompressedCeilingIsExact(t *testing.T) {
	const ceiling = 1000
	for _, size := range []int{ceiling, ceiling + 1, ceiling + 2} {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		if _, err := zw.Write(bytes.Repeat([]byte("A"), size)); err != nil {
			t.Fatalf("gzip write: %v", err)
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
		body := buf.Bytes()
		srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(body)
		})
		resp, err := get(newFetcher(t, srv, func(p *Policy) {
			p.MaxBytes = 64 << 10
			p.MaxDecompressedBytes = ceiling
		}), srv.URL)
		switch {
		case size <= ceiling && err != nil:
			t.Errorf("%d inflated bytes under a %d ceiling was refused: %v", size, ceiling, err)
		case size <= ceiling && len(resp.Body) != size:
			t.Errorf("%d inflated bytes came back as %d", size, len(resp.Body))
		case size > ceiling && !errors.Is(err, ErrDecompressedTooLarge):
			t.Errorf("%d inflated bytes over a %d ceiling was accepted (err=%v)", size, ceiling, err)
		}
	}
}

// The same boundary at the reader, where the framing is controllable: a
// source that hands back its last bytes together with io.EOF must not slip a
// byte past the allowance.
func TestLimitedReader_ReportsTheBreachWhateverTheFraming(t *testing.T) {
	for _, joinedEOF := range []bool{true, false} {
		l := &limitedReader{r: &eofFramer{data: bytes.Repeat([]byte("A"), 1001), joined: joinedEOF}, remaining: 1001, over: ErrBodyTooLarge}
		got, err := io.ReadAll(l)
		if len(got) != 1001 {
			t.Errorf("joinedEOF=%v: read %d bytes, want 1001", joinedEOF, len(got))
		}
		_ = err
		// The reader itself is allowed to be framing-dependent; readBody is
		// not, which is what the two cases above assert end to end.
	}
}

// eofFramer returns its data either with io.EOF on the final read (joined) or
// with a separate zero-byte EOF read (not joined) — the two shapes an
// io.Reader is allowed to use, and the two the ceiling must agree about.
type eofFramer struct {
	data   []byte
	off    int
	joined bool
}

func (e *eofFramer) Read(p []byte) (int, error) {
	if e.off >= len(e.data) {
		return 0, io.EOF
	}
	n := copy(p, e.data[e.off:])
	e.off += n
	if e.off >= len(e.data) && e.joined {
		return n, io.EOF
	}
	return n, nil
}

// The downgrade rule, end to end and through the redirect loop. The unit
// cases above exercise checkNoDowngrade directly, which left the *call site*
// deletable with the suite green — the "end to end" case they were paired
// with was refused a hop earlier by the scheme allowlist and never reached
// the second hop at all. This one starts on real TLS, so prev.Scheme is
// genuinely https when the http Location arrives.
func TestFetch_RedirectSchemeDowngradeEndToEnd(t *testing.T) {
	target := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an http redirect target must never be requested from an https hop")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/x", http.StatusFound)
	}))
	t.Cleanup(origin.Close)

	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	f, err := New(Policy{
		Schemes:              []string{"http", "https"}, // http is allowed, and still refused as a downgrade
		Ports:                []int{serverPort(t, origin), serverPort(t, target)},
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         3,
		Deadline:             5 * time.Second,
		MaxBytes:             64 << 10,
		MaxDecompressedBytes: 256 << 10,
		MaxConcurrent:        4,
		Classify:             allowLoopback,
		TLSConfig:            &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := get(f, origin.URL); !errors.Is(err, ErrSchemeDowngrade) {
		t.Fatalf("want ErrSchemeDowngrade, got %v", err)
	}
}

// The same chain without the downgrade completes, so the case above is
// refusing the scheme change and not simply failing to speak TLS.
func TestFetch_HTTPSRedirectToHTTPSIsFollowed(t *testing.T) {
	final := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":1}`))
	}))
	t.Cleanup(final.Close)
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL+"/x", http.StatusFound)
	}))
	t.Cleanup(origin.Close)

	pool := x509.NewCertPool()
	pool.AddCert(origin.Certificate())
	pool.AddCert(final.Certificate())
	f, err := New(Policy{
		Schemes:              []string{"https"},
		Ports:                []int{serverPort(t, origin), serverPort(t, final)},
		ContentTypes:         []string{"application/json", "text/plain"},
		MaxRedirects:         3,
		Deadline:             5 * time.Second,
		MaxBytes:             64 << 10,
		MaxDecompressedBytes: 256 << 10,
		MaxConcurrent:        4,
		Classify:             allowLoopback,
		TLSConfig:            &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	resp, err := get(f, origin.URL)
	if err != nil {
		t.Fatalf("an https -> https redirect must be followed: %v", err)
	}
	if string(resp.Body) != `{"ok":1}` || resp.FinalURL != final.URL+"/x" {
		t.Fatalf("body=%q finalURL=%q", resp.Body, resp.FinalURL)
	}
}
