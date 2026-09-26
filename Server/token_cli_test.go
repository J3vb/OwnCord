package main

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// The two B4-12(d) findings at the CLI's edge: a negative --expires must not
// mint a permanent token (OC-0340) and a numeric label must be revocable
// (OC-0341). The subcommands are exercised directly with the TokenService
// they adapt, over an in-memory database with the migrations' seeded roles.

func tokenCLIFixture(t *testing.T) (*service.TokenService, *db.DB, context.Context) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	ctx := context.Background()
	// Role 1 is the seeded Owner: Bind("") needs an owner-class account.
	if _, err := database.CreateUser(ctx, "owner", "hash", 1); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	return service.NewTokenService(database), database, ctx
}

func activeLabels(t *testing.T, tokens *service.TokenService, ctx context.Context) map[string]bool {
	t.Helper()
	list, err := tokens.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	active := map[string]bool{}
	for _, tok := range list {
		if tok.RevokedAt == nil || *tok.RevokedAt == "" {
			active[tok.Label] = true
		}
	}
	return active
}

func TestTokenCreate_NegativeExpiryIsRefused(t *testing.T) {
	tokens, _, ctx := tokenCLIFixture(t)

	if code := tokenCreate(ctx, tokens, []string{"--label", "ci", "--expires", "-1h"}); code != 2 {
		t.Fatalf("token create --expires -1h exited %d, want 2 (refused as bad input)", code)
	}
	if active := activeLabels(t, tokens, ctx); len(active) != 0 {
		t.Fatalf("a token was minted for a negative expiry: %v", active)
	}

	// The documented "0 = never" and a positive window still mint.
	if code := tokenCreate(ctx, tokens, []string{"--label", "forever"}); code != 0 {
		t.Fatalf("token create with no expiry exited %d, want 0", code)
	}
	if code := tokenCreate(ctx, tokens, []string{"--label", "bounded", "--expires", "1h"}); code != 0 {
		t.Fatalf("token create --expires 1h exited %d, want 0", code)
	}
}

func TestTokenRevoke_NumericLabelFallsThroughToLabel(t *testing.T) {
	tokens, _, ctx := tokenCLIFixture(t)

	first, err := tokens.Create(ctx, service.ActorSelf, "", "release", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := tokens.Create(ctx, service.ActorSelf, "", "2024", 0); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// No token has id 2024, so the all-digit argument is the label.
	if code := tokenRevoke(ctx, tokens, []string{"2024"}); code != 0 {
		t.Fatalf("token revoke 2024 exited %d, want 0", code)
	}
	active := activeLabels(t, tokens, ctx)
	if active["2024"] || !active["release"] {
		t.Fatalf("after revoking the numeric label, active = %v; want only release", active)
	}

	// The id keeps precedence: a token whose id matches goes first, and once
	// it is gone the same argument reaches the label branch.
	if _, err := tokens.Create(ctx, service.ActorSelf, "", "1", 0); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if code := tokenRevoke(ctx, tokens, []string{"1"}); code != 0 {
		t.Fatalf("token revoke 1 (id precedence) exited %d, want 0", code)
	}
	active = activeLabels(t, tokens, ctx)
	if active["release"] || !active["1"] {
		t.Fatalf("id precedence: active = %v; want token #%d (release) gone and label \"1\" still active", active, first.ID)
	}
	if code := tokenRevoke(ctx, tokens, []string{"1"}); code != 0 {
		t.Fatalf("token revoke 1 (label fallback) exited %d, want 0", code)
	}
	if active := activeLabels(t, tokens, ctx); active["1"] {
		t.Fatalf("label \"1\" survived the fallback: %v", active)
	}

	// Nothing left to match either way is still reported as such.
	if code := tokenRevoke(ctx, tokens, []string{"1"}); code != 1 {
		t.Fatalf("token revoke 1 with nothing active exited %d, want 1", code)
	}
}
