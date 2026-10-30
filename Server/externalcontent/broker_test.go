package externalcontent

import (
	"bytes"
	"context"
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

	"github.com/J3vb/OwnCord/Server/safefetch"
)

var gif = []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")

func allowLoopback(addr netip.Addr) error {
	if addr.Unmap().IsLoopback() {
		return nil
	}
	return safefetch.ClassifyAddr(addr)
}

// testBroker builds a broker whose policies reach srv over plain http on its
// own port; everything else about them is production.
func testBroker(t *testing.T, srv *httptest.Server) *Broker {
	t.Helper()
	_, portText, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("SplitHostPort: %v", err)
	}
	port, _ := strconv.Atoi(portText)
	tweak := func(p safefetch.Policy) safefetch.Policy {
		p.Schemes = []string{"http"}
		p.Ports = []int{port}
		p.Classify = allowLoopback
		return p
	}
	b, err := New(tweak(DefaultPagePolicy), tweak(DefaultImagePolicy))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return b
}

func stub(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestPreview_OpenGraphAndImageHandle(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			if ua := r.Header.Get("User-Agent"); ua != userAgent {
				t.Errorf("User-Agent = %q", ua)
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<!doctype html><html><head><title> Fallback </title>
<!-- <meta property="og:title" content="in a comment"> -->
<script>var s = '<meta property="og:title" content="in a script">';</script>
<meta property="og:title" content="Real title">
<meta property="og:title" content="Second title">
<meta name="description" content="Plain description">
<meta property="og:site_name" content="Example">
<meta property="og:image" content="/img.gif">
<meta property="og:image:width" content="320">
<meta property="og:image:height" content="nope">
</head></html>`))
		case "/img.gif":
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write(gif)
		default:
			http.NotFound(w, r)
		}
	})
	b := testBroker(t, srv)
	p, err := b.Preview(context.Background(), 1, srv.URL+"/page")
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if p.Title == nil || *p.Title != "Real title" {
		t.Fatalf("Title = %v", p.Title)
	}
	if p.Description == nil || *p.Description != "Plain description" {
		t.Fatalf("Description = %v", p.Description)
	}
	if p.SiteName == nil || *p.SiteName != "Example" {
		t.Fatalf("SiteName = %v", p.SiteName)
	}
	if p.ImageWidth == nil || *p.ImageWidth != 320 || p.ImageHeight != nil {
		t.Fatalf("dimensions = %v x %v", p.ImageWidth, p.ImageHeight)
	}
	if p.Image == nil || strings.Contains(*p.Image, "/") {
		t.Fatalf("Image = %v, want an opaque handle", p.Image)
	}

	body, media, err := b.Image(context.Background(), 1, *p.Image, "")
	if err != nil || media != "image/gif" || !bytes.Equal(body, gif) {
		t.Fatalf("Image by handle = %q, %q, %v", body, media, err)
	}
	// A handle answers only the user it was minted for.
	if _, _, err := b.Image(context.Background(), 2, *p.Image, ""); FailureOf(err) != ExpiredHandle {
		t.Fatalf("another user's handle: %v, want expired-handle", err)
	}
}

func TestPreview_TitleFallbackAndOEmbed(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oembed" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"type":"video","version":"1.0","title":"A video"}`))
			return
		}
		if r.URL.Path == "/json" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"title":"not oembed"}`))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><title>  Only &amp; title </title></head></html>`))
	})
	b := testBroker(t, srv)
	p, err := b.Preview(context.Background(), 1, srv.URL+"/plain")
	if err != nil || p.Title == nil || *p.Title != "Only & title" || p.Image != nil {
		t.Fatalf("plain page = %+v, %v", p, err)
	}
	p, err = b.Preview(context.Background(), 1, srv.URL+"/oembed")
	if err != nil || p.Title == nil || *p.Title != "A video" {
		t.Fatalf("oembed = %+v, %v", p, err)
	}
	if _, err := b.Preview(context.Background(), 1, srv.URL+"/json"); FailureOf(err) != WrongType {
		t.Fatalf("non-oembed json: %v, want wrong-type", err)
	}
}

// A page that redirects to a private address is refused before anything is
// fetched from it, the rebinding case the policy exists for. It answers like
// a name that does not resolve, so the server's network cannot be mapped.
func TestPreview_RedirectToPrivateAddressIsRefused(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		_, port, _ := net.SplitHostPort(r.Host)
		http.Redirect(w, r, "http://10.0.0.1:"+port+"/inside", http.StatusFound)
	})
	b := testBroker(t, srv)
	if _, err := b.Preview(context.Background(), 1, srv.URL+"/out"); FailureOf(err) != Unavailable {
		t.Fatalf("redirect to 10.0.0.1: %v, want unavailable", err)
	}
}

