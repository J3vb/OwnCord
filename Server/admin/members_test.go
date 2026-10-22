package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// AO-4: the Members page. Its search, role filter and Banned tab are
// server-side, and the self-guard the page shows is the server's, not the
// panel's: hiding a button is only an affordance.

func membersTestAPI(t *testing.T) (http.Handler, func(string, int) (int64, string)) {
	t.Helper()
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, svc)
	return handler, func(name string, role int) (int64, string) { return sessionFor(t, database, name, role) }
}

func TestAdminAPI_ListUsers_SearchFilterAndBanned(t *testing.T) {
	handler, seed := membersTestAPI(t)
	_, ownerToken := seed("owner", 1)
	seed("Alice", 4)
	seed("malice", 2)
	bobID, _ := seed("bob", 4)
	if w := doRequest(t, handler, http.MethodPatch, "/users/"+itoa(bobID), ownerToken,
		map[string]any{"banned": true, "ban_reason": "spam"}); w.Code != http.StatusOK {
		t.Fatalf("ban bob = %d; body: %s", w.Code, w.Body.String())
	}

	list := func(query string) []map[string]any {
		t.Helper()
		w := doRequest(t, handler, http.MethodGet, "/users?limit=51&offset=0"+query, ownerToken, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /users%s = %d; body: %s", query, w.Code, w.Body.String())
		}
		var rows []map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return rows
	}
	names := func(query string) string {
		t.Helper()
		rows := list(query)
		out := make([]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, r["username"].(string))
		}
		return strings.Join(out, ",")
	}

	for _, tc := range []struct{ query, want string }{
		{"", "owner,Alice,malice,bob"},
		{"&q=ALIC", "Alice,malice"},
		{"&q=%20alice%20", "Alice,malice"},
		{"&q=%25", ""},
		{"&role_id=2", "malice"},
		{"&q=alice&role_id=4", "Alice"},
		{"&banned=1", "bob"},
		{"&banned=1&q=zzz", ""},
		{"&role_id=nope", "owner,Alice,malice,bob"},
	} {
		if got := names(tc.query); got != tc.want {
			t.Errorf("GET /users%s = %q, want %q", tc.query, got, tc.want)
		}
	}

	// Each row carries its role's position, which the panel compares with
	// its own to offer only what the outrank rule allows.
	for _, r := range list("&q=owner") {
		if r["role_position"] != float64(100) {
			t.Errorf("owner role_position = %v, want 100", r["role_position"])
		}
		// ... and every held role, top first (WP 6.3g), for the role chips.
		if ids, ok := r["role_ids"].([]any); !ok || len(ids) == 0 || ids[0] != float64(1) {
			t.Errorf("owner role_ids = %v, want a list led by the Owner role", r["role_ids"])
		}
	}

	if w := doRequest(t, handler, http.MethodGet, "/users?q="+strings.Repeat("a", 65), ownerToken, nil); w.Code != http.StatusBadRequest {
		t.Errorf("an over-long search = %d, want 400", w.Code)
	}
}

