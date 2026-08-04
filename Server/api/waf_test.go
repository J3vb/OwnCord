package api

import (
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
