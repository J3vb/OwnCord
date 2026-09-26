package api_test

// Sign-out-everywhere's two review fixes (Codex on PR #1500): the live
// sockets of the account go with its sessions, and a principal with nothing
// to revoke neither writes an audit row nor gets to call the route without
// bound.

import (
	"context"
	"encoding/json"
	"net/http"
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
}

func (s *revokeSpy) BroadcastUserUpdate(ws.UserUpdate) {}
func (s *revokeSpy) DisconnectRevokedUser(userID int64) {
	s.disconnected = append(s.disconnected, userID)
}

func buildProfileRouterWithHub(database *db.DB, spy *revokeSpy) (http.Handler, *auth.RateLimiter) {
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, database, service.New(database, limiter), nil, limiter, nil, spy)
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
	tok, _ := apiTokenFor(t, database, "token-only")
	rec := audittest.Install(t, database)

	// An API-token principal holds no session, so the first call already
	// revokes nothing; the second must not add a row either.
	for i := range 2 {
		rr := profileDelete(t, router, "/api/v1/users/me/sessions", tok)
		if rr.Code != http.StatusOK {
			t.Fatalf("call %d: status = %d, want 200; body = %s", i, rr.Code, rr.Body.String())
		}
		if n, current := decodeRevokeAll(t, rr.Body.Bytes()); n != 0 || current {
			t.Fatalf("call %d: revoked = %d, current = %v; want 0 and false", i, n, current)
		}
	}
	for _, e := range rec.Entries() {
		if e.Action == "session_revoke_all" {
			t.Fatalf("a no-op sign-out-everywhere wrote an audit row: %+v", e)
		}
	}
	if len(spy.disconnected) != 0 {
		t.Fatalf("a no-op sign-out-everywhere disconnected %v", spy.disconnected)
	}
}

func TestRevokeAllSessions_IsRateLimitedPerAccount(t *testing.T) {
	database := newAuthTestDB(t)
	router, _ := buildProfileRouterWithHub(database, &revokeSpy{})
	tok, _ := apiTokenFor(t, database, "token-hammer")

	for i := range 5 {
		if rr := profileDelete(t, router, "/api/v1/users/me/sessions", tok); rr.Code != http.StatusOK {
			t.Fatalf("call %d: status = %d, want 200; body = %s", i, rr.Code, rr.Body.String())
		}
	}
	rr := profileDelete(t, router, "/api/v1/users/me/sessions", tok)
	wantErr(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "too many sign-out-everywhere requests, try again later")
}
