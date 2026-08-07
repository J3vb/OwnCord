package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// newTokenTestDB opens an in-memory DB and applies the real embedded migrations
// (which create api_tokens and seed the default roles).
func newTokenTestDB(t *testing.T) *db.DB {
	t.Helper()
	database := openMemory(t)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return database
}

// seedTokenUser creates a user with the given role and returns its ID.
func seedTokenUser(t *testing.T, database *db.DB, name string, roleID int) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), name, "hash", roleID)
	if err != nil {
		t.Fatalf("CreateUser(%q): %v", name, err)
	}
	return id
}

func TestAPIToken_CreateGetRevoke(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)
	uid := seedTokenUser(t, database, "owner", 1)

	id, err := database.CreateAPIToken(ctx, uid, "hash_active", "ci-bot", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	// Active token resolves.
	tok, err := database.GetActiveAPIToken(ctx, "hash_active")
	if err != nil {
		t.Fatalf("GetActiveAPIToken: %v", err)
	}
	if tok == nil {
		t.Fatal("expected active token, got nil")
	}
	if tok.UserID != uid || tok.Label != "ci-bot" {
		t.Fatalf("unexpected token %+v", tok)
	}

	// After revocation it no longer resolves.
	n, err := database.RevokeAPIToken(ctx, id)
	if err != nil {
		t.Fatalf("RevokeAPIToken: %v", err)
	}
	if n != 1 {
		t.Fatalf("RevokeAPIToken affected %d rows, want 1", n)
	}
	tok, err = database.GetActiveAPIToken(ctx, "hash_active")
	if err != nil {
		t.Fatalf("GetActiveAPIToken after revoke: %v", err)
	}
	if tok != nil {
		t.Fatal("revoked token must not resolve")
	}

	// Revoking again affects no rows.
	if n, _ := database.RevokeAPIToken(ctx, id); n != 0 {
		t.Fatalf("second revoke affected %d rows, want 0", n)
	}
}

func TestAPIToken_Expiry(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)
	uid := seedTokenUser(t, database, "owner", 1)

	pastT := time.Now().Add(-time.Hour)
	futureT := time.Now().Add(time.Hour)

	if _, err := database.CreateAPIToken(ctx, uid, "hash_past", "expired", &pastT); err != nil {
		t.Fatalf("CreateAPIToken past: %v", err)
	}
	if _, err := database.CreateAPIToken(ctx, uid, "hash_future", "valid", &futureT); err != nil {
		t.Fatalf("CreateAPIToken future: %v", err)
	}
	if _, err := database.CreateAPIToken(ctx, uid, "hash_never", "never", nil); err != nil {
		t.Fatalf("CreateAPIToken never: %v", err)
	}

	cases := []struct {
		hash    string
		wantHit bool
	}{
		{"hash_past", false},   // already expired
		{"hash_future", true},  // not yet expired
		{"hash_never", true},   // NULL expiry = never expires
		{"hash_absent", false}, // unknown
	}
	for _, c := range cases {
		tok, err := database.GetActiveAPIToken(ctx, c.hash)
		if err != nil {
			t.Fatalf("GetActiveAPIToken(%q): %v", c.hash, err)
		}
		if got := tok != nil; got != c.wantHit {
			t.Fatalf("GetActiveAPIToken(%q) hit=%v, want %v", c.hash, got, c.wantHit)
		}
	}
}

func TestAPIToken_TouchAndList(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)
	uid := seedTokenUser(t, database, "owner", 1)
	if _, err := database.CreateAPIToken(ctx, uid, "hash_touch", "bot", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	if err := database.TouchAPIToken(ctx, "hash_touch"); err != nil {
		t.Fatalf("TouchAPIToken: %v", err)
	}

	list, err := database.ListAPITokens(ctx)
	if err != nil {
		t.Fatalf("ListAPITokens: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListAPITokens returned %d, want 1", len(list))
	}
	item := list[0]
	if item.Username != "owner" || item.Label != "bot" {
		t.Fatalf("unexpected list item %+v", item)
	}
	if item.LastUsed == nil {
		t.Fatal("Touch should have set last_used_at")
	}
}

