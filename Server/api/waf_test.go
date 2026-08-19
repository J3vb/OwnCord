package api

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/corazawaf/coraza/v3/types"
)

func TestHandleWAFInterruption_WritesJSONAndStatus(t *testing.T) {
	rr := httptest.NewRecorder()
	handleWAFInterruption(rr, &types.Interruption{
		Action: "deny",
		Status: http.StatusForbidden,
		RuleID: 942100,
		Data:   "SQL Injection detected",
	})

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
	if rr.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", rr.Header().Get("Content-Type"))
	}
	if strings.TrimSpace(rr.Body.String()) != `{"error":"request blocked by security rules"}` {
		t.Fatalf("body = %q, want blocked JSON", rr.Body.String())
	}
}

func TestWAFMiddleware_AllowsBenignRequest(t *testing.T) {
	called := false
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=hello", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("expected downstream handler to be called")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rr.Code)
	}
}

func TestWAFMiddleware_InvalidParanoiaLevelStillAllowsBenignRequest(t *testing.T) {
	called := false
	middleware := NewWAFMiddlewareCRS(99, CRSModeDetect)
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels?q=hello", nil)
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("expected downstream handler to be called")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rr.Code)
	}
}

func TestWAFMiddleware_BlocksScannerUserAgent(t *testing.T) {
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)
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
}

// The inline engine's four phase-2 request-body rules must actually block a
// body-borne attack payload, not just log it: SQLi (942100), XSS (941100),
// path traversal (930100) and command injection (932100) are all
// deny,status:403 under an always-on SecRuleEngine. Every other blocking test
// in the suite fires the phase-1 User-Agent rule on a bodyless GET, so this is
// what pins wafInspectRequestBody's interruption path.
//
// CRS mode off is deliberate: with no CRS engine attached the inline engine is
// the only thing that can block, so the asserted rule id proves the inline
// rule fired. Detect mode is included because it is the production default and
// its CRS engine never interrupts (DetectionOnly), so the block must still
// come from the inline engine — block mode is left out precisely because there
// the CRS layer could be the one blocking.
//
// Payloads are form-urlencoded: that is the body form coraza parses into
// ARGS/REQUEST_BODY for this engine (it loads no coraza.conf-recommended, so
// no JSON body processor is selected — see waf_crs_test.go for the CRS layer,
// which does inspect JSON bodies).
func TestWAFMiddleware_BlocksAttackPayloadInRequestBody(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		ruleID int
	}{
		{"sqli", `q=1%27%20OR%20%271%27%3D%271%20--%20`, 942100},
		{"xss", `q=%3Cscript%3Ealert%281%29%3C%2Fscript%3E`, 941100},
		{"path_traversal", `q=..%2F..%2Fetc%2Fpasswd`, 930100},
		{"command_injection", `q=hello%20%7C%20id`, 932100},
	}

	for _, mode := range []string{CRSModeOff, CRSModeDetect} {
		middleware := NewWAFMiddlewareCRS(2, mode)
		for _, tc := range cases {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					t.Errorf("downstream handler must not be called for a %s request body", tc.name)
					w.WriteHeader(http.StatusNoContent)
				}))

				req := httptest.NewRequest(http.MethodPost, "/api/v1/messages", strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
				req.Header.Set("User-Agent", "OwnCordClient/1.0")
				req.RemoteAddr = "127.0.0.1:9999"
				rr := httptest.NewRecorder()

				out := captureSlog(t, func() { handler.ServeHTTP(rr, req) })

				if rr.Code != http.StatusForbidden {
					t.Fatalf("status = %d, want 403; body = %s", rr.Code, rr.Body.String())
				}
				if strings.TrimSpace(rr.Body.String()) != `{"error":"request blocked by security rules"}` {
					t.Fatalf("body = %q, want blocked JSON", rr.Body.String())
				}
				if want := fmt.Sprintf("rule_id=%d", tc.ruleID); !strings.Contains(out, want) {
					t.Fatalf("blocked by the wrong rule: want %s in\n%s", want, out)
				}
			})
		}
	}
}

// Routes exempted from the app's global 1 MiB body cap (bodyCapExemptPrefixes
// in constants.go) must also be exempted from the inline WAF engine's own
// SecRequestBodyLimit, or coraza's default SecRequestBodyLimitAction (Reject)
// 413s the request as soon as its buffer hits 1 MiB — well below these
// routes' documented, larger caps.
func TestWAFMiddleware_AllowsLargePluginInstallBody(t *testing.T) {
	requestBody := strings.Repeat("A", 2*1024*1024) // 2 MiB; within the 16 MiB plugin-install cap
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)

	called := false
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if len(body) != len(requestBody) {
			t.Fatalf("body len = %d, want %d", len(body), len(requestBody))
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/plugins/install", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "application/zip")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatalf("expected downstream handler to be called, got status %d body %s", rr.Code, rr.Body.String())
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestWAFMiddleware_AllowsLargeAvatarUploadBody(t *testing.T) {
	requestBody := strings.Repeat("A", 1_100_000) // >1 MiB; within the 2 MiB avatar cap
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)

	called := false
	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if len(body) != len(requestBody) {
			t.Fatalf("body len = %d, want %d", len(body), len(requestBody))
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", strings.NewReader(requestBody))
	req.Header.Set("Content-Type", "image/png")
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatalf("expected downstream handler to be called, got status %d body %s", rr.Code, rr.Body.String())
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestWAFMiddleware_PreservesReadableBodyForDownstream(t *testing.T) {
	const requestBody = `{"message":"hello world"}`
	middleware := NewWAFMiddlewareCRS(2, CRSModeDetect)
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
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}
