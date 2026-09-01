package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Three transports authenticate the same bearer tokens, and the rule they all
// have to get right is the same one: A DATABASE FAILURE IS NOT A BAD
// CREDENTIAL. The two answers are opposite — a bad credential is terminal (the
// client clears its stored token and stops retrying), an outage is transient
// (back off and try again) — so a service that collapsed them would log every
// user out during a blip and make them sign in again once it passed. Every row
// below exists to keep those two apart.

func sessionFixture(t *testing.T) (*SessionService, *db.DB, context.Context) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "Member", Position: 10})
	return NewSessionService(database), database, context.Background()
}

func seedSessionUser(t *testing.T, database *db.DB, id int64, name string) {
	t.Helper()
	seedUser(t, database, &db.User{ID: id, Username: name})
	seedUserRole(t, database, id, permissions.MemberRoleID)
}

// expireSession backdates a session's expiry so the expiry gate fires.
func expireSession(t *testing.T, database *db.DB, hash string) {
	t.Helper()
	past := time.Now().Add(-time.Hour).UTC().Format("2006-01-02T15:04:05Z")
	if _, err := database.ExecContext(context.Background(),
		`UPDATE sessions SET expires_at = ? WHERE token = ?`, past, hash); err != nil {
		t.Fatalf("expiring the session: %v", err)
	}
}

