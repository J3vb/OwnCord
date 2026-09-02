package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// BPR-042: every message, file, call and moderation route requires an
// authenticated account, and anonymous guest access does not exist. The
// tests in this file are the proof at the route boundary (B4-2): the walk
// below sends an anonymous request to every route the production router
// mounts and requires the uniform 401 the auth gates answer with — unless
// the route is on the public surface declared here, each with its reason.
//
// publicSurface is an allowlist in the DBImportAllow sense: it can only
// shrink. Adding a route to it is a product decision that changes the BPR-042
// proof and needs docs/trust-model.md updated first; a route that leaves the
// tree must leave this map too (the walk fails on a stale entry). Keys are
// "METHOD /pattern" as chi.Walk reports them, or "* /prefix/*" for a mounted
// handler that answers every method. Only routes the default build mounts
// belong here — /metrics/* exists only under -tags otel and is perimeter-gated
// like /api/v1/metrics.
var publicSurface = map[string]string{
	"GET /health":        "liveness probe; unauthenticated by design and answers status/uptime only (TestHealthEndpoint*)",
	"GET /api/v1/health": "the same probe under the versioned prefix",
	"GET /api/v1/info":   "server name and protocol epoch for the client's handshake (B2-2); no user data",

	"POST /api/v1/auth/login":       "the credential entry point; rate-limited and lockout-guarded (TestLogin_*)",
	"POST /api/v1/auth/register":    "the invite-gated account entry point (TestRegister_*); registration_mode is B4-1's",
	"POST /api/v1/auth/verify-totp": "second step of login; consumes a partial-auth token in-band (TestVerifyTOTP_*)",
	"POST /api/v1/auth/recover":     "account recovery with the locally held kit (B4-5); uniform 401s, rate-limited and lockout-guarded like login (TestRecoveryKit_*)",

	"GET /api/v1/client-update/{target}/{current_version}": "the desktop updater's manifest; unauthenticated, per-IP rate-limited, signature checked client-side",

	"GET /api/v1/ws": "in-band handshake authentication: the first frame carries the token and an anonymous socket is closed — TestEpoch1Fixtures/auth-failure pins the close",

	"* /admin/*":                  "the admin panel's static files and login page, behind AdminIPRestrict (admin_allowed_cidrs, private networks by default; open in this test config); every /admin/api route beneath is RequireAdminAuth-gated and walked here",
	"GET /admin/":                 "the admin panel's index, same perimeter as /admin/*",
	"POST /admin/api/setup":       "first-run bootstrap: creates the owner on an empty server and answers 403 once one exists (Server/admin/setup_handler.go, TestSetup*)",
	"GET /admin/api/setup/status": "whether first-run setup is still open; no user data",

	"GET /api/v1/metrics":          "operational counters for a scraper, behind AdminIPRestrict (metrics_allowed_cidrs); no per-user data",
	"GET /api/v1/livekit/health":   "LiveKit reachability, behind the webhook perimeter (livekit_webhook_allowed_cidrs)",
	"POST /api/v1/livekit/webhook": "LiveKit's webhook; authenticated in-band by the LiveKit JWT signature, plus the same perimeter",
	"* /livekit/*":                 "the LiveKit signalling proxy; authenticated in-band by the LiveKit access token the SFU validates, rate-limited (see router.go)",
}

// optionalPublicSurface holds public routes that exist only under a build
// tag or a configuration, so the walk accepts them when present without the
// shrink-only check demanding them: CI runs this package under -tags otel
// (ci.yml), where a configured Prometheus exporter mounts /metrics/* behind
// the same perimeter as /api/v1/metrics.
var optionalPublicSurface = map[string]string{
	"* /metrics/*": "the OpenTelemetry Prometheus exporter (otel build with exporter = prometheus), behind AdminIPRestrict (metrics_allowed_cidrs)",
}

// pathParam substitutes a chi path parameter with a value shaped like the
// real thing so the request reaches the route's middleware chain rather than
// a parser's 400.
var pathParam = map[string]string{
	"code":            "abcdef",
	"emoji":           "x",
	"name":            "x.db",
	"target":          "linux-x64",
	"current_version": "1.0.0",
}

var paramPattern = regexp.MustCompile(`\{([^}]+)\}`)

// concretePath turns a chi pattern into a requestable path.
func concretePath(pattern string) string {
	p := paramPattern.ReplaceAllStringFunc(pattern, func(m string) string {
		name := strings.Trim(m, "{}")
		if v, ok := pathParam[name]; ok {
			return v
		}
		return "1"
	})
	return strings.ReplaceAll(p, "*", "x")
}

