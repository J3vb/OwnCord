package admin_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
)

// TestSetup_HonoursTrustedProxies pins OC-0274: first-run setup must resolve
// the client IP the same way every other session-creating path does — via
// the configured trusted_proxies, not the raw RemoteAddr. Deployed behind a
// reverse proxy (as docs/deployment.md prescribes), RemoteAddr is always the
// proxy's own loopback address; the real client only shows up in
// X-Forwarded-For, and only once the proxy hop itself is trusted.
//
// Two symptoms share the same root cause (setupPrecheck's single `host`
// value feeds both the session IP and the rate-limit bucket key):
//  1. The Owner's first session is recorded with the proxy's IP instead of
//     their own, unlike every other login/register session.
//  2. The 5-per-minute setup limiter buckets every caller behind the proxy
//     under one key, so one abusive client can 429 everyone else's setup
//     attempt.
func TestSetup_HonoursTrustedProxies(t *testing.T) {
	const trustedProxyAddr = "192.0.2.1"
	const realClientIP = "203.0.113.9"

	database := openAdminTestDB(t)
	cfg := &config.Config{}
	cfg.Server.TrustedProxies = []string{trustedProxyAddr + "/32"}

	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil,
		newTestModService(database), newTestRoleService(database), newTestSettingsService(database),
		admin.SetupOptions{RunningCfg: cfg})

	body, err := json.Marshal(map[string]string{
		"username": "owner1",
		"password": "SecurePass123!",
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/setup", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = trustedProxyAddr + ":5555"
	req.Header.Set("X-Forwarded-For", realClientIP)

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("POST /setup = %d, want 201; body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		UserID int64 `json:"user_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	sessions, err := database.ListUserSessions(req.Context(), resp.UserID)
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("len(sessions) = %d, want 1", len(sessions))
	}
	if sessions[0].IP != realClientIP {
		t.Errorf("session IP = %q, want %q (the real client behind the trusted proxy) — "+
			"setup recorded the proxy's own address instead (OC-0274)", sessions[0].IP, realClientIP)
	}

	// Symptom 2: the rate limiter must key on the real client, not the
	// shared trusted-proxy hop. Burn the 5/minute budget from one real
	// client (all requests arrive from the same trusted proxy, so only
	// X-Forwarded-For distinguishes them) and confirm a second, distinct
	// real client behind the same proxy is unaffected.
	for i := range 5 {
		req := httptest.NewRequest(http.MethodPost, "/setup", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = trustedProxyAddr + ":5555"
		req.Header.Set("X-Forwarded-For", "203.0.113.50")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d from 203.0.113.50 was rate-limited early; setup: %d, body=%s", i, w.Code, w.Body.String())
		}
	}

	req2 := httptest.NewRequest(http.MethodPost, "/setup", bytes.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	req2.RemoteAddr = trustedProxyAddr + ":6666"
	req2.Header.Set("X-Forwarded-For", "203.0.113.51")
	w2 := httptest.NewRecorder()
	handler.ServeHTTP(w2, req2)

	if w2.Code == http.StatusTooManyRequests {
		t.Errorf("a distinct real client (203.0.113.51) behind the same trusted proxy was rate-limited "+
			"by another client's (203.0.113.50) attempts — the limiter is keying on the proxy's address "+
			"instead of the real client (OC-0274); got %d, body=%s", w2.Code, w2.Body.String())
	}
}
