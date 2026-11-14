package api_test

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/andybalholm/brotli"
)

var portalBigJS = strings.Repeat("export const greeting = 'hello from the portal';\n", 400)

func compressiblePortalBundle() fstest.MapFS {
	b := portalBundle()
	b["index.html"] = &fstest.MapFile{Data: []byte(portalIndex + strings.Repeat("<!-- padding -->", 100))}
	b["assets/big-abc123.js"] = &fstest.MapFile{Data: []byte(portalBigJS)}
	b["assets/logo.png"] = &fstest.MapFile{Data: []byte(strings.Repeat("png", 400))}
	return b
}

func getPortalEncoded(t *testing.T, h http.Handler, path string, acceptEncoding ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for _, v := range acceptEncoding {
		req.Header.Add("Accept-Encoding", v)
	}
	return serveRequest(h, req)
}

func decodePortalBody(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var r io.Reader = bytes.NewReader(rec.Body.Bytes())
	switch rec.Header().Get("Content-Encoding") {
	case "gzip":
		zr, err := gzip.NewReader(r)
		if err != nil {
			t.Fatalf("gzip reader: %v", err)
		}
		r = zr
	case "br":
		r = brotli.NewReader(r)
	case "":
	default:
		t.Fatalf("unexpected Content-Encoding %q", rec.Header().Get("Content-Encoding"))
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return string(b)
}

func TestPortal_ServesTheBestAcceptedEncoding(t *testing.T) {
	h := portalRouter(compressiblePortalBundle())
	cases := []struct {
		accept []string
		want   string
	}{
		{[]string{"gzip, deflate, br, zstd"}, "br"},
		{[]string{"gzip", "br"}, "br"},
		{[]string{"gzip, deflate"}, "gzip"},
		{[]string{"br;q=0, gzip;q=0.5"}, "gzip"},
		{[]string{"*"}, "br"},
		{[]string{"*, br;q=0"}, "gzip"},
		{[]string{"BR"}, "br"},
	}
	for _, tc := range cases {
		rec := getPortalEncoded(t, h, "/assets/big-abc123.js", tc.accept...)
		if rec.Code != http.StatusOK {
			t.Fatalf("%v: status %d", tc.accept, rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != tc.want {
			t.Errorf("Accept-Encoding %v: Content-Encoding %q, want %q", tc.accept, got, tc.want)
		}
		if got := decodePortalBody(t, rec); got != portalBigJS {
			t.Errorf("Accept-Encoding %v: decoded body differs from the file", tc.accept)
		}
		if got := rec.Header().Get("Content-Length"); got != strconv.Itoa(rec.Body.Len()) {
			t.Errorf("Accept-Encoding %v: Content-Length %q, body %d bytes", tc.accept, got, rec.Body.Len())
		}
		if rec.Body.Len() >= len(portalBigJS) {
			t.Errorf("Accept-Encoding %v: %d bytes, not smaller than the raw %d", tc.accept, rec.Body.Len(), len(portalBigJS))
		}
	}
}

// A client that does not ask for compression, or refuses every coding the
// portal has, gets the raw bytes and no Content-Encoding.
func TestPortal_RawWhenCompressionNotAccepted(t *testing.T) {
	h := portalRouter(compressiblePortalBundle())
	for _, accept := range [][]string{nil, {"identity"}, {"deflate, zstd"}, {"gzip;q=0, br;q=0"}, {"*;q=0"}, {"gzip;q=0.000"}} {
		rec := getPortalEncoded(t, h, "/assets/big-abc123.js", accept...)
		if ce := rec.Header().Get("Content-Encoding"); ce != "" {
			t.Errorf("Accept-Encoding %v: Content-Encoding %q, want none", accept, ce)
		}
		if rec.Body.String() != portalBigJS {
			t.Errorf("Accept-Encoding %v: body is not the raw file", accept)
		}
		if v := rec.Header().Values("Vary"); !containsFold(v, "Accept-Encoding") {
			t.Errorf("Accept-Encoding %v: Vary %v lacks Accept-Encoding", accept, v)
		}
	}
}

func TestPortal_IndexIsCompressedWithItsHeaders(t *testing.T) {
	bundle := compressiblePortalBundle()
	rec := getPortalEncoded(t, portalRouter(bundle), "/", "br")
	if rec.Header().Get("Content-Encoding") != "br" {
		t.Fatalf("GET / Content-Encoding %q, want br", rec.Header().Get("Content-Encoding"))
	}
	if got := decodePortalBody(t, rec); got != string(bundle["index.html"].Data) {
		t.Fatalf("GET / decoded body differs from index.html")
	}
	if rec.Header().Get("Content-Security-Policy") == "" || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("GET / lost its index headers: %v", rec.Header())
	}
	if !containsFold(rec.Header().Values("Vary"), "Accept-Encoding") {
		t.Fatalf("GET / Vary %v lacks Accept-Encoding", rec.Header().Values("Vary"))
	}
}

// Already-compressed formats and files too small to shrink are sent as they are.
func TestPortal_SkipsFilesThatDoNotShrink(t *testing.T) {
	h := portalRouter(compressiblePortalBundle())
	for _, p := range []string{"/assets/logo.png", "/assets/index-abc123.js"} {
		rec := getPortalEncoded(t, h, p, "gzip, br")
		if ce := rec.Header().Get("Content-Encoding"); ce != "" {
			t.Errorf("%s: Content-Encoding %q, want none", p, ce)
		}
		if !containsFold(rec.Header().Values("Vary"), "Accept-Encoding") {
			t.Errorf("%s: Vary lacks Accept-Encoding", p)
		}
	}
}

func containsFold(values []string, want string) bool {
	for _, v := range values {
		for part := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), want) {
				return true
			}
		}
	}
	return false
}