// postureKey is the allowlist key for a walked route: a mounted handler that
// answers every method collapses to "* /prefix/*".
func postureKey(method, pattern string) string {
	if strings.HasSuffix(pattern, "/*") {
		return "* " + pattern
	}
	return method + " " + pattern
}

type postureViolation struct {
	Key    string
	Status int
	Body   string
}

// walkAnonymousPosture sends an anonymous request to every route in h and
// returns the allowlist keys it saw and the routes that did not answer the
// uniform 401. It is the checker TestAuthPosture_NegativeControl proves can
// fail.
func walkAnonymousPosture(t *testing.T, h http.Handler) (total int, seen map[string]bool, violations []postureViolation) {
	t.Helper()
	routes, ok := h.(chi.Routes)
	if !ok {
		t.Fatalf("router is %T, want a chi.Routes so the mounted tree can be walked", h)
	}
	seen = map[string]bool{}
	checked := map[string]bool{}
	walk := func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		total++
		key := postureKey(method, pattern)
		if _, public := publicSurface[key]; public {
			seen[key] = true
			return nil
		}
		if _, optional := optionalPublicSurface[key]; optional {
			return nil
		}
		if checked[key] {
			return nil
		}
		checked[key] = true

		req := httptest.NewRequest(method, concretePath(pattern), nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		var body struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusUnauthorized || body.Error != "UNAUTHORIZED" {
			violations = append(violations, postureViolation{Key: key, Status: rec.Code, Body: strings.TrimSpace(rec.Body.String())})
		}
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	sort.Slice(violations, func(i, j int) bool { return violations[i].Key < violations[j].Key })
	return total, seen, violations
}

// TestAuthPosture_EveryRouteOffThePublicSurfaceAnswers401 is the BPR-042
// route proof: an anonymous request to any route not declared public is
// refused with the auth gates' uniform 401 UNAUTHORIZED — never a 200, never
// a 404 that would say whether the resource exists, never a 400 from a body
// parser that ran ahead of authentication.
func TestAuthPosture_EveryRouteOffThePublicSurfaceAnswers401(t *testing.T) {
	handler := fullRouter(t)
	total, seen, violations := walkAnonymousPosture(t, handler)

	// The walk must have seen the real tree (the B2 absence contract's
	// guard), and the public surface must have been exercised, not skipped
	// wholesale.
	if total < 100 {
		t.Fatalf("walked only %d routes; expected the full production router (>= 100)", total)
	}
	if len(seen) < 10 {
		t.Fatalf("matched only %d public-surface entries; expected the declared surface (>= 10)", len(seen))
	}

	if len(violations) > 0 {
		lines := make([]string, 0, len(violations))
		for _, v := range violations {
			lines = append(lines, fmt.Sprintf("%s → %d %s", v.Key, v.Status, v.Body))
		}
		t.Fatalf("%d route(s) answered an anonymous request with something other than 401 UNAUTHORIZED; either the route is missing its auth gate, or it is a deliberate public route that belongs in publicSurface with a reason (and in docs/trust-model.md):\n  %s",
			len(violations), strings.Join(lines, "\n  "))
	}

	// The allowlist only shrinks: an entry the walk did not see names a
	// route that no longer exists (or moved), so drop it.
	var stale []string
	for key := range publicSurface {
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	slices.Sort(stale)
	if len(stale) > 0 {
		t.Fatalf("publicSurface entries no longer mounted — remove them:\n  %s", strings.Join(stale, "\n  "))
	}
}

// TestAuthPosture_NegativeControl proves the checker can fail: a probe route
// mounted without an auth gate beside the production tree must be reported,
// and nothing else may be. Without this, a green posture walk would prove
// only that the walk ran.
func TestAuthPosture_NegativeControl(t *testing.T) {
	prod := fullRouter(t)
	r := chi.NewRouter()
	r.Get("/api/v1/zz-posture-probe/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.Mount("/", prod)

	_, _, violations := walkAnonymousPosture(t, r)
	if len(violations) != 1 {
		t.Fatalf("negative control: want exactly the probe reported, got %d violation(s): %+v", len(violations), violations)
	}
	if violations[0].Key != "GET /api/v1/zz-posture-probe/{id}" || violations[0].Status != http.StatusOK {
		t.Fatalf("negative control: reported %+v, want the probe with status 200", violations[0])
	}
}
