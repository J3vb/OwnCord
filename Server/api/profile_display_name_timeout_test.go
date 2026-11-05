package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestUpdateProfile_DisplayNameWhileTimedOutIs403(t *testing.T) {
	database := newAuthTestDB(t)
	router := buildProfileRouter(database)
	token := profileCreateToken(t, database, "timedout", 4)
	u, err := database.GetUserByUsername(context.Background(), "timedout")
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername: %v, %v", u, err)
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO moderation_actions (kind, target_id, actor_id, reason, expires_at) VALUES ('timeout', ?, 0, 'cool off', ?)`,
		u.ID, time.Now().Add(time.Hour).UTC().Format("2006-01-02 15:04:05")); err != nil {
		t.Fatalf("insert timeout: %v", err)
	}

	rr := patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "timedout", "display_name": "Mine"})
	requireStatus(t, rr, http.StatusForbidden)
	resp := decodeBody[map[string]any](t, rr)
	if resp["error"] != "TIMED_OUT" {
		t.Errorf("error = %v, want TIMED_OUT; body = %v", resp["error"], resp)
	}

	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "timedout", "about": "still fine"})
	expectStatus(t, rr, http.StatusOK)

	// The client's save shape: every field resent, only about changed.
	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "timedout", "display_name": "", "about": "again"})
	expectStatus(t, rr, http.StatusOK)

	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "renamed"})
	expectStatus(t, rr, http.StatusForbidden)
}
