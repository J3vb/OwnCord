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

// WP 6.5a: the category routes ride the same mount, so the client reaches them
// without the /admin prefix, behind the same MANAGE_CHANNELS check.
func TestChannelActions_Categories_PermittedMemberRoundTrip(t *testing.T) {
	e := newMemberActionsEnv(t)

	rr := e.do(t, http.MethodPost, channelsBase+"/categories", "admin", `{"name":"Games"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create category: status = %d, want 201; body = %s", rr.Code, rr.Body.String())
	}
	var games struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &games); err != nil || games.ID == 0 {
		t.Fatalf("create body has no id: err=%v body=%s", err, rr.Body.String())
	}
	rr = e.do(t, http.MethodPost, channelsBase+"/categories", "admin", `{"name":"Voice"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create second category: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var voice struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &voice)

	if rr := e.do(t, http.MethodPost, channelsBase+"/categories", "admin", `{"name":"games"}`); rr.Code != http.StatusConflict {
		t.Fatalf("duplicate: status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodPatch, channelsBase+"/categories/"+itoa(games.ID), "admin", `{"name":"Play"}`); rr.Code != http.StatusOK {
		t.Fatalf("rename: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodPatch, channelsBase+"/categories/99999", "admin", `{"name":"Nope"}`); rr.Code != http.StatusNotFound {
		t.Fatalf("rename missing: status = %d, want 404", rr.Code)
	}
	order := `{"ids":[` + itoa(voice.ID) + `,` + itoa(games.ID) + `]}`
	if rr := e.do(t, http.MethodPut, channelsBase+"/categories/order", "admin", order); rr.Code != http.StatusOK {
		t.Fatalf("reorder: status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	stale := `{"ids":[` + itoa(voice.ID) + `]}`
	if rr := e.do(t, http.MethodPut, channelsBase+"/categories/order", "admin", stale); rr.Code != http.StatusConflict {
		t.Fatalf("stale reorder: status = %d, want 409; body = %s", rr.Code, rr.Body.String())
	}
	rr = e.do(t, http.MethodGet, channelsBase+"/categories", "admin", "")
	var cats []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &cats); err != nil || len(cats) != 2 || cats[0].ID != voice.ID || cats[1].Name != "Play" {
		t.Fatalf("list = %s (err %v), want Voice then Play", rr.Body.String(), err)
	}
	if rr := e.do(t, http.MethodDelete, channelsBase+"/categories/"+itoa(games.ID), "admin", ""); rr.Code != http.StatusNoContent {
		t.Fatalf("delete: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
}

func TestChannelActions_Categories_WithoutManageChannels_Forbidden(t *testing.T) {
	e := newMemberActionsEnv(t)
	for _, actor := range []string{e.addKicker(t), "member"} {
		for _, c := range []struct{ method, path, body string }{
			{http.MethodGet, channelsBase + "/categories", ""},
			{http.MethodPost, channelsBase + "/categories", `{"name":"Nope"}`},
			{http.MethodPut, channelsBase + "/categories/order", `{"ids":[]}`},
			{http.MethodPatch, channelsBase + "/categories/1", `{"name":"Nope"}`},
			{http.MethodDelete, channelsBase + "/categories/1", ""},
		} {
			if rr := e.do(t, c.method, c.path, actor, c.body); rr.Code != http.StatusForbidden {
				t.Fatalf("%s %s as %s: status = %d, want 403; body = %s", c.method, c.path, actor, rr.Code, rr.Body.String())
			}
		}
	}
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, channelsBase + "/categories", ""},
		{http.MethodPost, channelsBase + "/categories", `{"name":"Nope"}`},
	} {
		if rr := e.do(t, c.method, c.path, "", c.body); rr.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a token: status = %d, want 401", c.method, c.path, rr.Code)
		}
	}
}
