package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// TestHandleLogStream_RefusalsAreJSON pins MX-7 part 3: the log stream's
// refusals are the standard JSON envelope sent as application/json, not the
// same JSON sent as text/plain.
func TestHandleLogStream_RefusalsAreJSON(t *testing.T) {
	database := newLogStreamTestDB(t)
	handler := handleLogStream(database, NewRingBuffer(8))

	ticketFor := func(roleID int, withSession bool) string {
		t.Helper()
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		tokenHash := auth.HashToken(token)
		if withSession {
			userID, err := database.CreateUser(context.Background(), "u"+token[:8], "hash", roleID)
			if err != nil {
				t.Fatalf("CreateUser: %v", err)
			}
			if _, err := database.CreateSession(context.Background(), userID, tokenHash, "test", "127.0.0.1"); err != nil {
				t.Fatalf("CreateSession: %v", err)
			}
		}
		ticket, err := logTickets.issue(tokenHash)
		if err != nil {
			t.Fatalf("issue ticket: %v", err)
		}
		return ticket
	}

	cases := []struct {
		name   string
		ticket string
		status int
		code   string
	}{
		{"no ticket", "", http.StatusUnauthorized, "UNAUTHORIZED"},
		{"unknown ticket", "not-a-ticket", http.StatusUnauthorized, "UNAUTHORIZED"},
		{"ticket with no session", ticketFor(4, false), http.StatusUnauthorized, "UNAUTHORIZED"},
		{"member without VIEW_DIAGNOSTICS", ticketFor(4, true), http.StatusForbidden, "FORBIDDEN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler(rec, httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+tc.ticket, nil))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tc.status, rec.Body.String())
			}
			if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}
			var env errorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.Error != tc.code || env.Message == "" {
				t.Errorf("body = %s (%v), want the %s envelope", rec.Body.String(), err, tc.code)
			}
		})
	}
}
