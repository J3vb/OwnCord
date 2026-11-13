package externalcontent

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestCard_ReducesPageWithImageStillAURL(t *testing.T) {
	var hits atomic.Int32
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			hits.Add(1)
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte(`<meta property="og:title" content="T"><meta property="og:image" content="/img.gif">
<meta property="og:image:width" content="320">`))
		case "/img.gif":
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write(gif)
		default:
			http.NotFound(w, r)
		}
	})
	b := testBroker(t, srv)
	c, err := b.Card(context.Background(), srv.URL+"/page")
	if err != nil {
		t.Fatal(err)
	}
	if c.Title == nil || *c.Title != "T" || c.ImageURL != srv.URL+"/img.gif" || c.ImageWidth == nil || *c.ImageWidth != 320 {
		t.Fatalf("card = %+v", c)
	}
	if _, err := b.Card(context.Background(), srv.URL+"/page"); err != nil || hits.Load() != 1 {
		t.Errorf("second card: %v, fetches = %d; want the cache to answer", err, hits.Load())
	}
	data, media, err := b.ImageAt(context.Background(), c.ImageURL)
	if err != nil || media != "image/gif" || len(data) == 0 {
		t.Errorf("ImageAt = %d bytes %q %v", len(data), media, err)
	}
}

func TestCard_FailuresKeepTheirClass(t *testing.T) {
	srv := stub(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/image":
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write(gif)
		default:
			http.NotFound(w, r)
		}
	})
	b := testBroker(t, srv)
	if _, err := b.Card(context.Background(), srv.URL+"/image"); FailureOf(err) != WrongType {
		t.Errorf("an image as a page: %v, want wrong-type", err)
	}
	if _, err := b.Card(context.Background(), srv.URL+"/missing"); FailureOf(err) != Unavailable {
		t.Errorf("a 404 page: %v, want unavailable", err)
	}
	long := "http://x.example/" + string(make([]byte, maxURLBytes))
	if _, err := b.Card(context.Background(), long); FailureOf(err) != BlockedDestination {
		t.Errorf("an over-long url: %v, want blocked-destination", err)
	}
}

func TestIsTransient(t *testing.T) {
	if !IsTransient(&Error{Failure: Unavailable, transient: true}) {
		t.Error("a no-slot failure should be transient")
	}
	for _, err := range []error{fail(Unavailable), errors.New("other"), nil} {
		if IsTransient(err) {
			t.Errorf("IsTransient(%v) = true", err)
		}
	}
}
