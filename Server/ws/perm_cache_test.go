package ws_test

// perm_cache_test.go — Phase 2 (ws permission cache) coverage: the ws-side
// permission gates now answer from service.PermissionService. Two invariants
// are locked here:
//  1. A role change performed through the invalidating path (the DB write plus
//     InvalidateUser, exactly what admin/handlers_users.go does) is visible to
//     the very next ws permission check — no cache-TTL wait.
//  2. The cache is actually consulted: a second check for the same user does
//     not re-read the role from the store.

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// voiceJoinRaw builds a raw voice_join envelope for channelID.
func voiceJoinRaw(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID},
	})
	return raw
}

// TestPermCache_RoleChangeInvalidationIsImmediate drives the voice_join
// CONNECT_VOICE gate (a cached ws-side check) before and after a role change
// that mirrors the admin handler: DB write, then InvalidateUser. The demotion
// must take effect on the immediately following check, with no TTL wait.
// LiveKit is deliberately not configured, so a PASSED gate surfaces as
// VOICE_ERROR ("voice is not configured") instead of FORBIDDEN — which lets
// the test observe the gate verdict without a real SFU.
func TestPermCache_RoleChangeInvalidationIsImmediate(t *testing.T) {
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	user := seedMemberUser(t, database, "cache-demote") // Member: has CONNECT_VOICE
	chID := seedTestChannel(t, database, "cache-demote-vc")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	// First join: the gate passes (and populates the user's cache entry); the
	// join then fails on the unconfigured LiveKit, not on permissions.
	hub.HandleMessageForTest(c, voiceJoinRaw(chID))
	if code := receiveErrorCode(send, 300*time.Millisecond); code == "FORBIDDEN" {
		t.Fatalf("member with CONNECT_VOICE was denied the voice_join gate (code %q)", code)
	}

	// Demote through the invalidating path, mirroring admin/handlers_users.go:
	// role write first, then InvalidateUser.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (150, 'cache-novoice', NULL, ?, 5, 0)`,
		permissions.ReadMessages,
	); err != nil {
		t.Fatalf("seed novoice role: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET role_id = 150 WHERE id = ?`, user.ID); err != nil {
		t.Fatalf("reassign user role: %v", err)
	}
	svc.Permissions.InvalidateUser(user.ID)

	// The very next check must see the demoted role — cached entry gone.
	hub.HandleMessageForTest(c, voiceJoinRaw(chID))
	if code := receiveErrorCode(send, 300*time.Millisecond); code != "FORBIDDEN" {
		t.Fatalf("demoted user passed the CONNECT_VOICE gate right after InvalidateUser, got code %q, want FORBIDDEN", code)
	}
}

// countingStore wraps a service.Store and counts GetRoleForUser calls — the
// query every uncached ws-side permission check must issue.
type countingStore struct {
	service.Store
	roleLookups atomic.Int64
}

func (s *countingStore) GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error) {
	s.roleLookups.Add(1)
	return s.Store.GetRoleForUser(ctx, userID)
}

// TestPermCache_SecondCheckServedFromCache proves the ws gates actually use the
// cache: two consecutive voice_join permission checks for the same user issue
// exactly one role lookup against the store — the second is a cache hit.
func TestPermCache_SecondCheckServedFromCache(t *testing.T) {
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	store := &countingStore{Store: database}
	svc := service.New(store, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	user := seedMemberUser(t, database, "cache-hit")
	chID := seedTestChannel(t, database, "cache-hit-vc")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.RegisterNowForTest(c)

	for i := range 2 {
		hub.HandleMessageForTest(c, voiceJoinRaw(chID))
		if code := receiveErrorCode(send, 300*time.Millisecond); code == "FORBIDDEN" {
			t.Fatalf("join %d: member with CONNECT_VOICE was denied the gate", i+1)
		}
	}

	if got := store.roleLookups.Load(); got != 1 {
		t.Fatalf("role lookups through the permission service = %d, want 1 (second check must be a cache hit)", got)
	}
}
