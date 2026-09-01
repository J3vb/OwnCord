package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// API-token minting used to live twice — in the admin panel's routes and in
// `server token …`, the bootstrap CLI. The copies had already drifted (only
// the CLI could revoke by label; the two attributed audit rows differently),
// which is the failure mode these rows are really about: each pins a rule that
// now has exactly one implementation for both callers.

func tokenFixture(t *testing.T) (*TokenService, *db.DB, context.Context) {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{ID: permissions.OwnerRoleID, Name: "Owner", Position: permissions.OwnerRolePosition})
	seedRole(t, database, &db.Role{ID: permissions.MemberRoleID, Name: "Member", Position: 10})
	return NewTokenService(database), database, context.Background()
}

func seedTokenUser(t *testing.T, database *db.DB, id int64, username string, roleID int64) {
	t.Helper()
	seedUser(t, database, &db.User{ID: id, Username: username})
	seedUserRole(t, database, id, roleID)
}

// Bind's two refusals are different on purpose: "no such user" and "there is
// no owner yet" send an operator to different remedies, and the CLI has always
// printed different messages for them.
func TestTokenService_BindSeparatesMissingUserFromMissingOwner(t *testing.T) {
	svc, database, ctx := tokenFixture(t)

	// No users at all: the bootstrap case.
	if _, err := svc.Bind(ctx, ""); !errors.Is(err, ErrNoOwnerAccount) {
		t.Errorf("Bind(\"\") with no users: err = %v, want ErrNoOwnerAccount", err)
	}
	if _, err := svc.Bind(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Bind(\"nobody\"): err = %v, want ErrNotFound", err)
	}

	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)
	seedTokenUser(t, database, 2, "member", permissions.MemberRoleID)

	owner, err := svc.Bind(ctx, "")
	if err != nil || owner == nil || owner.Username != "owner" {
		t.Fatalf("Bind(\"\") = %+v, %v; want the owner account", owner, err)
	}
	named, err := svc.Bind(ctx, "member")
	if err != nil || named == nil || named.Username != "member" {
		t.Fatalf("Bind(\"member\") = %+v, %v", named, err)
	}
	// A named user who does not exist stays ErrNotFound even once an owner
	// does — the fallback is only for an empty username.
	if _, err := svc.Bind(ctx, "ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Bind(\"ghost\") with an owner present: err = %v, want ErrNotFound", err)
	}
}

func TestTokenService_CreateStoresOnlyTheHash(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)

	minted, err := svc.Create(ctx, 1, "", "ci-bot", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if minted.Raw == "" || minted.User.Username != "owner" || minted.Label != "ci-bot" {
		t.Fatalf("Create returned %+v", minted)
	}

	// The raw token is shown once and never stored — only its hash is, so the
	// row must not carry anything that could reconstruct it.
	var stored string
	row := database.QueryRowContext(ctx, `SELECT token_hash FROM api_tokens WHERE id = ?`, minted.ID)
	if err := row.Scan(&stored); err != nil {
		t.Fatalf("reading the stored token: %v", err)
	}
	if stored != auth.HashToken(minted.Raw) {
		t.Errorf("stored value is not the hash of the raw token")
	}
	if strings.Contains(stored, minted.Raw) {
		t.Errorf("the raw token is recoverable from the stored row")
	}

	// lifetime 0 is "never expires" — both callers' default.
	var expires *string
	if err := database.QueryRowContext(ctx, `SELECT expires_at FROM api_tokens WHERE id = ?`, minted.ID).Scan(&expires); err != nil {
		t.Fatalf("reading expires_at: %v", err)
	}
	if expires != nil && *expires != "" {
		t.Errorf("expires_at = %q for a zero lifetime, want never", *expires)
	}
}

func TestTokenService_CreateRefusesUnusableInput(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)

	// A blank label is refused because the label is how a token is found again
	// — in `list`, and in revoke-by-label. An unlabelled token is unfindable.
	for _, label := range []string{"", "   ", "\t\n"} {
		if _, err := svc.Create(ctx, 1, "", label, 0); !errors.Is(err, ErrBadRequest) {
			t.Errorf("Create(label=%q): err = %v, want ErrBadRequest", label, err)
		}
	}

	// Over the cap is refused, not clamped: a caller asking for a century has
	// a bug, and silently minting a 10-year credential instead would hide it.
	// (A century is as far as this can go — time.Duration itself tops out
	// around 292 years, which is why the cap is a policy bound rather than an
	// overflow guard; see maxTokenLifetime.)
	if _, err := svc.Create(ctx, 1, "", "far-future", 100*365*24*time.Hour); !errors.Is(err, ErrBadRequest) {
		t.Errorf("Create with an over-cap lifetime: err = %v, want ErrBadRequest", err)
	}
	// Exactly at the cap is allowed.
	if _, err := svc.Create(ctx, 1, "", "at-cap", maxTokenLifetime); err != nil {
		t.Errorf("Create at exactly the cap: %v", err)
	}

	// Nothing is written for any refusal.
	list, err := svc.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].Label != "at-cap" {
		t.Errorf("refused mints left rows behind: %+v", list)
	}
}

