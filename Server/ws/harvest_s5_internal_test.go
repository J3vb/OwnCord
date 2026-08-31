package ws

// Internal tests for the 2026-08-06 harvest S5 ws findings: channel-scoped
// voice eviction in the revocation sweep, the aborted-switch voice-topic
// restore, voice_camera failing closed on a channel-lookup error, and the
// IsRunning/Start data race in the LiveKit process manager.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// harvestVoiceRoleID is a non-seeded role carrying the voice bits these tests
// exercise, so they do not depend on what the migrations grant the defaults.
const harvestVoiceRoleID = int64(200)

func newHarvestVoiceDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'harvest-voice', NULL, ?, 5, 0)`,
		harvestVoiceRoleID,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.UseVideo,
	); err != nil {
		t.Fatalf("seed harvest-voice role: %v", err)
	}
	return database
}

func seedHarvestVoiceUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	uid, err := database.CreateUser(context.Background(), username, "hash", int(harvestVoiceRoleID))
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	return uid
}

func mustCreateVoiceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	chID, err := database.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel %s: %v", name, err)
	}
	return chID
}

// The revocation sweep snapshots a channel id, runs a DB-backed CONNECT_VOICE
// check on it, and then evicts. A voice_join to a PERMITTED channel B landing
// during that DB round-trip must not be torn down: the eviction has to be
// conditional on the client still being in the channel that was checked — the
// same rule CleanupVoiceForChannel and LeaveVoiceChannelIfMatch already apply.
func TestSweepStaleVoiceStates_EvictionIsScopedToCheckedChannel(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "sweep-race")
	chA := mustCreateVoiceChannel(t, database, "voice-a")
	chB := mustCreateVoiceChannel(t, database, "voice-b")
	// CONNECT_VOICE revoked on A only; B stays permitted.
	if err := database.UpsertChannelOverride(context.Background(), chA, harvestVoiceRoleID, 0, permissions.ConnectVoice); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := NewTestClient(h, uid, make(chan []byte, 2048))
	h.clients[uid] = c

	for i := range 300 {
		c.setVoiceState(chA, "tok-a")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			// Staggered start so, across iterations, the move lands at
			// varying points inside the sweep's permission-check window.
			for range i % 50 {
				runtime.Gosched()
			}
			c.setVoiceState(chB, "tok-b")
		}()
		go func() {
			defer wg.Done()
			h.sweepStaleVoiceStates()
		}()
		wg.Wait()
		if c.getVoiceChID() == 0 {
			t.Fatalf("iteration %d: the sweep evicted the client from channel %d, but the failed CONNECT_VOICE check was for channel %d", i, chB, chA)
		}
	}
}

// When a voice channel switch aborts because the old row's delete failed, the
// abort branch used to restore the in-memory voice state, voice-topic
// subscription and key-holder entry torn down by the leave that preceded it.
// OC-0034: that restore was itself the bug. handleVoiceLeave's
// finishVoiceLeave always broadcasts voice_leave for the old channel to the
// leaver themselves (voice_leave.go), and the client tears its own session
// down on a self voice_leave — so by the time the abort branch runs, every
// client including this user's own has already forgotten the old membership.
// Restoring the server's view of it resurrects a session nobody else
// believes exists, with no re-broadcast to tell them otherwise. The fix
// leaves the client's voice state cleared on abort so it agrees with the
// voice_leave already sent; the periodic sweep reaps the orphaned DB row.
func TestHandleVoiceJoin_AbortedSwitchDoesNotResurrectVoiceTopicSubscription(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "abort-switch")
	chA := mustCreateVoiceChannel(t, database, "voice-a")
	chB := mustCreateVoiceChannel(t, database, "voice-b")

	if err := database.JoinVoiceChannel(ctx, uid, chA); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(ctx, uid)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	t.Cleanup(h.Stop) // ends the background leave retries the blocked delete spawns
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "harvest-key",
		LiveKitAPISecret: "harvest-secret-0123456789abcdef",
		LiveKitURL:       "ws://127.0.0.1:9",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	h.livekit = lk

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	c := NewTestClient(h, uid, make(chan []byte, 64))
	c.user = user
	h.clients[uid] = c
	c.setVoiceState(chA, vs.JoinedAt)
	h.pubsub.Subscribe(c, VoiceTopic(chA))
	h.updateKeyHolder(chA)

	// Fault-inject exactly the leave's DELETE: the row survives, GetVoiceState
	// still finds it, and the switch takes the abort branch.
	if _, err := database.ExecContext(ctx,
		`CREATE TRIGGER harvest_block_voice_delete BEFORE DELETE ON voice_states
		 BEGIN SELECT RAISE(ABORT, 'blocked by test'); END`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}

	h.handleVoiceJoin(ctx, c, json.RawMessage(fmt.Sprintf(`{"channel_id": %d}`, chB)))

	if got := c.getVoiceChID(); got != 0 {
		t.Fatalf("aborted switch resurrected client voice state at channel %d, want 0 — voice_leave for channel %d was already broadcast to this client (OC-0034)", got, chA)
	}
	if h.SubscribedToVoiceTopicForTest(c, chA) {
		t.Error("aborted switch re-subscribed the client to a voice topic for a channel it already received voice_leave for")
	}
	if h.IsVoiceKeyHolder(chA, uid) {
		t.Error("aborted switch left the client named as key holder for a channel it already left")
	}
}

// voice_camera's VoiceMaxVideo gate must fail closed: a channel-lookup error
// is not "no cap configured", and falling through to the unconditional enable
// bypasses the per-channel video limit.
func TestHandleVoiceCameraV2_ChannelLookupErrorFailsClosed(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "camera-err")
	chID := mustCreateVoiceChannel(t, database, "video-room")
	if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Make exactly GetChannel fail; permission and voice-state queries keep
	// working (the role check reads roles/channel_overrides only).
	if _, err := database.ExecContext(ctx, `ALTER TABLE channels RENAME TO channels_offline`); err != nil {
		t.Fatalf("rename channels: %v", err)
	}

	d := VoiceDeps{DB: database, Permissions: permissions.NewChecker(database)}
	res := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: uid, enabled: true}, ClientInfo{UserID: uid, VoiceChannelID: chID}, d)

	if res.Error == nil {
		t.Error("voice_camera returned no error when the VoiceMaxVideo lookup failed — the cap check was silently skipped")
	}
	vs, err := database.GetVoiceState(ctx, uid)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if vs.Camera {
		t.Error("camera was enabled despite the failed VoiceMaxVideo lookup — the handler must fail closed")
	}
}

// RED requires the race detector: IsRunning and Stop read exec.Cmd.Process
// under p.mu, so runLoop must publish that write inside the same critical
// section (Start under p.mu, Wait outside) or the accesses race.
func TestLiveKitProcess_IsRunningWhileStarting_NoRaceOnCmdProcess(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-livekit.sh")
	content := "#!/bin/sh\nsleep 1\n"
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "fake-livekit.bat")
		content = "@ping -n 2 127.0.0.1 > nul\r\n"
	}
	if err := os.WriteFile(script, []byte(content), 0o700); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}

	p := NewLiveKitProcess(&config.VoiceConfig{
		LiveKitAPIKey:    "harvest-key",
		LiveKitAPISecret: "harvest-secret",
		LiveKitURL:       "ws://127.0.0.1:9",
	}, &config.TLSConfig{}, dir)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.runLoop(ctx, filepath.Join(dir, "livekit.yaml"), script)
	}()

	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		p.IsRunning()
	}
	cancel()
	<-done
}
