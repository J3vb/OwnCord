package ws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// assertJSONError checks an error reply is the standard JSON envelope with
// the given code (MX-7 part 3: no ws HTTP reply is plain text).
func assertJSONError(t *testing.T, h http.Header, body []byte, code string) {
	t.Helper()
	if ct := h.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var env struct{ Error, Message string }
	if err := json.Unmarshal(body, &env); err != nil || env.Error != code || env.Message == "" {
		t.Errorf("body = %s (%v), want the %s envelope", body, err, code)
	}
}

func TestWebhookHandler_RefusalIsJSON(t *testing.T) {
	handler := NewHubForTest().NewLiveKitWebhookHandler("api-key", "api-secret")
	for name, auth := range map[string]string{"no header": "", "bad token": "Bearer not-a-jwt"} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/livekit/webhook", strings.NewReader(`{}`))
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			rec := httptest.NewRecorder()
			handler(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			assertJSONError(t, rec.Header(), rec.Body.Bytes(), "UNAUTHORIZED")
		})
	}
}