// WP 6.4d: the Members list carries each member's nickname (omitted when
// unset), and the search matches it as well as the username.
func membersNicknameAPI(t *testing.T) (http.Handler, string) {
	t.Helper()
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, svc)
	_, ownerToken := sessionFor(t, database, "owner", 1)
	aliceID, _ := sessionFor(t, database, "alice", 4)
	sessionFor(t, database, "bob", 4)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET display_name = ? WHERE id = ?`, "Captain Hook", aliceID); err != nil {
		t.Fatalf("set display_name: %v", err)
	}
	return handler, ownerToken
}

func listUsersRows(t *testing.T, handler http.Handler, token, query string) []map[string]any {
	t.Helper()
	w := doRequest(t, handler, http.MethodGet, "/users?limit=51&offset=0"+query, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /users%s = %d; body: %s", query, w.Code, w.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return rows
}

func TestListUsers_ReturnsDisplayName(t *testing.T) {
	handler, token := membersNicknameAPI(t)
	for _, r := range listUsersRows(t, handler, token, "") {
		name, has := r["display_name"]
		switch r["username"] {
		case "alice":
			if name != "Captain Hook" {
				t.Errorf("alice display_name = %v, want Captain Hook", name)
			}
		default:
			if has {
				t.Errorf("%v display_name = %v, want the field omitted when unset", r["username"], name)
			}
		}
	}
}

func TestListUsers_SearchMatchesDisplayName(t *testing.T) {
	handler, token := membersNicknameAPI(t)
	for _, tc := range []struct{ query, want string }{
		{"&q=HOOK", "alice"},
		{"&q=captain%20h", "alice"},
		{"&q=alice", "alice"},
		{"&q=bob", "bob"},
		{"&q=zzz", ""},
	} {
		rows := listUsersRows(t, handler, token, tc.query)
		got := make([]string, 0, len(rows))
		for _, r := range rows {
			got = append(got, r["username"].(string))
		}
		if joined := strings.Join(got, ","); joined != tc.want {
			t.Errorf("GET /users%s = %q, want %q", tc.query, joined, tc.want)
		}
	}
}

// Every Members action refuses the actor's own account and anyone at or above
// the actor's rank, whatever the panel renders.
func TestAdminAPI_MembersSelfAndRankGuard(t *testing.T) {
	ctx := context.Background()
	database := openMigratedAdminDB(t)
	svc := service.New(database, auth.NewRateLimiter())
	svc.Auth = service.NewAuthService(database, auth.NewRateLimiter(), nil, nil)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, &mockPermInvalidator{}, svc)
	ownerID, ownerToken := sessionFor(t, database, "guard-owner", 1)
	adminID, adminToken := sessionFor(t, database, "guard-admin", 2)
	peerID, _ := sessionFor(t, database, "guard-peer", 2)

	actions := func(id int64) []struct {
		name, method, path string
		body               any
	} {
		p := "/users/" + itoa(id)
		return []struct {
			name, method, path string
			body               any
		}{
			{"demote", http.MethodPatch, p, map[string]any{"role_id": 4}},
			{"ban", http.MethodPatch, p, map[string]any{"banned": true, "ban_reason": "x"}},
			{"force logout", http.MethodDelete, p + "/sessions", nil},
			{"erase", http.MethodDelete, p, nil},
			{"recovery credential", http.MethodPost, p + "/recovery-credential", map[string]string{"verification": "in_person"}},
		}
	}

	for _, tc := range []struct {
		who    string
		token  string
		target int64
	}{
		{"owner on itself", ownerToken, ownerID},
		{"admin on itself", adminToken, adminID},
		{"admin on the owner", adminToken, ownerID},
		{"admin on a peer admin", adminToken, peerID},
	} {
		for _, a := range actions(tc.target) {
			w := doRequest(t, handler, a.method, a.path, tc.token, a.body)
			if w.Code != http.StatusBadRequest && w.Code != http.StatusForbidden {
				t.Errorf("%s: %s = %d, want 400 or 403; body: %s", tc.who, a.name, w.Code, w.Body.String())
			}
		}
	}

	// Nothing a refused request touched changed.
	for id, role := range map[int64]int64{ownerID: 1, adminID: 2, peerID: 2} {
		u, err := database.GetUserByID(ctx, id)
		if err != nil || u == nil {
			t.Fatalf("user %d is gone (%v)", id, err)
		}
		if u.Banned || u.RoleID != role {
			t.Errorf("user %d: banned=%v role=%d, want unbanned in role %d", id, u.Banned, u.RoleID, role)
		}
		sessions, err := database.GetUserSessions(ctx, id)
		if err != nil || len(sessions) == 0 {
			t.Errorf("user %d lost its sessions (%v)", id, err)
		}
	}
}
