package ws

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

// TestStartSweep_NeverRunsConcurrentlyWithItself locks the in-flight guard
// shut: while one sweep is still running, further startSweep calls for the
// same guard must be dropped, and once it finishes the next call runs again.
func TestStartSweep_NeverRunsConcurrentlyWithItself(t *testing.T) {
	h := &Hub{}

	var inFlight atomic.Bool
	var active, maxActive, runs atomic.Int64
	release := make(chan struct{})

	sweep := func() {
		cur := active.Add(1)
		if cur > maxActive.Load() {
			maxActive.Store(cur)
		}
		runs.Add(1)
		<-release
		active.Add(-1)
	}

	// First call claims the guard; the sweep blocks on release.
	h.startSweep(&inFlight, sweep)
	// Wait until the goroutine is actually inside the sweep.
	for active.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	// Ticks arriving mid-sweep must be dropped, not stacked.
	for range 5 {
		h.startSweep(&inFlight, sweep)
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("runs = %d while first sweep still in flight, want 1", got)
	}

	close(release)
	for inFlight.Load() {
		time.Sleep(time.Millisecond)
	}

	// Guard released — the next tick runs a fresh sweep.
	done := make(chan struct{})
	h.startSweep(&inFlight, func() { close(done) })
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("sweep did not run after the previous one finished")
	}

	if got := maxActive.Load(); got != 1 {
		t.Fatalf("max concurrent sweeps = %d, want 1", got)
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("blocking sweep ran %d times, want 1", got)
	}
}

// Every kick path (the sweeps, the handlers.go expiry/ban kicks, DisconnectUser)
// deletes the hub entry via kickClient, so the readPump defer's unregisterNow
// finds nothing. "Absent" is a real disconnect, not a replacement: reporting it
// as replaced makes readPump skip MarkUserDisconnected, the offline presence
// broadcast, and handleVoiceLeave, so peers keep rendering the kicked user
// online.
func TestUnregisterNow_KickedClientIsNotReportedAsReplaced(t *testing.T) {
	h := newEmitTestHub()
	c := NewTestClient(h, 1, make(chan []byte, 4))
	h.clients[1] = c

	h.kickClient(c)

	if replaced := h.unregisterNow(c); replaced {
		t.Error("unregisterNow(kicked client) = true (replaced), want false (real disconnect)")
	}
}

// The genuine replacement case must keep reporting true, so a reconnect's
// teardown does not mark the live connection's user offline.
func TestUnregisterNow_ReplacedClientIsReportedAsReplaced(t *testing.T) {
	h := newEmitTestHub()
	old := NewTestClient(h, 1, make(chan []byte, 4))
	live := NewTestClient(h, 1, make(chan []byte, 4))
	h.clients[1] = live // the reconnect already took the slot

	if replaced := h.unregisterNow(old); !replaced {
		t.Error("unregisterNow(old client) = false, want true (a live client holds the slot)")
	}
	if _, ok := h.clients[1]; !ok {
		t.Error("unregisterNow(old client) evicted the live client from the hub")
	}
}

// TestSweepStaleVoiceStates_TransientPermissionErrorDoesNotEvict locks the
// fail-open-on-error behavior sweepStaleVoiceStates must have: a DB read
// failure on the CONNECT_VOICE check (as opposed to a genuine revocation) must
// leave the client in voice, mirroring sweepRevokedSessions' own guard against
// treating a transient batch-lookup error as a mass disconnect. Before the
// fix, hasChannelPerm collapsed any GetChannelPermissions error to "denied",
// so a read-path fault alone evicted every in-voice participant.
func TestSweepStaleVoiceStates_TransientPermissionErrorDoesNotEvict(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "sweep-transient-err")
	chID := mustCreateVoiceChannel(t, database, "voice-transient-err")
	if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	c := NewTestClient(h, uid, make(chan []byte, 8))
	c.setVoiceState(chID, "tok")
	h.clients[uid] = c

	// Fault-inject exactly the permission read: harvestVoiceRoleID grants
	// CONNECT_VOICE directly on the role, so hasChannelPermChecked must reach
	// GetChannelPermissions (channel_overrides) before it can resolve —
	// nobody's permissions actually changed.
	if _, err := database.ExecContext(ctx, `ALTER TABLE channel_overrides RENAME TO channel_overrides_offline`); err != nil {
		t.Fatalf("rename channel_overrides: %v", err)
	}

	h.sweepStaleVoiceStates()

	if got := c.getVoiceChID(); got != chID {
		t.Fatalf("client voice channel = %d after a transient permission-read error, want it to stay at %d (not evicted)", got, chID)
	}
	vs, err := database.GetVoiceState(ctx, uid)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if vs == nil {
		t.Error("voice_states row was deleted after a transient permission-read error, want it to survive")
	}
}

// TestSweepStaleVoiceStates_GhostRemovalReelectsKeyHolder locks the sweep's
// ghost-row branch into re-electing the key holder, matching every sibling
// removal path (finishVoiceLeave, the LiveKit webhook, registerNow,
// handleVoiceJoin). Before the fix, the ghost branch deleted the row and
// broadcast voice_leave without calling updateKeyHolder, so a departed user
// stripped out here while still named as key holder left the remaining
// participant self-promoting and rotating the room key locally, with its
// voice_e2ee_offers rejected as NOT_KEY_HOLDER.
func TestSweepStaleVoiceStates_GhostRemovalReelectsKeyHolder(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	// Ghost has the lower userID, so it would win election if it were still a
	// candidate — the test only proves anything if survivor isn't already the
	// answer regardless of re-election.
	ghostUID := seedHarvestVoiceUser(t, database, "sweep-ghost-holder-a")
	survivorUID := seedHarvestVoiceUser(t, database, "sweep-ghost-holder-b")
	if ghostUID > survivorUID {
		t.Fatalf("test setup assumes ghostUID (%d) < survivorUID (%d)", ghostUID, survivorUID)
	}
	chID := mustCreateVoiceChannel(t, database, "voice-ghost-holder")

	// Ghost: a real voice_states row, but no connected client — the exact
	// state sweepStaleVoiceStates' second loop treats as a ghost.
	if err := database.JoinVoiceChannel(ctx, ghostUID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(ghost): %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	survivor := NewTestClient(h, survivorUID, make(chan []byte, 8))
	survivor.setVoiceState(chID, "tok-survivor")
	h.clients[survivorUID] = survivor

	// Simulate the stale-holder precondition from the finding: the ghost is
	// still recorded as key holder (e.g. from before it dropped out of
	// h.clients), and the survivor has not yet been elected.
	h.keyHolderMu.Lock()
	h.voiceKeyHolders[chID] = ghostUID
	h.keyHolderMu.Unlock()

	h.sweepStaleVoiceStates()

	if h.IsVoiceKeyHolder(chID, ghostUID) {
		t.Error("ghost user is still recorded as key holder after the sweep removed its ghost voice state")
	}
	if !h.IsVoiceKeyHolder(chID, survivorUID) {
		t.Error("surviving participant was not re-elected key holder after the sweep removed the ghost")
	}
	vs, err := database.GetVoiceState(ctx, ghostUID)
	if err != nil {
		t.Fatalf("GetVoiceState(ghost): %v", err)
	}
	if vs != nil {
		t.Error("ghost voice_states row was not removed by the sweep")
	}
}
