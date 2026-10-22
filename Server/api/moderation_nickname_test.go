package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// recordingProfileBroadcaster captures the user_update frames the nickname
// route asks the hub to send.
type recordingProfileBroadcaster struct {
	mu      sync.Mutex
	updates []ws.UserUpdate
}

func (b *recordingProfileBroadcaster) BroadcastUserUpdate(u ws.UserUpdate) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.updates = append(b.updates, u)
}

func (b *recordingProfileBroadcaster) snapshot() []ws.UserUpdate {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]ws.UserUpdate(nil), b.updates...)
}

func buildNicknameRouter(t *testing.T) (http.Handler, *db.DB, *recordingProfileBroadcaster) {
	t.Helper()
	database := newModQueueActTestDB(t)
	rec := &recordingProfileBroadcaster{}
	r := chi.NewRouter()
	api.MountModerationRoutes(r, service.New(database, auth.NewRateLimiter()), rec)
	return r, database, rec
}

func TestNicknameRoute_BroadcastsCommittedSnapshot(t *testing.T) {
	h, database, rec := buildNicknameRouter(t)
	modID := mintModerator(t, database, "nick-mod", 80, permissions.ManageNicknames)
	modToken, _ := mintSession(t, database, modID)
	victimID := mintUser(t, database, "nick-victim")
	path := "/api/v1/moderation/users/" + itoa(victimID) + "/nickname"

	// The padded request is stored and broadcast in its cleaned form.
	status, body := actJSON(t, h, http.MethodPut, path, modToken, `{"display_name":"  Big    Bird "}`)
	if status != http.StatusOK {
		t.Fatalf("PUT: status = %d, body = %s", status, body)
	}
	var resp struct {
		UserID      int64   `json:"user_id"`
		DisplayName *string `json:"display_name"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.UserID != victimID || resp.DisplayName == nil || *resp.DisplayName != "Big Bird" {
		t.Fatalf("response = %s (%v), want {user_id:%d, display_name:Big Bird}", body, err, victimID)
	}
	got := rec.snapshot()
	if len(got) != 1 {
		t.Fatalf("broadcasts = %d, want exactly one user_update", len(got))
	}
	if got[0].UserID != victimID || got[0].Username != "nick-victim" || got[0].DisplayName == nil || *got[0].DisplayName != "Big Bird" {
		t.Fatalf("broadcast = %+v, want the committed full snapshot with display_name Big Bird", got[0])
	}
	stored, err := database.GetUserByID(context.Background(), victimID)
	if err != nil || stored.DisplayName == nil || *stored.DisplayName != "Big Bird" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}

	// null clears, and the broadcast says so.
	status, body = actJSON(t, h, http.MethodPut, path, modToken, `{"display_name":null}`)
	if status != http.StatusOK || len(body) == 0 {
		t.Fatalf("PUT null: status = %d, body = %s", status, body)
	}
	got = rec.snapshot()
	if len(got) != 2 || got[1].DisplayName != nil {
		t.Fatalf("broadcasts after clear = %+v, want a second with no display_name", got)
	}
}

func TestNicknameRoute_RefusalsDoNotBroadcastOrWrite(t *testing.T) {
	h, database, rec := buildNicknameRouter(t)
	modID := mintModerator(t, database, "nr-mod", 80, permissions.ManageNicknames)
	modToken, _ := mintSession(t, database, modID)
	plainID := mintUser(t, database, "nr-plain")
	plainToken, _ := mintSession(t, database, plainID)
	victimID := mintUser(t, database, "nr-victim")
	peerID := mintModerator(t, database, "nr-peer", 80, permissions.ManageNicknames)
	path := func(id int64) string { return "/api/v1/moderation/users/" + itoa(id) + "/nickname" }

	tests := []struct {
		name   string
		token  string
		target int64
		body   string
		status int
		code   string
	}{
		{"no bit", plainToken, victimID, `{"display_name":"x"}`, http.StatusForbidden, "FORBIDDEN"},
		{"no bit, unknown id", plainToken, 98765, `{"display_name":"x"}`, http.StatusForbidden, "FORBIDDEN"},
		{"equal rank", modToken, peerID, `{"display_name":"x"}`, http.StatusForbidden, "FORBIDDEN"},
		{"unknown id with the bit", modToken, 98765, `{"display_name":"x"}`, http.StatusNotFound, "NOT_FOUND"},
		{"self", modToken, modID, `{"display_name":"x"}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"absent key", modToken, victimID, `{}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"wrong type", modToken, victimID, `{"display_name":5}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"malformed", modToken, victimID, `{`, http.StatusBadRequest, "INVALID_INPUT"},
		{"control character", modToken, victimID, `{"display_name":"a\u0000b"}`, http.StatusBadRequest, "INVALID_INPUT"},
		{"33 runes", modToken, victimID, `{"display_name":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, http.StatusBadRequest, "INVALID_INPUT"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, body := actJSON(t, h, http.MethodPut, path(tc.target), tc.token, tc.body)
			var resp struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(body, &resp)
			if status != tc.status || resp.Error != tc.code {
				t.Fatalf("status = %d error = %q (%s), want %d %s", status, resp.Error, body, tc.status, tc.code)
			}
		})
	}
	if n := len(rec.snapshot()); n != 0 {
		t.Fatalf("refused requests broadcast %d user_update frame(s)", n)
	}
	stored, err := database.GetUserByID(context.Background(), victimID)
	if err != nil || stored.DisplayName != nil {
		t.Fatalf("victim = %+v, %v; want the nickname untouched", stored, err)
	}

	// Unauthenticated: the auth middleware answers before any handler runs.
	if status, _ := actJSON(t, h, http.MethodPut, path(victimID), "not-a-token", `{"display_name":"x"}`); status != http.StatusUnauthorized {
		t.Fatalf("bad token: status = %d, want 401", status)
	}
}

// TestNicknameRoute_PromotedBeforeWriteBroadcastsNothing: the target is
// promoted to the actor's rank after the service's cached check and before
// the write. The transaction refuses, the route answers 403, the row is
// unchanged and no user_update goes out.
func TestNicknameRoute_PromotedBeforeWriteBroadcastsNothing(t *testing.T) {
	h, database, rec := buildNicknameRouter(t)
	ctx := context.Background()
	modID := mintModerator(t, database, "pw-mod", 80, permissions.ManageNicknames)
	modToken, _ := mintSession(t, database, modID)
	victimID := mintUser(t, database, "pw-victim")
	path := "/api/v1/moderation/users/" + itoa(victimID) + "/nickname"

	if status, body := actJSON(t, h, http.MethodPut, path, modToken, `{"display_name":"first"}`); status != http.StatusOK {
		t.Fatalf("control PUT: status = %d, body = %s", status, body)
	}
	// Promote the victim straight in the database. The router's permission
	// cache still holds the old rank, as it would mid-request.
	peer, err := database.CreateRole(ctx, "pw-peer-role", nil, permissions.ReadMessages, 80)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	if err := database.UpdateUserRole(ctx, victimID, peer.ID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}

	status, body := actJSON(t, h, http.MethodPut, path, modToken, `{"display_name":"second"}`)
	if status != http.StatusForbidden {
		t.Fatalf("PUT after promotion: status = %d, body = %s, want 403", status, body)
	}
	if n := len(rec.snapshot()); n != 1 {
		t.Fatalf("broadcasts = %d, want only the control's", n)
	}
	stored, err := database.GetUserByID(ctx, victimID)
	if err != nil || stored.DisplayName == nil || *stored.DisplayName != "first" {
		t.Fatalf("stored = %+v, %v; want it unchanged at first", stored, err)
	}
}
