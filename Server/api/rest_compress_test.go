package api_test

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/go-chi/chi/v5"
)

// Every route that compresses is on the reviewed allow-list, and every entry
// on the list is a mounted route that compresses.
func TestRESTCompression_OnlyAllowListedRoutes(t *testing.T) {
	routes, ok := fullRouter(t).(chi.Routes)
	if !ok {
		t.Fatal("router is not a chi.Routes")
	}
	allowed := api.CompressedRESTRoutesForTest()
	target := reflect.ValueOf(api.CompressJSONForTest).Pointer()
	compressed := map[string]bool{}
	walked := 0
	walk := func(method, pattern string, _ http.Handler, mws ...func(http.Handler) http.Handler) error {
		walked++
		key := method + " " + pattern
		for _, mw := range mws {
			if reflect.ValueOf(mw).Pointer() == target {
				compressed[key] = true
			}
		}
		if compressed[key] {
			if _, ok := allowed[key]; !ok {
				t.Errorf("%s compresses its replies but is not in compressedRESTRoutes: review it first", key)
			}
		}
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if walked < 100 {
		t.Fatalf("walked only %d routes; expected the full production router", walked)
	}
	for key, why := range allowed {
		if strings.TrimSpace(why) == "" {
			t.Errorf("compressedRESTRoutes[%q] has no description", key)
		}
		if !strings.HasPrefix(key, "GET ") {
			t.Errorf("compressedRESTRoutes[%q]: only GET replies are compressed", key)
		}
		if !compressed[key] {
			t.Errorf("compressedRESTRoutes lists %q, but no mounted route by that name uses compressJSON", key)
		}
	}
}

var restCompressBody = `{"messages":[` + strings.Repeat(`{"id":1,"content":"hello there"},`, 100) + `{"id":2}]}`

func restCompressHandler(status int) http.Handler {
	return api.CompressJSONForTest(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, restCompressBody)
	}))
}

func TestRESTCompression_GzipsWhenAccepted(t *testing.T) {
	for _, accept := range []string{"gzip", "gzip, deflate, br", "gzip, deflate, br, zstd"} {
		assertRESTGzip(t, accept)
	}
}

func assertRESTGzip(t *testing.T, accept string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil)
	req.Header.Set("Accept-Encoding", accept)
	rec := httptest.NewRecorder()
	restCompressHandler(http.StatusOK).ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Accept-Encoding %q: Content-Encoding %q, want gzip", accept, rec.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary %q lacks Accept-Encoding", rec.Header().Get("Vary"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(zr)
	if err != nil || string(got) != restCompressBody {
		t.Fatalf("decoded body differs (err %v)", err)
	}
}

// The desktop and Android app's HTTP client before this change sends no
// Accept-Encoding: it must keep getting plain JSON.
func TestRESTCompression_PlainWhenNotAccepted(t *testing.T) {
	for _, accept := range []string{"", "identity", "br", "zstd", "gzip;q=0"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		rec := httptest.NewRecorder()
		restCompressHandler(http.StatusOK).ServeHTTP(rec, req)
		if ce := rec.Header().Get("Content-Encoding"); ce != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding %q, want none", accept, ce)
		}
		if rec.Body.String() != restCompressBody {
			t.Errorf("Accept-Encoding %q: body changed", accept)
		}
	}
}

// A failure written after the request deadline is rewritten to a plain 503:
// the compressor's Content-Encoding must not survive onto that body.
func TestRESTCompression_DeadlineRewriteStaysPlain(t *testing.T) {
	inner := api.CompressJSONForTest(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, restCompressBody)
	}))
	h := deadlineMW(50 * time.Millisecond)(inner)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels/", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	requireStatus(t, rec, http.StatusServiceUnavailable)
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Fatalf("Content-Encoding %q on the rewritten 503, want none", ce)
	}
	if !strings.Contains(rec.Body.String(), "SERVICE_UNAVAILABLE") {
		t.Fatalf("body %q is not the plain 503", rec.Body.String())
	}
}