// A handle's URL is vetted again when the image is fetched: a page naming an
// off-policy image gets a handle, but the handle fetches nothing.
func TestImage_HandleURLIsVettedAtFetchTime(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<meta property="og:image" content="https://elsewhere.example/x.gif">`))
	})
	b := testBroker(t, srv)
	p, err := b.Preview(context.Background(), 1, srv.URL+"/page")
	if err != nil || p.Image == nil {
		t.Fatalf("Preview = %+v, %v", p, err)
	}
	if _, _, err := b.Image(context.Background(), 1, *p.Image, ""); FailureOf(err) != BlockedDestination {
		t.Fatalf("off-policy handle URL: %v, want blocked-destination", err)
	}
}

func TestPreview_BlockedDestinations(t *testing.T) {
	b, err := New(DefaultPagePolicy, DefaultImagePolicy)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, raw := range []string{
		"http://example.com/",       // scheme
		"https://example.com:8443/", // port
		"https://user:pw@example.com/",
		"https://" + strings.Repeat("a", maxURLBytes) + ".com/",
	} {
		if _, err := b.Preview(context.Background(), 1, raw); FailureOf(err) != BlockedDestination {
			t.Errorf("%s: %v, want blocked-destination", raw, err)
		}
	}
	for _, raw := range []string{"https://127.0.0.1/", "https://[::1]/", "https://10.1.2.3/"} {
		if _, err := b.Preview(context.Background(), 1, raw); FailureOf(err) != Unavailable {
			t.Errorf("%s: %v, want unavailable", raw, err)
		}
	}
}

func TestImage_TypeMustMatchTheBytes(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/svg":
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))
		case "/liar":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(gif)
		case "/missing":
			w.Header().Set("Content-Type", "image/gif")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write(gif)
		}
	})
	b := testBroker(t, srv)
	for path, want := range map[string]Failure{"/svg": WrongType, "/liar": WrongType, "/missing": Unavailable} {
		if _, _, err := b.Image(context.Background(), 1, "", srv.URL+path); FailureOf(err) != want {
			t.Errorf("%s: %v, want %s", path, err, want)
		}
	}
	if _, _, err := b.Image(context.Background(), 1, "", ""); FailureOf(err) != BlockedDestination {
		t.Errorf("no source: %v", err)
	}
	if _, _, err := b.Image(context.Background(), 1, "unknown", ""); FailureOf(err) != ExpiredHandle {
		t.Errorf("unknown handle: %v", err)
	}
}

// Many viewers opening the same image at once cause one upstream fetch, and
// one viewer giving up does not fail the others.
func TestImage_ConcurrentViewersShareOneFetch(t *testing.T) {
	var hits atomic.Int32
	release := make(chan struct{})
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		<-release
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(gif)
	})
	b := testBroker(t, srv)

	quitter, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		ctx := context.Background()
		if i == 0 {
			ctx = quitter
		}
		go func(ctx context.Context) {
			defer wg.Done()
			_, _, err := b.Image(ctx, int64(i), "", srv.URL+"/same.gif")
			errs <- err
		}(ctx)
	}
	time.Sleep(100 * time.Millisecond)
	cancel()
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a viewer failed: %v", err)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hit %d times, want 1", got)
	}
	// Later viewers are served from the cache.
	if _, _, err := b.Image(context.Background(), 9, "", srv.URL+"/same.gif"); err != nil || hits.Load() != 1 {
		t.Fatalf("cached read: %v, hits %d", err, hits.Load())
	}
}

func TestResultCache_EvictsByBytesAndExpires(t *testing.T) {
	c := newResultCache(10, time.Minute)
	now := time.Unix(0, 0)
	c.now = func() time.Time { return now }
	c.put(&cacheEntry{key: "a", size: 6})
	c.put(&cacheEntry{key: "b", size: 4})
	if _, ok := c.get("a"); !ok {
		t.Fatal("a evicted too early")
	}
	c.put(&cacheEntry{key: "c", size: 4}) // over by 4: b is least recent
	if _, ok := c.get("b"); ok {
		t.Fatal("b should have been evicted")
	}
	c.put(&cacheEntry{key: "huge", size: 11})
	if _, ok := c.get("huge"); ok {
		t.Fatal("an entry larger than the cache was kept")
	}
	now = now.Add(time.Minute)
	if _, ok := c.get("a"); ok {
		t.Fatal("a outlived its TTL")
	}
}

func TestHandleTable_PerUserLimitAndReuse(t *testing.T) {
	h := newHandleTable(2)
	other, _ := h.mint(2, "https://a/")
	first, _ := h.mint(1, "https://a/")
	if again, _ := h.mint(1, "https://a/"); again != first {
		t.Fatal("the same image got a second handle for the same user")
	}
	_, _ = h.mint(1, "https://b/")
	_, _ = h.mint(1, "https://c/")
	if _, ok := h.lookup(1, first); ok {
		t.Fatal("the oldest handle survived past the per-user limit")
	}
	if u, ok := h.lookup(2, other); !ok || u != "https://a/" {
		t.Fatal("one user's previews expired another user's handle")
	}
}
