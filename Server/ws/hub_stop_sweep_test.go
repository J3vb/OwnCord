package ws_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── GracefulStop ─────────────────────────────────────────────────────────────

func TestHub_GracefulStop_StopsHub(t *testing.T) {
	hub, _ := newTestHub(t)
	done := make(chan struct{})
	go func() {
		hub.Run()
		close(done)
	}()
	waitFor(t, waitTimeout, hub.RunningForTest, "hub Run loop to start")

	hub.GracefulStop()

	select {
	case <-done:
		// ok — hub stopped
	case <-time.After(2 * time.Second):
		t.Error("hub.Run() did not stop after GracefulStop()")
	}
}

func TestHub_GracefulStop_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	// Must not panic with no LiveKit process.
	hub.GracefulStop()
}

func TestHub_GracefulStop_Idempotent(t *testing.T) {
	// BUG-087: GracefulStop must be safe to call concurrently/twice.
	// Without sync.Once protection, double lkProcess.Stop() can panic.
	hub, _ := newTestHub(t)
	go hub.Run()

	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			hub.GracefulStop()
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		// Success: no panic from concurrent GracefulStop.
	case <-time.After(15 * time.Second):
		t.Fatal("concurrent GracefulStop calls deadlocked")
	}
}

// ─── CleanupVoiceForChannel ───────────────────────────────────────────────────

func TestHub_CleanupVoiceForChannel_NoVoiceState_NoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	// Must not panic when channel has no voice state in DB.
	hub.CleanupVoiceForChannel(9999)
}

// TestHub_Register_CleansUpOldVoiceState was removed because duplicate
// logins are now rejected at the WebSocket handshake level (commit 00bbb46)
// before hub.Register is called. The hub's register case simply overwrites
// the client map entry; voice cleanup for disconnects is handled by
// handleVoiceLeave called from readPump/ICE monitor.

// ─── sweepStaleClients ──────────────────────────────────────────────────────

func TestHub_SweepStaleClients_RemovesInactiveClients(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "stale-alice")
	u2 := seedTestUser(t, database, "fresh-bob")

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1)
	c2 := ws.NewTestClient(hub, u2, s2)

	hub.Register(c1)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	ws.SetClientLastActivityForTest(c1, time.Now().Add(-2*time.Minute))
	ws.SetClientLastActivityForTest(c2, time.Now())

	// sweepStaleClients kicks synchronously (kickClient) — no wait needed.
	hub.SweepStaleClientsForTest()

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after sweep, want 1", hub.ClientCount())
	}
	if hub.ClientForTest(u1) != nil {
		t.Error("stale client should have been removed")
	}
	if hub.ClientForTest(u2) == nil {
		t.Error("fresh client should still be present")
	}
}

func TestHub_SweepStaleClients_NoClientsNoPanic(t *testing.T) {
	hub, _ := newTestHub(t)
	hub.SweepStaleClientsForTest()
}

func TestHub_SweepStaleClients_AllFresh(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	u1 := seedTestUser(t, database, "fresh-carol")
	s1 := make(chan []byte, 4)
	c1 := ws.NewTestClient(hub, u1, s1)
	hub.Register(c1)
	waitRegistered(t, hub, c1)

	ws.SetClientLastActivityForTest(c1, time.Now())
	// sweepStaleClients kicks synchronously — its effects are visible on return.
	hub.SweepStaleClientsForTest()

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after sweep of fresh clients, want 1", hub.ClientCount())
	}
}

// ─── Session sweep (BUG-109) ──────────────────────────────────────────────

// TestHub_SweepRevokedSessions_KicksRevokedClient verifies that the periodic
// session sweep disconnects clients whose sessions have been deleted from the
// database (e.g. after logout on another device).
func TestHub_SweepRevokedSessions_KicksRevokedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	// Create two users with sessions.
	uid1 := mustCreateUser(t, database, "alice-revoke", 3)
	uid2 := mustCreateUser(t, database, "bob-valid", 3)

	u1, _ := database.GetUserByID(context.Background(), uid1)
	u2, _ := database.GetUserByID(context.Background(), uid2)

	token1 := "revoke-token-1"
	token2 := "valid-token-2"
	hash1 := auth.HashToken(token1)
	hash2 := auth.HashToken(token2)

	if _, err := database.CreateSession(context.Background(), uid1, hash1, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 1: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid2, hash2, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession 2: %v", err)
	}

	s1 := make(chan []byte, 4)
	s2 := make(chan []byte, 4)
	c1 := ws.NewTestClientWithTokenHash(hub, u1, hash1, 0, s1)
	c2 := ws.NewTestClientWithTokenHash(hub, u2, hash2, 0, s2)

	hub.Register(c1)
	hub.Register(c2)
	waitRegistered(t, hub, c2)

	// Delete alice's session (simulating logout from another device).
	if err := database.DeleteSession(context.Background(), hash1); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	// Run the session sweep — it kicks synchronously (kickClient).
	hub.SweepRevokedSessionsForTest()

	// Alice should be kicked, Bob should remain.
	if hub.ClientForTest(uid1) != nil {
		t.Error("revoked client alice should have been kicked")
	}
	if hub.ClientForTest(uid2) == nil {
		t.Error("valid client bob should still be connected")
	}
	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1", hub.ClientCount())
	}
}