func TestSessionService_ResolveSocketPrincipalRefusalsAreDistinct(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	seedSessionUser(t, database, 1, "alice")

	// No session row at all.
	if _, err := svc.ResolveSocketPrincipal(ctx, "nothing-here"); !errors.Is(err, ErrSessionInvalid) {
		t.Errorf("unknown token: err = %v, want ErrSessionInvalid", err)
	}

	if _, err := database.CreateSession(ctx, 1, "live-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	user, err := svc.ResolveSocketPrincipal(ctx, "live-hash")
	if err != nil || user == nil || user.ID != 1 {
		t.Fatalf("live session: %+v, %v", user, err)
	}

	// Expired: the row exists, so this must NOT be reported as invalid — the
	// client is told its session expired, which is a different message.
	if _, err := database.CreateSession(ctx, 1, "stale-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	expireSession(t, database, "stale-hash")
	if _, err := svc.ResolveSocketPrincipal(ctx, "stale-hash"); !errors.Is(err, ErrSessionExpired) {
		t.Errorf("expired session: err = %v, want ErrSessionExpired", err)
	}

	// A session whose user row is gone.
	seedSessionUser(t, database, 2, "ghost")
	if _, err := database.CreateSession(ctx, 2, "orphan-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disabling foreign keys: %v", err)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM users WHERE id = 2`); err != nil {
		t.Fatalf("deleting the user: %v", err)
	}
	if _, err := svc.ResolveSocketPrincipal(ctx, "orphan-hash"); !errors.Is(err, ErrPrincipalGone) {
		t.Errorf("orphaned session: err = %v, want ErrPrincipalGone", err)
	}

	// Banned: the only refusal the user may be told the reason for.
	seedSessionUser(t, database, 3, "banned")
	if _, err := database.ExecContext(ctx, `UPDATE users SET banned = 1 WHERE id = 3`); err != nil {
		t.Fatalf("banning: %v", err)
	}
	if _, err := database.CreateSession(ctx, 3, "banned-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.ResolveSocketPrincipal(ctx, "banned-hash"); !errors.Is(err, ErrPrincipalBanned) {
		t.Errorf("banned user: err = %v, want ErrPrincipalBanned", err)
	}
}

// The rule the whole seam exists for: an outage is ErrInternal and NEVER one of
// the four refusals. A transport that saw ErrSessionInvalid here would send a
// non-recoverable auth error, and the client would delete a credential that was
// never revoked.
func TestSessionService_OutageIsNeverABadCredential(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	seedSessionUser(t, database, 1, "alice")
	if _, err := database.CreateSession(ctx, 1, "live-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	_, err := svc.ResolveSocketPrincipal(ctx, "live-hash")
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("resolution during an outage: err = %v, want ErrInternal", err)
	}
	for name, sentinel := range map[string]error{
		"ErrSessionInvalid":  ErrSessionInvalid,
		"ErrSessionExpired":  ErrSessionExpired,
		"ErrPrincipalGone":   ErrPrincipalGone,
		"ErrPrincipalBanned": ErrPrincipalBanned,
	} {
		if errors.Is(err, sentinel) {
			t.Errorf("an outage reported %s — the client would clear a credential that was never revoked", name)
		}
	}
}

func TestSessionService_SweepSessionsClassifies(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	seedSessionUser(t, database, 1, "live")
	seedSessionUser(t, database, 2, "expired")
	seedSessionUser(t, database, 3, "banned")
	for id, hash := range map[int64]string{1: "h-live", 2: "h-expired", 3: "h-banned"} {
		if _, err := database.CreateSession(ctx, id, hash, "web", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession(%d): %v", id, err)
		}
	}
	expireSession(t, database, "h-expired")
	if _, err := database.ExecContext(ctx, `UPDATE users SET banned = 1 WHERE id = 3`); err != nil {
		t.Fatalf("banning: %v", err)
	}

	verdicts, err := svc.SweepSessions(ctx, []string{"h-live", "h-expired", "h-banned", "h-never-existed"})
	if err != nil {
		t.Fatalf("SweepSessions: %v", err)
	}
	want := map[string]SessionVerdict{
		"h-live":          SessionLive,
		"h-expired":       SessionRevoked,
		"h-banned":        SessionBanned,
		"h-never-existed": SessionRevoked,
	}
	for hash, expect := range want {
		if got := verdicts[hash]; got != expect {
			t.Errorf("verdict for %s = %v, want %v", hash, got, expect)
		}
	}
	// Every hash asked about is answered, so a caller indexing the map cannot
	// silently read a zero value for one it forgot to check.
	if len(verdicts) != len(want) {
		t.Errorf("SweepSessions answered %d of %d hashes", len(verdicts), len(want))
	}
}

// A failed batch lookup says nothing about any individual session. Returning a
// map of revocations would turn one transient error into a server-wide
// disconnect, so it must be an error the caller can skip the tick on.
func TestSessionService_SweepSessionsFailsRatherThanRevokingEveryone(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	seedSessionUser(t, database, 1, "alice")
	if _, err := database.CreateSession(ctx, 1, "h-live", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	verdicts, err := svc.SweepSessions(ctx, []string{"h-live"})
	if !errors.Is(err, ErrInternal) {
		t.Errorf("SweepSessions during an outage: err = %v, want ErrInternal", err)
	}
	if verdicts != nil {
		t.Errorf("SweepSessions returned %v alongside an error — a sweep reading that "+
			"map would disconnect every connected client on one bad read", verdicts)
	}
}

// ResolveBearer is the HTTP perimeters' form: a login session first, then an
// API token, so a headless credential reaches the routes its owning user can.
// It passes the auth package's sentinels through rather than restating them.
func TestSessionService_ResolveBearerFallsBackToAPITokens(t *testing.T) {
	svc, database, ctx := sessionFixture(t)
	seedSessionUser(t, database, 1, "alice")

	if _, _, _, err := svc.ResolveBearer(ctx, "nothing"); !errors.Is(err, auth.ErrTokenNotFound) {
		t.Errorf("unknown token: err = %v, want auth.ErrTokenNotFound", err)
	}

	if _, err := database.CreateSession(ctx, 1, "sess-hash", "web", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	user, role, sess, err := svc.ResolveBearer(ctx, "sess-hash")
	if err != nil || user == nil || role == nil || sess == nil {
		t.Fatalf("session principal: user=%+v role=%+v sess=%+v err=%v", user, role, sess, err)
	}

	// An API token resolves the same user, with a nil Session — the signal
	// consumers use to tell a headless principal from an interactive one.
	if _, err := database.CreateAPIToken(ctx, 1, "tok-hash", "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	user, role, sess, err = svc.ResolveBearer(ctx, "tok-hash")
	if err != nil || user == nil || user.ID != 1 || role == nil {
		t.Fatalf("api-token principal: user=%+v role=%+v err=%v", user, role, err)
	}
	if sess != nil {
		t.Errorf("an API-token principal carried a Session (%+v) — consumers use nil to "+
			"tell it apart from an interactive login", sess)
	}

	// An outage is not a bad credential here either: it must not surface as
	// any of the auth sentinels the perimeters answer 401 to.
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	_, _, _, err = svc.ResolveBearer(ctx, "sess-hash")
	if err == nil {
		t.Fatal("ResolveBearer during an outage returned no error")
	}
	for name, sentinel := range map[string]error{
		"auth.ErrTokenNotFound": auth.ErrTokenNotFound,
		"auth.ErrTokenExpired":  auth.ErrTokenExpired,
		"auth.ErrUserNotFound":  auth.ErrUserNotFound,
		"auth.ErrRoleNotFound":  auth.ErrRoleNotFound,
	} {
		if errors.Is(err, sentinel) {
			t.Errorf("an outage reported %s — the perimeter would answer 401 and the "+
				"client would clear a live credential", name)
		}
	}
}
