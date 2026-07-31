package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/corazawaf/coraza/v3/types"
)

// captureSlog redirects the default slog logger to a buffer for the duration
// of fn and returns everything it wrote (Debug and up).
func captureSlog(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	return buf.String()
}

// matchRecorder captures CRS rule matches reported through the error
// callback, which is how detect-mode (DetectionOnly) matches surface.
type matchRecorder struct {
	mu      sync.Mutex
	ruleIDs []int
}

func (m *matchRecorder) record(mr types.MatchedRule) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ruleIDs = append(m.ruleIDs, mr.Rule().ID())
}

func (m *matchRecorder) matchedInRange(lo, hi int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range m.ruleIDs {
		if id >= lo && id <= hi {
			return true
		}
	}
	return false
}

func (m *matchRecorder) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.ruleIDs)
}

func TestNewCRSWAF_LoadsCoreRuleSet(t *testing.T) {
	for _, block := range []bool{false, true} {
		if _, err := newCRSWAF(2, block, func(types.MatchedRule) {}); err != nil {
			t.Fatalf("newCRSWAF(block=%v): %v", block, err)
		}
	}
}

func TestNormalizeCRSMode(t *testing.T) {
	cases := map[string]string{
		"off":    CRSModeOff,
		"detect": CRSModeDetect,
		"block":  CRSModeBlock,
		"":       CRSModeDetect,
		"bogus":  CRSModeDetect,
		"DETECT": CRSModeDetect, // not an exact known value → detect fallback
	}
	for in, want := range cases {
		if got := normalizeCRSMode(in); got != want {
			t.Errorf("normalizeCRSMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// Detect mode: a classic XSS probe in the query string must be detected by
// the CRS (rule ids 941xxx) but must NOT be blocked — the request reaches the
// downstream handler untouched.
func TestWAFMiddleware_CRSDetectMode_DetectsXSSProbeWithoutBlocking(t *testing.T) {
	rec := &matchRecorder{}
	middleware := newWAFMiddleware(2, CRSModeDetect, rec.record)

	called := false
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=<script>alert(1)</script>", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("detect mode must never block: downstream handler was not called")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if !rec.matchedInRange(941000, 941999) {
		t.Fatalf("expected a CRS XSS rule (941xxx) match, got rule ids %v", rec.ruleIDs)
	}
}

// Detect mode: a path traversal probe is detected (930xxx LFI rules) without
// being blocked by the CRS layer. Note the inline engine's own traversal rule
// (930100) is phase 2 and the inline engine only runs phase 2 when a body is
// present, so a bodyless GET is not blocked by it either — pinned behavior.
func TestWAFMiddleware_CRSDetectMode_DetectsPathTraversalProbe(t *testing.T) {
	rec := &matchRecorder{}
	middleware := newWAFMiddleware(2, CRSModeDetect, rec.record)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/files?name=..%2f..%2f..%2fetc%2fpasswd", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if !rec.matchedInRange(930000, 930999) {
		t.Fatalf("expected a CRS LFI rule (930xxx) match, got rule ids %v", rec.ruleIDs)
	}
}

// The default detect-mode path (no caller-supplied callback) must not log one
// line per matched CRS rule on the request goroutine. An XSS probe trips
// several 941xxx rules plus anomaly scoring; the middleware must collapse them
// into a single aggregated Warn and never emit the per-rule "CRS rule matched"
// line. Only the request itself is wrapped in the log capture so the one-time
// "WAF enabled" startup log doesn't count.
func TestWAFMiddleware_CRSDetectMode_AggregatesMatchLoggingPerRequest(t *testing.T) {
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=<script>alert(1)</script>", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()

	out := captureSlog(t, func() {
		handler.ServeHTTP(rr, req)
	})

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	// Exactly one aggregated match line for the request...
	if n := strings.Count(out, "waf: CRS detect-mode matches"); n != 1 {
		t.Fatalf("want exactly 1 aggregated CRS match log, got %d\nlogs:\n%s", n, out)
	}
	// ...carrying the retained signal (count + highest-severity rule id)...
	if !strings.Contains(out, "matches=") || !strings.Contains(out, "top_rule_id=") {
		t.Fatalf("aggregated log missing count/top_rule_id signal:\n%s", out)
	}
	// ...and the per-rule hot-path logger must not fire in this default path.
	if strings.Contains(out, "waf: CRS rule matched") {
		t.Fatalf("per-rule CRS logging must not fire in default detect mode:\n%s", out)
	}
}

// A caller-supplied callback (as tests use) keeps the per-rule callback wired
// and turns aggregation off, so every match stays observable. This pins that
// the aggregation change did not disturb the callback seam.
func TestWAFMiddleware_CRSDetectMode_CustomCallbackStillPerRule(t *testing.T) {
	rec := &matchRecorder{}
	middleware := newWAFMiddleware(2, CRSModeDetect, rec.record)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=<script>alert(1)</script>", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()

	out := captureSlog(t, func() {
		handler.ServeHTTP(rr, req)
	})

	if !rec.matchedInRange(941000, 941999) {
		t.Fatalf("custom callback must still see per-rule matches, got %v", rec.ruleIDs)
	}
	// With a custom callback wired, the default aggregation path is off.
	if strings.Contains(out, "waf: CRS detect-mode matches") {
		t.Fatalf("aggregation must be off when a callback is supplied:\n%s", out)
	}
}

// A benign chat message containing SQL-ish prose in a JSON body must pass in
// detect mode and remain readable downstream (chat traffic is exactly what
// the detect-mode default protects from CRS false positives).
func TestWAFMiddleware_CRSDetectMode_AllowsBenignSQLishChatMessage(t *testing.T) {
	const requestBody = `{"content":"you can just select the option from the users menu where it says settings"}`
	rec := &matchRecorder{}
	middleware := newWAFMiddleware(2, CRSModeDetect, rec.record)

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(body) != requestBody {
			t.Fatalf("body = %q, want %q", string(body), requestBody)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/messages", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OwnCordClient/1.0")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

// Block mode: the CRS anomaly-scoring evaluation must interrupt a clear
// attack probe.
func TestWAFMiddleware_CRSBlockMode_BlocksXSSProbe(t *testing.T) {
	middleware := NewWAFMiddlewareCRS(2, CRSModeBlock)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("downstream handler should not be called for blocked CRS request")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=<script>alert(1)</script>", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
	if strings.TrimSpace(rr.Body.String()) != `{"error":"request blocked by security rules"}` {
		t.Fatalf("body = %q, want blocked JSON", rr.Body.String())
	}
}

// Block mode lets an ordinary benign JSON request through.
func TestWAFMiddleware_CRSBlockMode_AllowsBenignJSONRequest(t *testing.T) {
	const requestBody = `{"status":"hello there, having a great day"}`
	middleware := NewWAFMiddlewareCRS(2, CRSModeBlock)

	called := false
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/users/me", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OwnCordClient/1.0")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("expected downstream handler to be called")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

// Pins the reason the CRS layer defaults to detect rather than block: CRS
// SQLi rules (942200/942260/942480 at the default threshold) false-positive
// on benign SQL-ish chat prose in a JSON body and block mode rejects it.
// Operators enabling block mode are expected to tune exclusions against
// their real traffic first (detect-mode logs show exactly which rules fire).
// If this test ever starts failing because the request is no longer blocked,
// a CRS update fixed the false positive — reconsider the default then.
func TestWAFMiddleware_CRSBlockMode_FalsePositivesOnSQLishChatProse(t *testing.T) {
	const requestBody = `{"content":"you can just select the option from the users menu where it says settings"}`
	middleware := NewWAFMiddlewareCRS(2, CRSModeBlock)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("downstream handler should not be called: CRS block mode is expected to FP on this prose")
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/messages", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OwnCordClient/1.0")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (documented CRS false positive); body = %s", rr.Code, rr.Body.String())
	}
}

// Off mode: the CRS layer is not evaluated at all (no matches recorded), and
// requests the inline rules allow still pass.
func TestWAFMiddleware_CRSOffMode_SkipsCRSEntirely(t *testing.T) {
	rec := &matchRecorder{}
	middleware := newWAFMiddleware(2, CRSModeOff, rec.record)

	called := false
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=<script>alert(1)</script>", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("expected downstream handler to be called")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rr.Code)
	}
	if rec.count() != 0 {
		t.Fatalf("CRS must not run in off mode, got %d matches: %v", rec.count(), rec.ruleIDs)
	}
}

