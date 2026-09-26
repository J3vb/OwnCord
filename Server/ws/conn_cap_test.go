package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestServeWS_ConnectionCap locks the capacity guardrail: at or above the
// configured cap, upgrade requests are refused with 503 before the WebSocket
// handshake, and the rejection is counted.
func TestServeWS_ConnectionCap(t *testing.T) {
	h := &Hub{clients: map[int64]*Client{1: {}, 2: {}}}
	handler := ServeWS(h, nil, 2)

	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status at cap = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("503 response missing Retry-After header")
	}
	if got := h.ConnRejectCount(); got != 1 {
		t.Errorf("ConnRejectCount = %d, want 1", got)
	}

	// Below the cap the request proceeds to the upgrade (which fails without
	// WebSocket headers — but NOT with the capacity 503).
	h2 := &Hub{clients: map[int64]*Client{1: {}}}
	rec2 := httptest.NewRecorder()
	ServeWS(h2, nil, 2)(rec2, httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil))
	if rec2.Code == http.StatusServiceUnavailable {
		t.Fatalf("below-cap request was refused with 503")
	}
	if got := h2.ConnRejectCount(); got != 0 {
		t.Errorf("below-cap ConnRejectCount = %d, want 0", got)
	}

	// Cap 0 = unlimited: never the capacity 503.
	rec3 := httptest.NewRecorder()
	ServeWS(h, nil, 0)(rec3, httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil))
	if rec3.Code == http.StatusServiceUnavailable {
		t.Fatalf("cap=0 request was refused with 503")
	}
}
