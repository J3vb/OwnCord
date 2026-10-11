package api_test

// router_channel_actions_test.go pins the channel actions the desktop client
// calls (create, edit, delete) on the /api/v1 surface. A reverse proxy in front
// of a server can answer /admin/... with a web page, so the client must not
// depend on that prefix; these routes run the same handlers and the same
// MANAGE_CHANNELS check as /admin/api/channels, and accept only a session or
// API token issued by this server.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const channelsBase = "/api/v1/moderation/channels"

func (e *memberActionsEnv) channelCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := e.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM channels").Scan(&n); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	return n
}

// addKicker adds a member whose role clears the admin perimeter (KICK_MEMBERS)
// but holds no MANAGE_CHANNELS, and returns its actor name.
func (e *memberActionsEnv) addKicker(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	role, err := e.db.CreateRole(ctx, "kicker", nil, permissions.ReadMessages|permissions.KickMembers, 50)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	hash, _ := auth.HashPassword("correctPass1")
	uid, err := e.db.CreateUser(ctx, "kicker", hash, int(role.ID))
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, _ := auth.GenerateToken()
	if _, err := e.db.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	e.tokens["kicker"], e.ids["kicker"] = token, uid
	return "kicker"
}

func TestChannelActions_Create_Edit_Delete_PermittedMemberSucceeds(t *testing.T) {
	e := newMemberActionsEnv(t)

	rr := e.do(t, http.MethodPost, channelsBase, "admin", `{"name":"planning","type":"text","category":"Team"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("create Content-Type = %q, want JSON", ct)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil || created.ID == 0 {
		t.Fatalf("create body has no id: err=%v body=%s", err, rr.Body.String())
	}
	path := channelsBase + "/" + itoa(created.ID)

	if rr := e.do(t, http.MethodPatch, path, "admin", `{"name":"planning-2","topic":"roadmap"}`); rr.Code != http.StatusOK {
		t.Fatalf("edit: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	before := e.channelCount(t)
	if rr := e.do(t, http.MethodDelete, path, "admin", ""); rr.Code != http.StatusNoContent {
		t.Fatalf("delete: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if got := e.channelCount(t); got != before-1 {
		t.Fatalf("channels after delete = %d, want %d", got, before-1)
	}
}

func TestChannelActions_WithoutManageChannels_Forbidden(t *testing.T) {
	e := newMemberActionsEnv(t)
	before := e.channelCount(t)
	// "kicker" clears the admin perimeter but holds no MANAGE_CHANNELS; "member"
	// holds no moderation bit at all.
	for _, actor := range []string{e.addKicker(t), "member"} {
		for _, c := range []struct{ method, path, body string }{
			{http.MethodPost, channelsBase, `{"name":"nope","type":"text","category":"Team"}`},
			{http.MethodPatch, channelsBase + "/1", `{"name":"renamed"}`},
			{http.MethodDelete, channelsBase + "/1", ""},
		} {
			if rr := e.do(t, c.method, c.path, actor, c.body); rr.Code != http.StatusForbidden {
				t.Fatalf("%s %s as %s: status = %d, want 403; body = %s", c.method, c.path, actor, rr.Code, rr.Body.String())
			}
		}
	}
	if got := e.channelCount(t); got != before {
		t.Fatalf("channels = %d, want unchanged %d", got, before)
	}
}

func TestChannelActions_ForeignOrMissingToken_Unauthorised(t *testing.T) {
	e := newMemberActionsEnv(t)
	e.tokens["foreign"] = "a-token-this-server-never-issued"
	before := e.channelCount(t)
	for _, actor := range []string{"", "foreign"} {
		for _, c := range []struct{ method, path, body string }{
			{http.MethodPost, channelsBase, `{"name":"nope","type":"text","category":"Team"}`},
			{http.MethodPatch, channelsBase + "/1", `{"name":"renamed"}`},
			{http.MethodDelete, channelsBase + "/1", ""},
		} {
			if rr := e.do(t, c.method, c.path, actor, c.body); rr.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s as %q: status = %d, want 401; body = %s", c.method, c.path, actor, rr.Code, rr.Body.String())
			}
		}
	}
	if got := e.channelCount(t); got != before {
		t.Fatalf("channels = %d, want unchanged %d", got, before)
	}
}
