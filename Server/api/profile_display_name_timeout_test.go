package api_test

import (
	"context"
	"encoding/json"
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
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["error"] != "TIMED_OUT" {
		t.Errorf("error = %v, want TIMED_OUT; body = %v", resp["error"], resp)
	}

	rr = patchJSON(t, router, "/api/v1/users/me", token, map[string]string{"username": "timedout", "about": "still fine"})
	if rr.Code != http.StatusOK {
		t.Errorf("about only: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
}
