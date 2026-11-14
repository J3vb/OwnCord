package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A request that arrives before the background copies exist gets the best
// form made so far: raw before any copy, gzip before the brotli pass.
func TestWritePortalFile_BeforeEncodingFinishes(t *testing.T) {
	raw := []byte(strings.Repeat("body{color:red}\n", 200))
	f := newPortalFile(raw)
	serve := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/assets/x.css", nil)
		req.Header.Set("Accept-Encoding", "gzip, br")
		rec := httptest.NewRecorder()
		writePortalFile(rec, req, f)
		return rec
	}
	if rec := serve(); rec.Header().Get("Content-Encoding") != "" || rec.Body.Len() != len(raw) {
		t.Fatalf("no copies yet: Content-Encoding %q, %d bytes, want raw", rec.Header().Get("Content-Encoding"), rec.Body.Len())
	}
	gz, err := portalEncode(context.Background(), raw, newPortalGzip)
	if err != nil {
		t.Fatal(err)
	}
	f.enc.Store(&portalEncoded{gzip: gz})
	if rec := serve(); rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip only: Content-Encoding %q, want gzip", rec.Header().Get("Content-Encoding"))
	}
}

// A stopped server stops the encoder: it returns, closes ready, and leaves
// the files raw instead of half encoded.
func TestEncodePortalFiles_StopsWhenContextEnds(t *testing.T) {
	files := map[string]*portalFile{
		"assets/a.js": newPortalFile([]byte(strings.Repeat("let a = 1;\n", 50_000))),
		"index.html":  newPortalFile([]byte(strings.Repeat("<p>x</p>", 1_000))),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ready := make(chan struct{})
	go encodePortalFiles(ctx, files, ready)
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("encoder did not stop after its context ended")
	}
	for name, f := range files {
		if f.enc.Load() != nil {
			t.Errorf("%s has copies after a cancelled run", name)
		}
	}
}

func TestEncodePortalFiles_MakesBothCopies(t *testing.T) {
	files := map[string]*portalFile{
		"assets/a.js":  newPortalFile([]byte(strings.Repeat("let a = 1;\n", 500))),
		"assets/b.png": newPortalFile([]byte(strings.Repeat("p", 5_000))),
	}
	ready := make(chan struct{})
	encodePortalFiles(context.Background(), files, ready)
	<-ready
	enc := files["assets/a.js"].enc.Load()
	if enc == nil || enc.gzip == nil || enc.brotli == nil {
		t.Fatalf("a.js copies = %+v, want gzip and brotli", enc)
	}
	if files["assets/b.png"].enc.Load() != nil {
		t.Fatal("a png was encoded")
	}
}

func TestAcceptedEncodings(t *testing.T) {
	cases := []struct {
		in       []string
		gzip, br bool
	}{
		{nil, false, false},
		{[]string{""}, false, false},
		{[]string{"gzip"}, true, false},
		{[]string{"x-gzip"}, true, false},
		{[]string{"br;q=1.0"}, false, true},
		{[]string{"gzip;q=0, br"}, false, true},
		{[]string{"*;q=0.1"}, true, true},
		{[]string{"*;q=0, gzip"}, true, false},
		{[]string{"gzip; q=bad"}, true, false},
		{[]string{"gzip;level=1;q=0"}, false, false},
	}
	for _, tc := range cases {
		gz, br := acceptedEncodings(tc.in)
		if gz != tc.gzip || br != tc.br {
			t.Errorf("acceptedEncodings(%q) = gzip %v br %v, want %v %v", tc.in, gz, br, tc.gzip, tc.br)
		}
	}
}
