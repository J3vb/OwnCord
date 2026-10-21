package api_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// WP 6.8d: the group refusal is one 403 whatever the cause, on create and on
// add, and it never names the target.
func TestAddGroupMembers_RefusalBodyIdentical(t *testing.T) {
	ctx := context.Background()
	causes := map[string]func(t *testing.T, database *db.DB){
		"privacy": func(t *testing.T, database *db.DB) {
			if err := database.SetUserPrivacy(ctx, 4, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
				t.Fatalf("SetUserPrivacy: %v", err)
			}
		},
		"block": func(t *testing.T, database *db.DB) {
			if err := database.BlockUser(ctx, 4, 2); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		},
		"request": func(t *testing.T, database *db.DB) {
			ch, _, err := database.GetOrCreateDMChannel(ctx, 1, 4)
			if err != nil {
				t.Fatalf("GetOrCreateDMChannel: %v", err)
			}
			if _, err = database.ExecContext(ctx,
				`INSERT INTO message_requests (sender_id, recipient_id, channel_id, state) VALUES (1, 4, ?, 'pending')`, ch.ID); err != nil {
				t.Fatalf("insert request: %v", err)
			}
		},
	}
	bodies := map[string]string{}
	for name, arrange := range causes {
		database := newMigratedAuthTestDB(t)
		router := buildDMRouter(database, &recordingBroadcaster{})
		tokens := make([]string, 0, 4)
		for _, user := range []string{"alice", "bob", "carol", "dave"} {
			tokens = append(tokens, dmCreateToken(t, database, user, 4))
		}
		group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{"recipient_ids": []int64{2, 3}}))
		arrange(t, database)

		rr := dmDo(t, router, http.MethodPost, fmt.Sprintf("/api/v1/dms/%d/members", group.ChannelID), tokens[0], map[string]any{"user_ids": []int64{4}})
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s: add status = %d, want 403; body = %s", name, rr.Code, rr.Body.String())
		}
		bodies[name+"/add"] = rr.Body.String()

		rr = dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{"recipient_ids": []int64{2, 4}})
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s: create status = %d, want 403; body = %s", name, rr.Code, rr.Body.String())
		}
		bodies[name+"/create"] = rr.Body.String()
	}
	want := bodies["privacy/add"]
	for k, b := range bodies {
		if b != want {
			t.Errorf("%s body = %s, want the same as privacy/add: %s", k, b, want)
		}
	}
}
