package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8c over REST: POST /dms refuses a recipient who has DMs off with the
// same status and body as a block in either direction.
func TestDMPrivacy_RefusalMatchesBlock_CreateDM(t *testing.T) {
	scenarios := []struct {
		name  string
		setup func(t *testing.T, database *db.DB, alice, bob int64)
	}{
		{"privacy_off", func(t *testing.T, d *db.DB, _, bob int64) {
			if err := d.SetUserPrivacy(context.Background(), bob, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
				t.Fatalf("SetUserPrivacy: %v", err)
			}
		}},
		{"blocked_by_recipient", func(t *testing.T, d *db.DB, alice, bob int64) {
			if err := d.BlockUser(context.Background(), bob, alice); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
		{"sender_blocked_recipient", func(t *testing.T, d *db.DB, alice, bob int64) {
			if err := d.BlockUser(context.Background(), alice, bob); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
	}
	var wantCode int
	var wantBody string
	for i, sc := range scenarios {
		database := newDMTestDB(t)
		router := buildDMRouter(database, &mockBroadcaster{})
		tokenAlice := dmCreateToken(t, database, "alice", 4)
		dmCreateToken(t, database, "bob", 4)
		aliceID, bobID := mustUserID(t, database, "alice"), mustUserID(t, database, "bob")
		sc.setup(t, database, aliceID, bobID)

		rr := dmPost(t, router, "/api/v1/dms", tokenAlice, map[string]int64{"recipient_id": bobID})
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s: status = %d, want 403; body = %s", sc.name, rr.Code, rr.Body.String())
		}
		if i == 0 {
			wantCode, wantBody = rr.Code, rr.Body.String()
			continue
		}
		if rr.Code != wantCode || rr.Body.String() != wantBody {
			t.Errorf("%s: %d %s, privacy_off: %d %s; want identical", sc.name, rr.Code, rr.Body.String(), wantCode, wantBody)
		}
	}

	// A recipient who does not exist is still a 404, never the refusal.
	database := newDMTestDB(t)
	router := buildDMRouter(database, &mockBroadcaster{})
	token := dmCreateToken(t, database, "alice", 4)
	if rr := dmPost(t, router, "/api/v1/dms", token, map[string]int64{"recipient_id": 9999}); rr.Code != http.StatusNotFound {
		t.Errorf("missing recipient: status = %d, want 404", rr.Code)
	}
}
