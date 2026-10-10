package api_test

// router_member_actions_test.go pins the member actions the desktop client
// calls (change role, ban/unban, force logout, list members) on the /api/v1
// surface. A reverse proxy in front of a server can answer /admin/... with a
// web page, so the client must not depend on that prefix; these routes run the
// same handlers, auth and ModerationService rank checks as /admin/api/users.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/app"
)

const (
	roleOwner     = 1
	roleAdmin     = 2
	roleModerator = 3
	roleMember    = 4
)

type memberActionsEnv struct {
	handler http.Handler
	db      *db.DB
	tokens  map[string]string
	ids     map[string]int64
}

func newMemberActionsEnv(t *testing.T) *memberActionsEnv {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	cfg := &config.Config{Server: config.ServerConfig{
		Name: "Test Server", Port: 8443, DataDir: t.TempDir(), AllowedOrigins: []string{"*"},
	}}
	rt, err := app.StartRuntime(cfg, database, nil)
	if err != nil {
		t.Fatalf("app.StartRuntime: %v", err)
	}
	handler, cleanup := api.NewRouter(cfg, database, "test", nil, nil, rt)
	t.Cleanup(cleanup)

	env := &memberActionsEnv{handler: handler, db: database, tokens: map[string]string{}, ids: map[string]int64{}}
	for name, role := range map[string]int{
		"owner": roleOwner, "admin": roleAdmin, "mod": roleModerator, "member": roleMember, "other": roleMember,
	} {
		hash, _ := auth.HashPassword("correctPass1")
		uid, err := database.CreateUser(context.Background(), name, hash, role)
		if err != nil {
			t.Fatalf("CreateUser(%s): %v", name, err)
		}
		token, _ := auth.GenerateToken()
		if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession(%s): %v", name, err)
		}
		env.tokens[name], env.ids[name] = token, uid
	}
	return env
}

func (e *memberActionsEnv) do(t *testing.T, method, path, actor, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if actor != "" {
		req.Header.Set("Authorization", "Bearer "+e.tokens[actor])
	}
	req.RemoteAddr = "127.0.0.1:9999"
	rr := httptest.NewRecorder()
	e.handler.ServeHTTP(rr, req)
	return rr
}

func (e *memberActionsEnv) roleOf(t *testing.T, name string) int64 {
	t.Helper()
	u, err := e.db.GetUserByID(context.Background(), e.ids[name])
	if err != nil {
		t.Fatalf("GetUserByID(%s): %v", name, err)
	}
	return u.RoleID
}

func (e *memberActionsEnv) path(name string) string {
	return "/api/v1/moderation/members/" + itoa(e.ids[name])
}

func TestMemberActions_ChangeRole_RankChecksEnforced(t *testing.T) {
	e := newMemberActionsEnv(t)
	cases := []struct {
		name      string
		actor     string
		target    string
		roleID    int
		wantCode  int
		wantAfter int64
	}{
		{"owner promotes member to moderator", "owner", "member", roleModerator, http.StatusOK, roleModerator},
		{"admin demotes that moderator to member", "admin", "member", roleMember, http.StatusOK, roleMember},
		{"admin cannot assign a role at its own rank", "admin", "other", roleAdmin, http.StatusForbidden, roleMember},
		{"admin cannot assign a role above its rank", "admin", "other", roleOwner, http.StatusForbidden, roleMember},
		{"admin cannot change the owner", "admin", "owner", roleMember, http.StatusForbidden, roleOwner},
		{"moderator lacks manage roles", "mod", "other", roleMember, http.StatusForbidden, roleMember},
		{"member lacks every permission", "member", "other", roleModerator, http.StatusForbidden, roleMember},
		{"nobody is unauthorised", "", "other", roleModerator, http.StatusUnauthorized, roleMember},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := e.do(t, http.MethodPatch, e.path(tc.target), tc.actor, `{"role_id":`+itoa(int64(tc.roleID))+`}`)
			if rr.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d; body = %s", rr.Code, tc.wantCode, rr.Body.String())
			}
			if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("Content-Type = %q, want JSON", ct)
			}
			if got := e.roleOf(t, tc.target); got != tc.wantAfter {
				t.Fatalf("role after = %d, want %d", got, tc.wantAfter)
			}
		})
	}
}

func TestMemberActions_BanAndForceLogout_RankChecksEnforced(t *testing.T) {
	e := newMemberActionsEnv(t)

	if rr := e.do(t, http.MethodPatch, e.path("member"), "mod", `{"banned":true}`); rr.Code != http.StatusOK {
		t.Fatalf("moderator ban of a member: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodPatch, e.path("member"), "mod", `{"banned":false}`); rr.Code != http.StatusOK {
		t.Fatalf("moderator unban: status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodPatch, e.path("admin"), "mod", `{"banned":true}`); rr.Code != http.StatusForbidden {
		t.Fatalf("moderator ban of an admin: status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodDelete, e.path("other")+"/sessions", "mod", ""); rr.Code != http.StatusNoContent {
		t.Fatalf("moderator force logout of a member: status = %d, want 204; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodDelete, e.path("owner")+"/sessions", "mod", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("moderator force logout of the owner: status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
	if rr := e.do(t, http.MethodDelete, e.path("other")+"/sessions", "member", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("member force logout: status = %d, want 403; body = %s", rr.Code, rr.Body.String())
	}
}

func TestMemberActions_List_ReachableByModerator(t *testing.T) {
	e := newMemberActionsEnv(t)
	rr := e.do(t, http.MethodGet, "/api/v1/moderation/members", "mod", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var users []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &users); err != nil || len(users) != 5 {
		t.Fatalf("want 5 users as JSON, got err=%v body=%s", err, rr.Body.String())
	}
	if rr := e.do(t, http.MethodGet, "/api/v1/moderation/members", "member", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("member list: status = %d, want 403", rr.Code)
	}
}
