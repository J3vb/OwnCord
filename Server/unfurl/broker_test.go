package unfurl

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/externalcontent"
	"github.com/J3vb/OwnCord/Server/safefetch"
)

func loopbackBroker(t *testing.T, srv *httptest.Server) *externalcontent.Broker {
	t.Helper()
	_, portText, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portText)
	tweak := func(p safefetch.Policy) safefetch.Policy {
		p.Schemes = []string{"http"}
		p.Ports = []int{port}
		p.Classify = func(a netip.Addr) error {
			if a.Unmap().IsLoopback() {
				return nil
			}
			return safefetch.ClassifyAddr(a)
		}
		return p
	}
	b, err := externalcontent.New(tweak(externalcontent.DefaultPagePolicy), tweak(externalcontent.DefaultImagePolicy))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The real broker, against a loopback stub: Open Graph text, the page's image shrunk to the
// stored size, and a picture link that is not a page.
func TestBrokerSource_EndToEnd(t *testing.T) {
	var pageHits atomic.Int32
	png := pngBytes(t, 1600, 800)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			pageHits.Add(1)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<html><head><meta property="og:title" content="Stub page">
<meta property="og:description" content="About it"><meta property="og:image" content="/big.png"></head></html>`))
		case "/big.png", "/direct.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	f := newFixture(t, Options{Enabled: true, ThumbCapBytes: 4 << 20})
	f.u.src = BrokerSource{Broker: loopbackBroker(t, srv)}

	f.u.process(t.Context(), f.message("read "+srv.URL+"/page and see "+srv.URL+"/direct.png"))

	seen := f.ann.all()
	if len(seen) != 1 || len(seen[0].Cards) != 2 {
		t.Fatalf("announced %+v, want one message with two cards", seen)
	}
	page, direct := seen[0].Cards[0], seen[0].Cards[1]
	if *page.Title != "Stub page" || *page.Description != "About it" || page.Image == nil || page.Image.Width != 640 || page.Image.Height != 320 {
		t.Errorf("page card = %+v / %+v", page, page.Image)
	}
	if direct.Title != nil || direct.Image == nil || direct.Image.Width != 640 {
		t.Errorf("direct image card = %+v / %+v", direct, direct.Image)
	}
	// Same bytes shrunk the same way are one thumbnail.
	if page.Image.Hash != direct.Image.Hash {
		t.Error("equal thumbnails should share one stored file")
	}

	f.u.process(t.Context(), f.message(srv.URL+"/page"))
	if pageHits.Load() != 1 {
		t.Errorf("page fetched %d times, want 1", pageHits.Load())
	}
}