// The inline engine keeps blocking regardless of CRS mode (its behavior is
// pinned by waf_test.go; this pins it per-mode).
func TestWAFMiddleware_InlineRulesStillBlockInEveryCRSMode(t *testing.T) {
	for _, mode := range []string{CRSModeOff, CRSModeDetect, CRSModeBlock} {
		t.Run(mode, func(t *testing.T) {
			middleware := NewWAFMiddlewareCRS(2, mode)
			handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Fatal("downstream handler should not be called for blocked scanner request")
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
			req.Header.Set("User-Agent", "sqlmap/1.8")
			req.RemoteAddr = "127.0.0.1:9999"
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body = %s", rr.Code, rr.Body.String())
			}
		})
	}
}

// Upload requests keep their original body stream in every mode: both engines
// turn requestBodyAccess off for /api/v1/uploads, and the middleware must not
// swap the body for an (empty) buffered reader.
func TestWAFMiddleware_UploadBodyNotBufferedOrEmptied(t *testing.T) {
	const requestBody = "binary-ish upload payload \x00\x01\x02"
	for _, mode := range []string{CRSModeOff, CRSModeDetect, CRSModeBlock} {
		t.Run(mode, func(t *testing.T) {
			middleware := NewWAFMiddlewareCRS(2, mode)
			handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatalf("ReadAll: %v", err)
				}
				if string(body) != requestBody {
					t.Fatalf("body = %q, want %q", string(body), requestBody)
				}
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", strings.NewReader(requestBody))
			req.Header.Set("Content-Type", "application/octet-stream")
			req.Header.Set("User-Agent", "OwnCordClient/1.0")
			req.RemoteAddr = "127.0.0.1:9999"
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
			}
		})
	}
}