// Revoking twice is not two successes: the second call finds no ACTIVE token
// and says so, which is what stops a script from reporting a revoke it did not
// perform.
func TestTokenService_RevokeIsNotIdempotentlySilent(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)
	minted, err := svc.Create(ctx, 1, "", "one", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := svc.Revoke(ctx, 1, minted.ID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := svc.Revoke(ctx, 1, minted.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Revoke: err = %v, want ErrNotFound", err)
	}
	if err := svc.Revoke(ctx, 1, 999); !errors.Is(err, ErrNotFound) {
		t.Errorf("Revoke of an unknown id: err = %v, want ErrNotFound", err)
	}
}

// RevokeByLabel takes every match. Labels are not unique, and an operator
// revoking a compromised credential by the name they typed must not be left
// with a duplicate still live.
func TestTokenService_RevokeByLabelTakesEveryMatch(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)
	for range 3 {
		if _, err := svc.Create(ctx, 1, "", "deploy", 0); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	if _, err := svc.Create(ctx, 1, "", "keep-me", 0); err != nil {
		t.Fatalf("Create: %v", err)
	}

	affected, err := svc.RevokeByLabel(ctx, 1, "deploy")
	if err != nil {
		t.Fatalf("RevokeByLabel: %v", err)
	}
	if affected != 3 {
		t.Errorf("RevokeByLabel revoked %d, want 3 — a duplicate left active is the one that matters", affected)
	}
	if _, err := svc.RevokeByLabel(ctx, 1, "deploy"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second RevokeByLabel: err = %v, want ErrNotFound", err)
	}
	if _, err := svc.RevokeByLabel(ctx, 1, "never-used"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RevokeByLabel of an unused label: err = %v, want ErrNotFound", err)
	}

	// The unrelated token is untouched.
	list, err := svc.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	live := 0
	for _, tok := range list {
		if tok.RevokedAt == nil || *tok.RevokedAt == "" {
			live++
			if tok.Label != "keep-me" {
				t.Errorf("a token labelled %q survived a revoke of \"deploy\"", tok.Label)
			}
		}
	}
	if live != 1 {
		t.Errorf("%d tokens still live, want 1", live)
	}
}

func TestTokenService_FailsLoud(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := svc.List(ctx); !errors.Is(err, ErrInternal) {
		t.Errorf("List on a closed database: err = %v, want ErrInternal", err)
	}
	if _, err := svc.Bind(ctx, ""); !errors.Is(err, ErrInternal) {
		t.Errorf("Bind on a closed database: err = %v, want ErrInternal — a lookup "+
			"failure must not be reported as \"no owner exists\", which would send "+
			"an operator to create a second owner account", err)
	}
	if _, err := svc.Create(ctx, 1, "", "x", 0); !errors.Is(err, ErrInternal) {
		t.Errorf("Create on a closed database: err = %v, want ErrInternal", err)
	}
	if err := svc.Revoke(ctx, 1, 1); !errors.Is(err, ErrInternal) {
		t.Errorf("Revoke on a closed database: err = %v, want ErrInternal", err)
	}
	if _, err := svc.RevokeByLabel(ctx, 1, "x"); !errors.Is(err, ErrInternal) {
		t.Errorf("RevokeByLabel on a closed database: err = %v, want ErrInternal", err)
	}
}

// The CLI has no authenticated operator, so it attributes a mint to the token's
// own bound user. ActorSelf is a named value rather than a bare 0 because 0 is
// a real actor id in the audit vocabulary ("the system") and a mint is not a
// system action — recording one as unattributed loses who the token was for.
func TestTokenService_ActorSelfAttributesToTheBoundUser(t *testing.T) {
	svc, database, ctx := tokenFixture(t)
	seedTokenUser(t, database, 1, "owner", permissions.OwnerRoleID)
	seedTokenUser(t, database, 2, "ci-account", permissions.MemberRoleID)

	minted, err := svc.Create(ctx, ActorSelf, "ci-account", "ci-bot", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	var actor int64
	if err := database.QueryRowContext(ctx,
		`SELECT actor_id FROM audit_log WHERE action = 'api_token_create' AND target_id = ?`,
		minted.ID).Scan(&actor); err != nil {
		t.Fatalf("reading the audit row: %v", err)
	}
	if actor != minted.User.ID {
		t.Errorf("audit actor_id = %d, want %d (the bound user) — recording 0 loses "+
			"who the token was created for", actor, minted.User.ID)
	}

	// An explicit actor is recorded verbatim: the panel has a real operator.
	panelMint, err := svc.Create(ctx, 1, "ci-account", "panel-made", 0)
	if err != nil {
		t.Fatalf("Create (panel): %v", err)
	}
	if err := database.QueryRowContext(ctx,
		`SELECT actor_id FROM audit_log WHERE action = 'api_token_create' AND target_id = ?`,
		panelMint.ID).Scan(&actor); err != nil {
		t.Fatalf("reading the audit row: %v", err)
	}
	if actor != 1 {
		t.Errorf("audit actor_id = %d, want 1 — an explicit actor must not be rewritten", actor)
	}
}
