package ws

// Tests for the 2026-08 bughunt-fix wave 2 findings in hub_sweep.go:
// OC-0017 (a voice_join's DB-commit-to-setVoiceState window lets the stale
// sweep delete a row that caught up before the delete ran) and OC-0022
// (CleanupVoiceForChannel's voice_leave fan-out reaches nobody but the
// evicted participants because both production callers archive the channel
// first, and channelReadAudience returns an empty audience for archived
// channels).

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// TestSweepStaleVoiceStates_JoinCatchesUpDuringDeleteWindow pins OC-0017.
//
// voice_join.go commits the voice_states row (JoinVoiceChannelIfCapacity)
// before it calls c.setVoiceState (BUG-088's ordering). If the stale-voice
// sweep's h.clients scan runs in that exact window, it snapshots the joiner
// as a ghost (c.getVoiceChID() is still 0, the row already says otherwise).
// The joiner's c.setVoiceState can then land — narrowing the client's state
// to agree with the very row about to be deleted — before the sweep's delete
// loop reaches that entry. sweepStaleVoiceJoinRaceHook reproduces that
// interleaving deterministically: it fires once per stale entry, at the
// point in the loop where the real race would land.
//
// Before the fix, the sweep deleted the row unconditionally once it was
// snapshotted stale, leaving the client "in voice" in memory with no DB row
// — the one ghost state nothing else heals.
func TestSweepStaleVoiceStates_JoinCatchesUpDuringDeleteWindow(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "sweep-join-race")
	chID := mustCreateVoiceChannel(t, database, "voice-join-race")

	// The row a real voice_join would have committed via
	// JoinVoiceChannelIfCapacity, before its c.setVoiceState call runs.
	if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(ctx, uid)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	c := NewTestClient(h, uid, make(chan []byte, 8))
	h.clients[uid] = c
	// c.voiceChID is still 0 here — exactly like the joiner's client at the
	// instant between JoinVoiceChannelIfCapacity's commit and setVoiceState.

	sweepStaleVoiceJoinRaceHook = func(userID, channelID int64, joinedAt string) {
		if userID == uid {
			// Simulates voiceJoinPersist's c.setVoiceState landing inside
			// the sweep's snapshot-to-delete window.
			c.setVoiceState(channelID, joinedAt)
		}
	}
	defer func() { sweepStaleVoiceJoinRaceHook = nil }()

	h.sweepStaleVoiceStates()

	gotChID, gotToken := c.getVoiceState()
	if gotChID != chID || gotToken != vs.JoinedAt {
		t.Fatalf("client voice state = (%d, %q) after the sweep raced a catching-up join, want (%d, %q) untouched",
			gotChID, gotToken, chID, vs.JoinedAt)
	}
	row, err := database.GetVoiceState(ctx, uid)
	if err != nil {
		t.Fatalf("GetVoiceState after sweep: %v", err)
	}
	if row == nil {
		t.Fatal("sweepStaleVoiceStates deleted a voice_states row whose client caught up before the delete ran — leaving the client in voice in memory with no DB row")
	}
}

// TestCleanupVoiceForChannel_NotifiesReadAudienceOfArchivedChannel pins
// OC-0022.
//
// Both production callers of CleanupVoiceForChannel (admin/handlers_channels.go's
// archive and delete paths, per admin/api_test.go's
// TestAdminAPI_DeleteChannel_ArchivesBeforeVoiceCleanup) commit archived=1 to
// the channel before calling it. channelReadAudience (OC-0073) treats any
// archived channel as invisible to every role and returns an empty audience,
// so CleanupVoiceForChannel's voice_leave broadcast reaches only the evicted
// participants themselves (appended back in by its own loop) — every other
// connected user who could see the channel and its voice roster a moment
// earlier hears nothing, and keeps the departed participants in their client
// voice store indefinitely.
func TestCleanupVoiceForChannel_NotifiesReadAudienceOfArchivedChannel(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	userA := seedHarvestVoiceUser(t, database, "cleanup-audience-a")
	userB := seedHarvestVoiceUser(t, database, "cleanup-audience-b")
	bystander := seedHarvestVoiceUser(t, database, "cleanup-audience-c")
	chID := mustCreateVoiceChannel(t, database, "voice-cleanup-audience")

	if err := database.JoinVoiceChannel(ctx, userA, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(A): %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userB, chID); err != nil {
		t.Fatalf("JoinVoiceChannel(B): %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	cA := NewTestClient(h, userA, make(chan []byte, 8))
	cB := NewTestClient(h, userB, make(chan []byte, 8))
	// bystander has READ_MESSAGES on the channel (harvestVoiceRoleID grants it
	// directly, no override) but is not a voice participant.
	cBystander := NewTestClient(h, bystander, make(chan []byte, 8))
	h.clients[userA] = cA
	h.clients[userB] = cB
	h.clients[bystander] = cBystander
	cA.setVoiceState(chID, "tok-a")
	cB.setVoiceState(chID, "tok-b")

	// Mirrors both production callers: archive before evicting.
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("archive channel: %v", err)
	}
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil || !ch.Archived {
		t.Fatalf("channel not archived before cleanup, GetChannel = %+v, err = %v", ch, err)
	}

	h.CleanupVoiceForChannel(chID)

	recipients := map[int64]int{}
drain:
	for {
		select {
		case bm := <-h.broadcast:
			for _, uid := range bm.recipients {
				recipients[uid]++
			}
		default:
			break drain
		}
	}

	if recipients[bystander] == 0 {
		t.Errorf("bystander with READ_MESSAGES on the channel received no voice_leave broadcast after CleanupVoiceForChannel archived it first; recipients = %v", recipients)
	}
	if recipients[userA] == 0 {
		t.Errorf("evicted participant A missing from its own voice_leave broadcast; recipients = %v", recipients)
	}
	if recipients[userB] == 0 {
		t.Errorf("evicted participant B missing from its own voice_leave broadcast; recipients = %v", recipients)
	}
}