// TestHub_SweepRevokedSessions_KicksBannedClient verifies the sweep's batched
// session lookup carries ban status through: a client whose user was banned
// after connecting is disconnected even though its session row still exists.
func TestHub_SweepRevokedSessions_KicksBannedClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	uid := mustCreateUser(t, database, "soon-banned", 3)
	u, _ := database.GetUserByID(context.Background(), uid)

	hash := auth.HashToken("ban-sweep-token")
	if _, err := database.CreateSession(context.Background(), uid, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	s := make(chan []byte, 4)
	c := ws.NewTestClientWithTokenHash(hub, u, hash, 0, s)
	hub.Register(c)
	waitRegistered(t, hub, c)

	if err := database.BanUser(context.Background(), uid, "rule violation", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	hub.SweepRevokedSessionsForTest()

	if hub.ClientForTest(uid) != nil {
		t.Error("banned client should have been kicked by the session sweep")
	}
}

// TestHub_SweepRevokedSessions_NoDBNoPanic verifies the sweep is a no-op
// when the hub has no database (nil-safe).
func TestHub_SweepRevokedSessions_NoDBNoPanic(t *testing.T) {
	hub := ws.NewHubForTest()
	hub.SweepRevokedSessionsForTest() // should not panic
}

// TestHub_SweepRevokedSessions_EmptyTokenHashSkipped verifies that clients
// without a token hash (e.g. test clients) are not kicked by the sweep.
func TestHub_SweepRevokedSessions_EmptyTokenHashSkipped(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	uid := seedTestUser(t, database, "no-hash-user")
	s := make(chan []byte, 4)
	c := ws.NewTestClient(hub, uid, s)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.SweepRevokedSessionsForTest()

	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d, want 1 (client without token hash should survive)", hub.ClientCount())
	}
}

// ─── LiveKitHealthCheck ─────────────────────────────────────────────────────

func TestHub_LiveKitHealthCheck_NilReturnsError(t *testing.T) {
	hub, _ := newTestHub(t)
	ok, err := hub.LiveKitHealthCheck(context.Background())
	if ok {
		t.Error("expected ok=false when LiveKit is nil")
	}
	if err == nil {
		t.Error("expected non-nil error when LiveKit is nil")
	}
}

// ─── LiveKitProcess option ──────────────────────────────────────────────────

// TestHub_LiveKitProcessRequiresClient pins B3-4's coherence rule: a
// supervised process without a client is refused at construction — it used
// to be a silently accepted setter call on a hub that could sign no tokens.
func TestHub_LiveKitProcessRequiresClient(t *testing.T) {
	database := openTestDB(t)
	_, err := ws.NewHub(ws.HubOptions{
		DB:             database,
		Limiter:        auth.NewRateLimiter(),
		LiveKitProcess: &livekitproc.Process{},
	})
	if err == nil {
		t.Fatal("NewHub must refuse LiveKitProcess without LiveKit")
	}
}

// ─── VoiceSessionCount ─────────────────────────────────────────────────────

func TestHub_VoiceSessionCount(t *testing.T) {
	tests := []struct {
		name      string
		voiceChs  []int64
		wantCount int
	}{
		{"no clients", nil, 0},
		{"all in voice", []int64{100, 200, 300}, 3},
		{"none in voice", []int64{0, 0}, 0},
		{"mixed", []int64{100, 0, 200, 0}, 2},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			hub, database := newTestHub(t)
			go hub.Run()
			defer hub.Stop()

			for i, vch := range tc.voiceChs {
				username := fmt.Sprintf("voice-%s-%d", tc.name, i)
				uid := seedTestUser(t, database, username)
				send := make(chan []byte, 4)
				c := ws.NewTestClient(hub, uid, send)
				if vch != 0 {
					ws.SetClientVoiceChID(c, vch)
				}
				hub.Register(c)
				waitRegistered(t, hub, c)
			}

			got := hub.VoiceSessionCount()
			if got != tc.wantCount {
				t.Errorf("VoiceSessionCount() = %d, want %d", got, tc.wantCount)
			}
		})
	}
}