func TestAPIToken_RevokeByLabel(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)
	uid := seedTokenUser(t, database, "owner", 1)
	if _, err := database.CreateAPIToken(ctx, uid, "hash_lbl", "mcp", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	n, err := database.RevokeAPITokenByLabel(ctx, "mcp")
	if err != nil {
		t.Fatalf("RevokeAPITokenByLabel: %v", err)
	}
	if n != 1 {
		t.Fatalf("RevokeAPITokenByLabel affected %d rows, want 1", n)
	}
	tok, _ := database.GetActiveAPIToken(ctx, "hash_lbl")
	if tok != nil {
		t.Fatal("label-revoked token must not resolve")
	}
}

func TestGetOwnerUser(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)

	// No users yet → nil, nil.
	u, err := database.GetOwnerUser(ctx)
	if err != nil {
		t.Fatalf("GetOwnerUser (empty): %v", err)
	}
	if u != nil {
		t.Fatalf("GetOwnerUser on empty DB = %+v, want nil", u)
	}

	// Owner (role 1, position 100) outranks a member (role 4) regardless of id order.
	seedTokenUser(t, database, "member", 4)
	ownerID := seedTokenUser(t, database, "owner", 1)

	u, err = database.GetOwnerUser(ctx)
	if err != nil {
		t.Fatalf("GetOwnerUser: %v", err)
	}
	if u == nil || u.ID != ownerID {
		t.Fatalf("GetOwnerUser = %+v, want owner id %d", u, ownerID)
	}
}

// A deleted account is anonymised and permanently banned in place, keeping its
// high-position role row. Without a banned filter that tombstone outranks every
// live admin forever and becomes the default identity for API-token creation,
// minting tokens the auth layer then rejects on every use.
func TestGetOwnerUser_SkipsBannedOwner(t *testing.T) {
	ctx := context.Background()
	database := newTokenTestDB(t)

	bannedOwnerID := seedTokenUser(t, database, "deleted-owner", 1)
	adminID := seedTokenUser(t, database, "live-admin", 2)

	if err := database.BanUser(ctx, bannedOwnerID, "account deleted", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	u, err := database.GetOwnerUser(ctx)
	if err != nil {
		t.Fatalf("GetOwnerUser: %v", err)
	}
	if u == nil {
		t.Fatal("GetOwnerUser = nil, want the live admin")
	}
	if u.ID == bannedOwnerID {
		t.Fatalf("GetOwnerUser returned the banned owner (id %d) — a deleted account must never be the default token identity", u.ID)
	}
	if u.ID != adminID {
		t.Fatalf("GetOwnerUser = id %d, want live admin id %d", u.ID, adminID)
	}
}

// A temporary ban that has already lapsed must not exclude the owner: the query
// mirrors auth.IsEffectivelyBanned, which treats an elapsed ban_expires as not
// banned. Both spellings of ban_expires that the auth layer accepts are covered,
// because ' ' sorts below 'T' and a naive lexical compare reads a same-day
// space-form expiry as lapsed (or, in the other direction, a live ban as lapsed).
func TestGetOwnerUser_LapsedTempBanStaysEligible(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name    string
		expires string
		want    bool // true = owner should still be returned
	}{
		{"lapsed ISO-8601 Z form", time.Now().UTC().Add(-time.Hour).Format("2006-01-02T15:04:05Z"), true},
		{"lapsed space-separated form", time.Now().UTC().Add(-time.Hour).Format("2006-01-02 15:04:05"), true},
		{"live ban, ISO-8601 Z form", time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05Z"), false},
		{"live ban, space-separated form", time.Now().UTC().Add(time.Hour).Format("2006-01-02 15:04:05"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := newTokenTestDB(t)
			ownerID := seedTokenUser(t, database, "owner", 1)
			adminID := seedTokenUser(t, database, "live-admin", 2)

			if _, err := database.ExecContext(ctx,
				`UPDATE users SET banned = 1, ban_expires = ? WHERE id = ?`, tc.expires, ownerID); err != nil {
				t.Fatalf("seed temp ban: %v", err)
			}

			u, err := database.GetOwnerUser(ctx)
			if err != nil {
				t.Fatalf("GetOwnerUser: %v", err)
			}
			if u == nil {
				t.Fatal("GetOwnerUser = nil, want a user")
			}
			if tc.want && u.ID != ownerID {
				t.Fatalf("GetOwnerUser = id %d, want owner id %d (lapsed ban must not exclude)", u.ID, ownerID)
			}
			if !tc.want && u.ID != adminID {
				t.Fatalf("GetOwnerUser = id %d, want admin id %d (live ban must exclude the owner)", u.ID, adminID)
			}
		})
	}
}
