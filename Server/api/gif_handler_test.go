package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

// buildGIFRouter mounts the GIF proxy with the given upstream API key.
func buildGIFRouter(database *db.DB, apiKey string) http.Handler {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	cfg := &config.Config{}
	cfg.GIF.APIKey = apiKey
	api.MountGIFRoutes(r, service.NewSessionService(database), limiter, cfg)
	return r
}

// stubKlipy starts a fake upstream and points the GIF proxy at it. The
// returned recorder captures the query of the last upstream request.
func stubKlipy(t *testing.T, body string, status int) *lastRequest {
	t.Helper()
	rec := &lastRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.path = r.URL.Path
		rec.query = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	// The production policy refuses loopback and plain http, which is what
	// httptest binds to; the helper relaxes exactly those two and keeps every
	// ceiling as production has them.
	restore, err := api.SetGIFUpstreamForTest(srv.URL)
	if err != nil {
		t.Fatalf("SetGIFUpstreamForTest: %v", err)
	}
	t.Cleanup(restore)
	return rec
}

type lastRequest struct {
	path  string
	query map[string][]string
}

func (l *lastRequest) get(key string) string {
	if v := l.query[key]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// gifGET issues an authenticated GET against the GIF router.
func gifGET(t *testing.T, router http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

const gifUpstreamBody = `{"results":[
	{"id":"a","title":"Cat","media_formats":{"tinygif":{"url":"https://media.klipy.com/a_tiny.gif"},"gif":{"url":"https://media.klipy.com/a.gif"}},"secret_echo":"leak"},
	{"id":"b","title":"NoTiny","media_formats":{"gif":{"url":"https://media.klipy.com/b.gif"}}}
]}`

func decodeGIFResults(t *testing.T, rr *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var body struct {
		Results []map[string]any `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rr.Body.String())
	}
	return body.Results
}

func decodeGIFError(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v (body=%s)", err, rr.Body.String())
	}
	return body.Error
}

// ─── Key configured: proxies upstream ────────────────────────────────────────

func TestGIFSearchProxiesUpstream(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	up := stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats&limit=5", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}

	if up.path != "/search" {
		t.Errorf("upstream path = %q, want /search", up.path)
	}
	if got := up.get("q"); got != "cats" {
		t.Errorf("upstream q = %q, want cats", got)
	}
	if got := up.get("limit"); got != "5" {
		t.Errorf("upstream limit = %q, want 5", got)
	}
	if got := up.get("key"); got != "server-side-key" {
		t.Errorf("upstream key = %q, want the server-held key", got)
	}

	results := decodeGIFResults(t, rr)
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1 (entries missing a format are dropped)", len(results))
	}
	if results[0]["id"] != "a" {
		t.Errorf("result id = %v, want a", results[0]["id"])
	}
}

func TestGIFTrendingProxiesUpstream(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	up := stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/trending", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	if up.path != "/featured" {
		t.Errorf("upstream path = %q, want /featured", up.path)
	}
	if up.get("q") != "" {
		t.Errorf("trending must not send q, got %q", up.get("q"))
	}
	if got := up.get("limit"); got != "20" {
		t.Errorf("default limit = %q, want 20", got)
	}
}

// The API key must never reach the client, directly or via an upstream echo.
func TestGIFResponseNeverLeaksAPIKey(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `{"results":[{"id":"a","title":"t","key":"server-side-key","media_formats":{"tinygif":{"url":"https://media.klipy.com/a_tiny.gif"},"gif":{"url":"https://media.klipy.com/a.gif"}}}],"echoed_key":"server-side-key"}`, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "server-side-key") {
		t.Fatalf("response leaked the API key: %s", rr.Body.String())
	}
}

// A result URL forwarded to the client must be well-formed https with a host
// and no embedded credentials — the client loads these directly, unproxied.
// One good result and three malformed ones: http scheme, a javascript: URL,
// and embedded userinfo. Only the good one must survive.
func TestGIFResultURLsAreHTTPSWithoutCredentials(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `{"results":[
		{"id":"good","media_formats":{"tinygif":{"url":"https://media.klipy.com/good_tiny.gif"},"gif":{"url":"https://media.klipy.com/good.gif"}}},
		{"id":"http","media_formats":{"tinygif":{"url":"http://media.klipy.com/bad_tiny.gif"},"gif":{"url":"https://media.klipy.com/bad.gif"}}},
		{"id":"js","media_formats":{"tinygif":{"url":"https://media.klipy.com/js_tiny.gif"},"gif":{"url":"javascript:alert(1)"}}},
		{"id":"cred","media_formats":{"tinygif":{"url":"https://user:pw@media.klipy.com/cred_tiny.gif"},"gif":{"url":"https://media.klipy.com/cred.gif"}}}
	]}`, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}

	results := decodeGIFResults(t, rr)
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1 (only the well-formed https result): %v", len(results), results)
	}
	if results[0]["id"] != "good" {
		t.Errorf("result id = %v, want good", results[0]["id"])
	}
}

// ─── Default-off contract ────────────────────────────────────────────────────

func TestGIFDisabledWhenNoKeyConfigured(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	router := buildGIFRouter(database, "")

	for _, path := range []string{"/api/v1/gif/search?q=cats", "/api/v1/gif/trending"} {
		rr := gifGET(t, router, path, token)
		if rr.Code != http.StatusServiceUnavailable {
			t.Errorf("%s status = %d, want 503", path, rr.Code)
		}
		if code := decodeGIFError(t, rr); code != "GIF_DISABLED" {
			t.Errorf("%s error code = %q, want GIF_DISABLED", path, code)
		}
	}
}

// A disabled server must not make an outbound call at all.
func TestGIFDisabledMakesNoUpstreamCall(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	up := stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "")

	gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if up.path != "" {
		t.Errorf("upstream was called (%q) despite the feature being disabled", up.path)
	}
}

// ─── Auth ────────────────────────────────────────────────────────────────────

func TestGIFRequiresAuth(t *testing.T) {
	database := newAuthTestDB(t)
	stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	for _, path := range []string{"/api/v1/gif/search?q=cats", "/api/v1/gif/trending"} {
		rr := gifGET(t, router, path, "")
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s without a token: status = %d, want 401", path, rr.Code)
		}
	}
}

func TestGIFRejectsInvalidToken(t *testing.T) {
	database := newAuthTestDB(t)
	stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", "not-a-real-token")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

// Auth is checked before the disabled check, so an anonymous caller cannot
// probe whether the operator configured a GIF key.
func TestGIFAuthCheckedBeforeDisabledCheck(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildGIFRouter(database, "")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", "")
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (not 503)", rr.Code)
	}
}

// ─── Input validation ────────────────────────────────────────────────────────

func TestGIFSearchValidatesInput(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, gifUpstreamBody, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	tests := []struct {
		name string
		path string
	}{
		{"missing q", "/api/v1/gif/search"},
		{"blank q", "/api/v1/gif/search?q=%20%20"},
		{"q too long", "/api/v1/gif/search?q=" + strings.Repeat("a", 101)},
		{"limit not a number", "/api/v1/gif/search?q=cats&limit=abc"},
		{"limit zero", "/api/v1/gif/search?q=cats&limit=0"},
		{"limit over max", "/api/v1/gif/search?q=cats&limit=51"},
		{"limit negative", "/api/v1/gif/search?q=cats&limit=-1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := gifGET(t, router, tt.path, token)
			if rr.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body=%s)", rr.Code, rr.Body.String())
			}
		})
	}
}

// ─── Upstream failure ────────────────────────────────────────────────────────

func TestGIFUpstreamErrorBecomesBadGateway(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `{"error":"quota exceeded for key server-side-key"}`, http.StatusPaymentRequired)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "quota exceeded") {
		t.Errorf("upstream error body was passed through to the client: %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "server-side-key") {
		t.Errorf("response leaked the API key: %s", rr.Body.String())
	}
}

func TestGIFMalformedUpstreamBecomesBadGateway(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `<html>not json</html>`, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rr.Code)
	}
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

func TestGIFRateLimited(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `{"results":[]}`, http.StatusOK)
	router := buildGIFRouter(database, "server-side-key")

	// The limiter allows 30/minute per IP; the 31st must be refused.
	for i := range 30 {
		rr := gifGET(t, router, "/api/v1/gif/trending", token)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200", i+1, rr.Code)
		}
	}
	rr := gifGET(t, router, "/api/v1/gif/trending", token)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("request 31: status = %d, want 429", rr.Code)
	}
	if code := decodeGIFError(t, rr); code != "RATE_LIMITED" {
		t.Errorf("error code = %q, want RATE_LIMITED", code)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Error("429 response is missing the Retry-After header")
	}
}

// The GIF bucket must be separate from the shared empty-prefix bucket, so a
// user hammering the picker cannot rate-limit their own password change.
func TestGIFRateLimitBucketIsSeparate(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipy(t, `{"results":[]}`, http.StatusOK)

	limiter := auth.NewRateLimiter()
	r := chi.NewRouter()
	cfg := &config.Config{}
	cfg.GIF.APIKey = "server-side-key"
	api.MountGIFRoutes(r, service.NewSessionService(database), limiter, cfg)

	for range 31 {
		gifGET(t, r, "/api/v1/gif/trending", token)
	}
	// The shared (empty-prefix) bucket used by sensitive endpoints must be
	// untouched by the GIF traffic above.
	if !limiter.Allow("127.0.0.1", 5, time.Minute) {
		t.Error("GIF traffic consumed the shared rate-limit bucket")
	}
}

// ─── The bounded boundary is actually in the path (B5-1) ─────────────────────

// stubKlipyHandler is stubKlipy for a case that needs to control the upstream
// response itself rather than just its body and status.
func stubKlipyHandler(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	restore, err := api.SetGIFUpstreamForTest(srv.URL)
	if err != nil {
		t.Fatalf("SetGIFUpstreamForTest: %v", err)
	}
	t.Cleanup(restore)
}

// An upstream that streams far past the ceiling is a 502, not an OOM: the
// GIF proxy's Fetcher carries the byte limit, so this proves the adoption and
// not only the package.
func TestGIFOversizedUpstreamBecomesBadGateway(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	var written atomic.Int64
	stubKlipyHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		chunk := bytes.Repeat([]byte("A"), 64<<10)
		for written.Load() < 64<<20 {
			n, err := w.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				return
			}
		}
	})
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if got := decodeGIFError(t, rr); got != "BAD_GATEWAY" {
		t.Errorf("error = %q, want BAD_GATEWAY", got)
	}
	// The ceiling is 2 MiB; some slack for socket buffers, nothing like 64 MiB.
	if got := written.Load(); got > 16<<20 {
		t.Fatalf("upstream wrote %d bytes — the body was buffered before the ceiling applied", got)
	}
}

// An upstream that answers HTML while claiming JSON is refused before the
// decoder sees it.
func TestGIFWrongContentTypeBecomesBadGateway(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	stubKlipyHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("<!DOCTYPE html><html><body>captive portal</body></html>"))
	})
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body=%s)", rr.Code, rr.Body.String())
	}
}

// A redirect is not followed at all: the upstream host is a constant, so a
// 302 is either a provider change or somebody moving the destination.
func TestGIFUpstreamRedirectIsRefused(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	var hits atomic.Int64
	stubKlipyHandler(t, func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			http.Redirect(w, r, "/moved", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gifUpstreamBody))
	})
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream saw %d requests, want exactly 1 — the redirect must not be followed", got)
	}
}

// The production Fetcher, not the test one, refuses the loopback stub: the
// address policy is on by default and the test helper is the only thing that
// relaxes it.
func TestGIFProductionPolicyRefusesLoopback(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the production policy must not reach a loopback upstream")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gifUpstreamBody))
	}))
	t.Cleanup(srv.Close)
	// Point only the base URL at the stub; the Fetcher stays the production one.
	restore := api.SetGIFBaseURLForTest(srv.URL)
	t.Cleanup(restore)
	router := buildGIFRouter(database, "server-side-key")

	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
}

// An upstream host that does not resolve — the server has no network route to
// it, or the operator misconfigured the base URL — must answer 502 quickly
// and generically: no upstream host, no "no such host", and no API key in the
// body. The production Fetcher (real DNS resolution) is used, only the base
// URL is swapped, matching TestGIFProductionPolicyRefusesLoopback's shape.
func TestGIFOfflineUpstreamIsBadGatewayWithoutLeak(t *testing.T) {
	database := newAuthTestDB(t)
	token := profileCreateToken(t, database, "gifuser", 4)
	restore := api.SetGIFBaseURLForTest("https://gif-upstream.invalid")
	t.Cleanup(restore)
	router := buildGIFRouter(database, "server-side-key")

	start := time.Now()
	rr := gifGET(t, router, "/api/v1/gif/search?q=cats", token)
	elapsed := time.Since(start)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body=%s)", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if strings.Contains(body, "gif-upstream.invalid") {
		t.Errorf("response leaked the upstream host: %s", body)
	}
	if strings.Contains(body, "no such host") {
		t.Errorf("response leaked the resolver error: %s", body)
	}
	if strings.Contains(body, "server-side-key") {
		t.Errorf("response leaked the API key: %s", body)
	}
	if elapsed >= 5*time.Second {
		t.Errorf("offline resolve took %v, want well under the 5s bound (well inside the 10s deadline)", elapsed)
	}
}
