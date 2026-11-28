package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
)

// headerStub is a ResponseWriter whose header map the caller owns, so a benchmark can reuse it.
type headerStub struct{ h http.Header }

func (s *headerStub) Header() http.Header         { return s.h }
func (s *headerStub) Write(p []byte) (int, error) { return len(p), nil }
func (s *headerStub) WriteHeader(int)             {}

var baseSecurityHeaders = map[string]string{
	"X-Content-Type-Options":  "nosniff",
	"X-Frame-Options":         "DENY",
	"X-Xss-Protection":        "0",
	"Referrer-Policy":         "strict-origin-when-cross-origin",
	"Content-Security-Policy": "default-src 'self'",
	"Permissions-Policy":      "camera=(), microphone=(), geolocation=()",
	"Cache-Control":           "no-store",
}

const wantHSTS = "max-age=31536000; includeSubDomains"

func TestSecurityHeadersWithTLS_ExactHeaderSet(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		mode     string
		wantHSTS bool
	}{{"", false}, {"auto", true}, {"manual", true}, {"off", true}} {
		t.Run("mode="+tc.mode, func(t *testing.T) {
			t.Parallel()
			h := api.SecurityHeadersWithTLS(tc.mode)(http.HandlerFunc(ok))
			rr := serveRequest(h, httptest.NewRequest(http.MethodGet, "/", nil))
			got := rr.Header()
			want := len(baseSecurityHeaders)
			if tc.wantHSTS {
				want++
			}
			if len(got) != want {
				t.Errorf("header count = %d, want %d: %v", len(got), want, got)
			}
			for k, v := range baseSecurityHeaders {
				if vs := got[k]; len(vs) != 1 || vs[0] != v {
					t.Errorf("%s = %q, want [%q]", k, vs, v)
				}
			}
			vs, present := got["Strict-Transport-Security"]
			if present != tc.wantHSTS || (present && (len(vs) != 1 || vs[0] != wantHSTS)) {
				t.Errorf("HSTS = %q (present %v), want present=%v value %q", vs, present, tc.wantHSTS, wantHSTS)
			}
		})
	}
}

func TestSecurityHeadersWithTLS_HandlerMutationIsIsolated(t *testing.T) {
	t.Parallel()
	h := api.SecurityHeadersWithTLS("auto")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "max-age=60")
		w.Header().Add("Content-Security-Policy", "img-src 'none'")
		w.Header().Add("X-Frame-Options", "SAMEORIGIN")
		w.Header().Del("Permissions-Policy")
	}))
	got := serveRequest(h, httptest.NewRequest(http.MethodGet, "/", nil)).Header()

	if v := got["Cache-Control"]; len(v) != 1 || v[0] != "max-age=60" {
		t.Errorf("Cache-Control = %q", v)
	}
	if v := got["Content-Security-Policy"]; len(v) != 2 || v[0] != "default-src 'self'" || v[1] != "img-src 'none'" {
		t.Errorf("Content-Security-Policy = %q", v)
	}
	if v := got["X-Frame-Options"]; len(v) != 2 || v[0] != "DENY" || v[1] != "SAMEORIGIN" {
		t.Errorf("X-Frame-Options = %q", v)
	}
	if _, ok := got["Permissions-Policy"]; ok {
		t.Error("Permissions-Policy not deleted")
	}
	for k, want := range map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Xss-Protection":          "0",
		"Referrer-Policy":           "strict-origin-when-cross-origin",
		"Strict-Transport-Security": wantHSTS,
	} {
		if v := got[k]; len(v) != 1 || v[0] != want {
			t.Errorf("%s = %q, want [%q]", k, v, want)
		}
	}
}

func TestSecurityHeadersWithTLS_AllocsPerRequest(t *testing.T) {
	for _, mode := range []string{"auto", ""} {
		h := api.SecurityHeadersWithTLS(mode)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		w := &headerStub{h: make(http.Header, 16)}
		allocs := testing.AllocsPerRun(100, func() {
			clear(w.h)
			h.ServeHTTP(w, req)
		})
		if allocs > 1 {
			t.Errorf("mode %q: %v allocs per request, want <= 1", mode, allocs)
		}
	}
}

func BenchmarkSecurityHeaders(b *testing.B) {
	h := api.SecurityHeadersWithTLS("auto")(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := &headerStub{h: make(http.Header, 16)}
	b.ReportAllocs()
	for b.Loop() {
		clear(w.h)
		h.ServeHTTP(w, req)
	}
}
