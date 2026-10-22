package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/go-chi/chi/v5"
)

const portalIndex = "<!doctype html><div id=root></div>"

func portalBundle() fstest.MapFS {
	return fstest.MapFS{
		"index.html":              {Data: []byte(portalIndex)},
		"assets/index-abc123.js":  {Data: []byte("export {}")},
		"assets/index-abc123.css": {Data: []byte("body{}")},
		"assets/sub/x.wasm":       {Data: []byte("\x00asm")},
		"secret.txt":              {Data: []byte("outside assets")},
	}
}

// portalRouter mounts the portal behind the global security headers, the way
// NewRouter does, so a test sees which headers the portal replaces.
func portalRouter(bundle fstest.MapFS) http.Handler {
	r := chi.NewRouter()
	r.Use(api.SecurityHeadersWithTLS(""))
	if bundle == nil {
		api.MountPortal(r, nil)
	} else {
		api.MountPortal(r, bundle)
	}
	r.Get("/api/v1/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return r
}

func getPortal(t *testing.T, h http.Handler, host, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if host != "" {
		req.Host = host
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPortal_IndexHeaders(t *testing.T) {
	rec := getPortal(t, portalRouter(portalBundle()), "chat.example.org:8443", "/")
	if rec.Code != http.StatusOK || rec.Body.String() != portalIndex {
		t.Fatalf("GET / = %d %q, want 200 and the bundle's index", rec.Code, rec.Body.String())
	}
	want := map[string]string{
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
			"connect-src 'self' wss://chat.example.org:8443; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; " +
			"worker-src 'self' blob:; frame-src https://www.youtube.com https://youtube.com; object-src 'none'; base-uri 'self'; " +
			"form-action 'self'; frame-ancestors 'none'",
		"Permissions-Policy":     "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
		"Cache-Control":          "no-cache",
		"X-Frame-Options":        "DENY",
		"X-Content-Type-Options": "nosniff",
	}
	for k, v := range want {
		if got := rec.Header().Values(k); len(got) != 1 || got[0] != v {
			t.Errorf("%s = %q, want exactly %q", k, got, v)
		}
	}
}

// A Host header that is not a plain host[:port] never reaches the policy; the
// page keeps connect-src 'self', which still covers its own origin.
func TestPortal_IndexCSPIgnoresOddHost(t *testing.T) {
	for _, host := range []string{"evil.example; script-src *", "a b", "x'y"} {
		rec := getPortal(t, portalRouter(portalBundle()), host, "/")
		csp := rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "connect-src 'self'; ") {
			t.Errorf("host %q: CSP = %q, want connect-src 'self' alone", host, csp)
		}
		if strings.Count(csp, "script-src") != 1 {
			t.Errorf("host %q added a directive: %q", host, csp)
		}
	}
	rec := getPortal(t, portalRouter(portalBundle()), "[::1]:8443", "/")
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "connect-src 'self' wss://[::1]:8443;") {
		t.Errorf("IPv6 host dropped from the policy: %q", csp)
	}
}

func TestPortal_AssetImmutable(t *testing.T) {
	h := portalRouter(portalBundle())
	for path, ct := range map[string]string{
		"/assets/index-abc123.js":  "text/javascript; charset=utf-8",
		"/assets/index-abc123.css": "text/css; charset=utf-8",
		"/assets/sub/x.wasm":       "application/wasm",
	} {
		rec := getPortal(t, h, "", path)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != ct {
			t.Errorf("GET %s Content-Type = %q, want %q", path, got, ct)
		}
		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Errorf("GET %s Cache-Control = %q, want immutable", path, got)
		}
		// Only the index document carries the portal's policy.
		if got := rec.Header().Get("Content-Security-Policy"); got != "default-src 'self'" {
			t.Errorf("GET %s CSP = %q, want the global policy", path, got)
		}
	}
}

func TestPortal_AssetTraversal404(t *testing.T) {
	h := portalRouter(portalBundle())
	for _, path := range []string{
		"/assets/",
		"/assets/sub",
		"/assets/sub/",
		"/assets/missing.js",
		"/assets/../secret.txt",
		"/assets/sub/../../secret.txt",
		"/assets/%2e%2e/secret.txt",
		"/assets/..%2fsecret.txt",
		"/assets/sub\\x.wasm",
		"/assets//index-abc123.js",
		"/assets/.vite/manifest.json",
		"/assets/.DS_Store",
	} {
		rec := getPortal(t, h, "", path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d %q, want 404", path, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("GET %s Cache-Control = %q, want the global no-store", path, rec.Header().Get("Cache-Control"))
		}
	}
}

func TestPortal_PlaceholderBuild404(t *testing.T) {
	for name, bundle := range map[string]fstest.MapFS{
		"nil":         nil,
		"placeholder": {"PLACEHOLDER.txt": {Data: []byte("x")}, "assets/a.js": {Data: []byte("x")}},
	} {
		t.Run(name, func(t *testing.T) {
			h := portalRouter(bundle)
			rec := getPortal(t, h, "", "/")
			if rec.Code != http.StatusNotFound {
				t.Fatalf("GET / = %d, want 404", rec.Code)
			}
			if body := rec.Body.String(); body != "browser client not included in this build\n" {
				t.Errorf("GET / body = %q, want the one-line note", body)
			}
			if ct := rec.Header().Get("Content-Type"); strings.Contains(ct, "html") {
				t.Errorf("GET / Content-Type = %q, want plain text", ct)
			}
			if csp := rec.Header().Get("Content-Security-Policy"); csp != "default-src 'self'" {
				t.Errorf("GET / CSP = %q, want the global policy", csp)
			}
			if rec := getPortal(t, h, "", "/assets/a.js"); rec.Code != http.StatusNotFound {
				t.Errorf("GET /assets/a.js = %d, want 404 without a bundle", rec.Code)
			}
		})
	}
}

// The portal adds no fallback: an unknown API path or any other unclaimed
// path answers the router's plain 404, never the client's HTML.
func TestPortal_APIUnknownStays404(t *testing.T) {
	h := portalRouter(portalBundle())
	for _, path := range []string{"/api/v1/nope", "/api/v1/health/x", "/index.html", "/app", "/secret.txt", "/service-worker.js"} {
		rec := getPortal(t, h, "", path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
		if strings.Contains(rec.Header().Get("Content-Type"), "html") || strings.Contains(rec.Body.String(), "<div id=root>") {
			t.Errorf("GET %s answered with HTML: %q", path, rec.Body.String())
		}
	}
}
