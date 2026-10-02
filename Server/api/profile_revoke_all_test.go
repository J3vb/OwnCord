package api_test

// Sign-out-everywhere's two review fixes (Codex on PR #1500): the live
// sockets of the account go with its sessions, and a call with nothing to
// revoke writes no audit row; the route is bounded per account. It takes
// the account's API tokens too.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/db/audittest"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// revokeSpy stands in for the hub: it records which users were disconnected
// after a sign-out-everywhere and ignores profile broadcasts.
type revokeSpy struct {
	disconnected []int64
	checked      []int64
}

func (s *revokeSpy) BroadcastUserUpdate(ws.UserUpdate) {}
func (s *revokeSpy) DisconnectRevokedUser(userID int64) {
	s.disconnected = append(s.disconnected, userID)
}
func (s *revokeSpy) DisconnectIfSessionRevoked(userID int64) {
	s.checked = append(s.checked, userID)
}

func buildProfileRouterWithHub(database *db.DB, spy *revokeSpy) (http.Handler, *auth.RateLimiter) {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, database, service.New(database, limiter), nil, limiter, nil, spy, nil)
	return r, limiter
}

func apiTokenFor(t *testing.T, database *db.DB, username string) (string, int64) {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, mustHash(t), 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	tok, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateAPIToken(context.Background(), uid, auth.HashToken(tok), "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	return tok, uid
}

func decodeRevokeAll(t *testing.T, body []byte) (revoked int64, current bool) {
	t.Helper()
	var resp struct {
		SessionsRevoked int64 `json:"sessions_revoked"`
		CurrentRevoked  bool  `json:"current_session_revoked"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp.SessionsRevoked, resp.CurrentRevoked
}

func TestRevokeAllSessions_DisconnectsTheAccountsLiveSockets(t *testing.T) {
	database := newAuthTestDB(t)
	spy := &revokeSpy{}
	router, _ := buildProfileRouterWithHub(database, spy)
	ctx := context.Background()

	token := profileCreateToken(t, database, "alice-sockets", 4)
	alice, _ := database.GetUserByUsername(ctx, "alice-sockets")
	if _, err := database.CreateSession(ctx, alice.ID, auth.HashToken("alice-phone"), "Phone", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}

	rr := profileDelete(t, router, "/api/v1/users/me/sessions", token)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	if n, current := decodeRevokeAll(t, rr.Body.Bytes()); n != 2 || !current {
		t.Fatalf("revoked = %d, current = %v; want 2 and true", n, current)
	}
	// The hub is told once, for exactly this account, in the same request —
	// not left to the revoked-session sweep's next tick.
	if len(spy.disconnected) != 1 || spy.disconnected[0] != alice.ID {
		t.Fatalf("disconnected = %v, want [%d]", spy.disconnected, alice.ID)
	}
}

func TestRevokeAllSessions_NothingToRevokeWritesNoAuditRow(t *testing.T) {
	database := newAuthTestDB(t)
	spy := &revokeSpy{}
	router, _ := buildProfileRouterWithHub(database, spy)
	tok, uid := apiTokenFor(t, database, "token-only")
	rec := audittest.Install(t, database)

	// An API-token principal holds no session: the call revokes its token
	// and no session, and leaves no socket to drop.
	rr := profileDelete(t, router, "/api/v1/users/me/sessions", tok)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	if n, current := decodeRevokeAll(t, rr.Body.Bytes()); n != 0 || current {
		t.Fatalf("revoked = %d, current = %v; want 0 and false", n, current)
	}
	rec.Wait(t, "session_revoke_all")
	// A repeat finds nothing left and must not add a row. The writer keeps
	// order, so once a later sentinel lands any row the repeat wrote is in.
	ctx := context.Background()
	if _, err := service.New(database, auth.NewRateLimiter()).Users.RevokeAllSessions(ctx, uid); err != nil {
		t.Fatalf("RevokeAllSessions: %v", err)
	}
	db.WriteAudit(ctx, database, uid, "test_sentinel", "user", uid, "")
	rec.Wait(t, "test_sentinel")
	rows := 0
	for _, e := range rec.Entries() {
		if e.Action == "session_revoke_all" {
			rows++
		}
	}
	if rows != 1 {
		t.Fatalf("session_revoke_all rows = %d, want 1: a no-op sign-out-everywhere wrote one", rows)
	}
	if len(spy.disconnected) != 0 {
		t.Fatalf("a sign-out-everywhere with no session disconnected %v", spy.disconnected)
	}
}

func TestRevokeAllSessions_IsRateLimitedPerAccount(t *testing.T) {
	database := newAuthTestDB(t)
	router, _ := buildProfileRouterWithHub(database, &revokeSpy{})
	uid, err := database.CreateUser(context.Background(), "session-hammer", mustHash(t), 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// Each call revokes the caller's own session, so each signs in afresh.
	for i := range 5 {
		if rr := profileDelete(t, router, "/api/v1/users/me/sessions", issueSessionToken(t, database, uid)); rr.Code != http.StatusOK {
			t.Fatalf("call %d: status = %d, want 200; body = %s", i, rr.Code, rr.Body.String())
		}
	}
	rr := profileDelete(t, router, "/api/v1/users/me/sessions", issueSessionToken(t, database, uid))
	wantErr(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "too many sign-out-everywhere requests, try again later")
}

// Sign-out-everywhere takes the account's API tokens with its sessions, and
// the audit row counts both.
func TestRevokeAllSessions_RevokesTheAccountsAPITokens(t *testing.T) {
	database := newAuthTestDB(t)
	router, _ := buildProfileRouterWithHub(database, &revokeSpy{})
	ctx := context.Background()

	token := profileCreateToken(t, database, "alice-tokens", 4)
	alice, _ := database.GetUserByUsername(ctx, "alice-tokens")
	apiToken := issueAPIToken(t, database, alice.ID)
	rec := audittest.Install(t, database)

	if rr := profileDelete(t, router, "/api/v1/users/me/sessions", token); rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	if rr := getWithToken(t, router, "/api/v1/users/me/sessions", apiToken); rr.Code != http.StatusUnauthorized {
		t.Fatalf("API token after sign-out-everywhere = %d, want 401", rr.Code)
	}
	if detail := rec.Wait(t, "session_revoke_all").Detail; !strings.Contains(detail, "1 API tokens revoked") {
		t.Fatalf("audit detail = %q, want the API token count", detail)
	}
}

// A password change and a single-session revoke each remove sessions other
// than (or besides) the caller's: the hub is asked, in the same request, to
// drop the account's socket if its session was among them.
func TestPartialSessionRevokes_CheckTheAccountsLiveSocket(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(t *testing.T, router http.Handler, database *db.DB, token string, uid int64) int
	}{
		{"password change", func(t *testing.T, router http.Handler, database *db.DB, token string, uid int64) int {
			if _, err := database.CreateSession(context.Background(), uid, auth.HashToken("alice-phone"), "Phone", "10.0.0.2"); err != nil {
				t.Fatal(err)
			}
			return putJSON(t, router, "/api/v1/users/me/password", token, map[string]string{
				"old_password": "securePass1", "new_password": "newSecure2",
			}).Code
		}},
		{"single revoke", func(t *testing.T, router http.Handler, database *db.DB, token string, uid int64) int {
			id, err := database.CreateSession(context.Background(), uid, auth.HashToken("alice-phone"), "Phone", "10.0.0.2")
			if err != nil {
				t.Fatal(err)
			}
			return profileDelete(t, router, fmt.Sprintf("/api/v1/users/me/sessions/%d", id), token).Code
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := newAuthTestDB(t)
			spy := &revokeSpy{}
			router, _ := buildProfileRouterWithHub(database, spy)
			token := profileCreateToken(t, database, "alice-partial", 4)
			alice, _ := database.GetUserByUsername(context.Background(), "alice-partial")

			if code := tc.call(t, router, database, token, alice.ID); code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204", code)
			}
			if len(spy.checked) != 1 || spy.checked[0] != alice.ID {
				t.Fatalf("checked = %v, want [%d]", spy.checked, alice.ID)
			}
			if len(spy.disconnected) != 0 {
				t.Fatalf("disconnected = %v: the caller's own socket must not be dropped unconditionally", spy.disconnected)
			}
		})
	}
}
