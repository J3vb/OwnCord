package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// OC-0304: POST /dms must apply the same "no live connection is offline,
// whatever users.status stores" rule ws/serve_ready.go's
// presentableMembers/presentableDMChannels apply to the ready payload and
// members list. MarkUserDisconnected deliberately keeps a chosen idle/dnd
// status across a disconnect (so a reconnect can honour it), so a
// signed-out recipient's saved "dnd" must not leak into the DM sidebar as a
// live presence dot — contradicting the member list right next to it, which
// would correctly show the same user offline.
func TestCreateDM_RecipientStatus_OfflineWhenDisconnected(t *testing.T) {
	database := newDMTestDB(t)
	broadcaster := &mockBroadcaster{}

	r := chi.NewRouter()
	svc := service.New(database, auth.NewRateLimiter())
	api.MountDMRoutes(r, database, svc, broadcaster)

	tokenAlice := dmCreateToken(t, database, "presence_alice", 4)
	_ = dmCreateToken(t, database, "presence_bob", 4)
	bob, err := database.GetUserByUsername(context.Background(), "presence_bob")
	if err != nil || bob == nil {
		t.Fatalf("lookup bob: %v", err)
	}

	// Bob chose "Do Not Disturb" and then signed out: MarkUserDisconnected
	// only ever rewrites the "online" status, so the saved row keeps "dnd".
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET status = 'dnd' WHERE id = ?`, bob.ID,
	); err != nil {
		t.Fatalf("set bob status: %v", err)
	}

	// Nobody currently holds a live connection — mirrors a hub with bob's
	// session gone.
	svc.DMs.SetOnlineChecker(func(userID int64) bool { return false })

	rr := dmPost(t, r, "/api/v1/dms", tokenAlice, map[string]any{
		"recipient_id": bob.ID,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("CreateDM: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	recipient, ok := resp["recipient"].(map[string]any)
	if !ok {
		t.Fatalf("recipient missing from response: %v", resp)
	}
	if got := recipient["status"]; got != db.StatusOffline {
		t.Errorf("recipient.status = %v, want %q (bob has no live connection, so his saved 'dnd' must not leak into the DM sidebar)",
			got, db.StatusOffline)
	}
}
