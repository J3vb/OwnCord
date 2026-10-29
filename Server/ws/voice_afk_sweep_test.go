package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── presence idle stamp ────────────────────────────────────────────────────

func TestLivePresence_IdleSinceKeptAcrossCustomStatusAndExpiry(t *testing.T) {
	t0 := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	t1 := t0.Add(7 * time.Minute)
	old := afkNow
	t.Cleanup(func() { afkNow = old })

	const tag = "2026-10-20T10:00:00Z"
	c := &Client{userID: 7, send: make(chan []byte, 16)}
	h := newExpiryHub(c)

	afkNow = func() time.Time { return t0 }
	c.setLivePresence(db.StatusIdle, nil, "")
	if got := c.livePresence().idleSince; !got.Equal(t0) {
		t.Fatalf("entering idle stamped %v, want %v", got, t0)
	}

	// A custom-status change while idle keeps the stamp.
	afkNow = func() time.Time { return t1 }
	text := "brb"
	c.setLivePresence(db.StatusIdle, &text, tag)
	if got := c.livePresence().idleSince; !got.Equal(t0) {
		t.Fatalf("custom status change moved idleSince to %v, want %v", got, t0)
	}

	// So does the expiry that clears that status.
	h.CustomStatusExpired(7, tag)
	p := c.livePresence()
	if p.customStatus != nil || !p.idleSince.Equal(t0) {
		t.Fatalf("after expiry: %+v, want text cleared and idleSince %v", p, t0)
	}

	// Leaving idle zeroes it; the next idle stretch starts fresh.
	c.setLivePresence(db.StatusOnline, nil, "")
	if got := c.livePresence().idleSince; !got.IsZero() {
		t.Fatalf("online kept idleSince %v", got)
	}
	c.setLivePresence(db.StatusIdle, nil, "")
	if got := c.livePresence().idleSince; !got.Equal(t1) {
		t.Fatalf("re-entering idle stamped %v, want %v", got, t1)
	}
}

func TestBuildVoiceMoved_ModeratorBytesUnchanged(t *testing.T) {
	const want = `{"type":"voice_moved","payload":{"to_channel_id":5}}`
	if got := string(buildVoiceMoved(5, "", 0)); got != want {
		t.Fatalf("moderator voice_moved = %s, want %s", got, want)
	}
	const wantAFK = `{"type":"voice_moved","payload":{"to_channel_id":5,"reason":"afk"}}`
	if got := string(buildVoiceMoved(5, voiceMovedReasonAFK, 0)); got != wantAFK {
		t.Fatalf("afk voice_moved = %s, want %s", got, wantAFK)
	}
	// A moderator move names the mover (WP 8.4b); the AFK sweep names nobody.
	const wantBy = `{"type":"voice_moved","payload":{"to_channel_id":5,"by_user_id":9}}`
	if got := string(buildVoiceMoved(5, "", 9)); got != wantBy {
		t.Fatalf("moderator voice_moved with mover = %s, want %s", got, wantBy)
	}
}

// ─── the sweep ──────────────────────────────────────────────────────────────

// afkRig is a voice harness with an AFK channel and two ordinary ones.
type afkRig struct {
	*vmHarness
	afk, room, other int64
}

func newAFKRig(t *testing.T, n int) *afkRig {
	t.Helper()
	h := newVMHarness(t, n)
	r := &afkRig{vmHarness: h, room: h.chanOf("lounge"), other: h.chanOf("other"), afk: h.chanOf("afk")}
	if _, err := h.db.SetAFKChannel(context.Background(), &r.afk); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { afkSweepSnapshotHook = nil; afkAfterEvictHook = nil })
	return r
}

// seat connects m and joins it to chID.
func (r *afkRig) seat(m *vmMember, chID int64) {
	r.t.Helper()
	r.connect(m)
	if !r.join(m, chID) {
		r.t.Fatalf("%s did not join ch%d", m.name, chID)
	}
}

// idle marks m idle for the given duration.
func (r *afkRig) idle(m *vmMember, d time.Duration) {
	m.c.presence.Store(&livePresence{status: db.StatusIdle, idleSince: time.Now().Add(-d)})
}

// stashed reports whether c holds a moderator-flag stash (consuming it).
func stashed(c *Client) bool {
	muted, deafened, _ := c.voice.takeModFlags()
	return muted || deafened
}

func (r *afkRig) sweep() { r.hub.sweepAFK(context.Background()) }

type movedFrame struct {
	to     int64
	reason string
}

// moved drains m's queue and returns every voice_moved it holds.
func (r *afkRig) moved(m *vmMember) []movedFrame { return drainMoved(m.c) }

func drainMoved(c *Client) []movedFrame {
	var out []movedFrame
	for {
		select {
		case raw := <-c.send:
			var f struct {
				Type    string `json:"type"`
				Payload struct {
					To     int64  `json:"to_channel_id"`
					Reason string `json:"reason"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &f) == nil && f.Type == "voice_moved" {
				out = append(out, movedFrame{f.Payload.To, f.Payload.Reason})
			}
		default:
			return out
		}
	}
}

func (r *afkRig) rowChannel(m *vmMember) int64 {
	r.t.Helper()
	row, err := r.db.GetVoiceState(context.Background(), m.userID)
	if err != nil {
		r.t.Fatal(err)
	}
	if row == nil {
		return 0
	}
	return row.ChannelID
}

func TestSweepAFK_MovesIdleMemberAfterTimeout(t *testing.T) {
	r := newAFKRig(t, 2)
	alice, bob := r.members[0], r.members[1]
	r.seat(alice, r.room)
	r.seat(bob, r.room)
	r.idle(alice, 10*time.Minute)
	r.sweep()

	got := r.moved(alice)
	if len(got) != 1 || got[0].to != r.afk || got[0].reason != "afk" {
		t.Fatalf("alice voice_moved = %+v, want one to ch%d with reason afk", got, r.afk)
	}
	if ch := r.rowChannel(alice); ch != 0 {
		t.Fatalf("alice still has a voice row in ch%d", ch)
	}
	if ch := alice.c.voice.channel(); ch != 0 {
		t.Fatalf("alice's client still names ch%d", ch)
	}
	if len(r.moved(bob)) != 0 || r.rowChannel(bob) != r.room {
		t.Fatal("an online member was moved")
	}
	r.check()
}

func TestSweepAFK_SkipsBeforeTimeout_DMCall_AFKChannelItself_ArchivedAFK(t *testing.T) {
	t.Run("before the timeout", func(t *testing.T) {
		r := newAFKRig(t, 1)
		a := r.members[0]
		r.seat(a, r.room)
		r.idle(a, 2*time.Minute) // default timeout is 5 minutes
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
			t.Fatal("moved before the timeout")
		}
		// The setting is honoured: 60 s makes the same member eligible.
		if err := r.db.SetSetting(context.Background(), "afk_timeout_seconds", "60"); err != nil {
			t.Fatal(err)
		}
		r.sweep()
		if len(r.moved(a)) != 1 {
			t.Fatal("not moved once the timeout setting dropped to 60 s")
		}
	})
	t.Run("a DM call", func(t *testing.T) {
		r := newAFKRig(t, 2)
		a, b := r.members[0], r.members[1]
		dm, _, err := r.db.GetOrCreateDMChannel(context.Background(), a.userID, b.userID)
		if err != nil {
			t.Fatal(err)
		}
		r.seat(a, dm.ID)
		r.idle(a, time.Hour)
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != dm.ID {
			t.Fatal("a DM call member was moved")
		}
	})
	t.Run("already in the AFK channel", func(t *testing.T) {
		r := newAFKRig(t, 1)
		a := r.members[0]
		r.seat(a, r.afk)
		r.idle(a, time.Hour)
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.afk {
			t.Fatal("a member already in the AFK channel was moved")
		}
	})
	t.Run("archived AFK channel", func(t *testing.T) {
		r := newAFKRig(t, 1)
		a := r.members[0]
		r.seat(a, r.room)
		r.idle(a, time.Hour)
		if _, err := r.db.ExecContext(context.Background(), `UPDATE channels SET archived = 1 WHERE id = ?`, r.afk); err != nil {
			t.Fatal(err)
		}
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
			t.Fatal("moved into an archived AFK channel")
		}
	})
	t.Run("no AFK channel", func(t *testing.T) {
		r := newAFKRig(t, 1)
		a := r.members[0]
		r.seat(a, r.room)
		r.idle(a, time.Hour)
		if _, err := r.db.SetAFKChannel(context.Background(), nil); err != nil {
			t.Fatal(err)
		}
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
			t.Fatal("moved with no AFK channel configured")
		}
	})
}

func TestSweepAFK_SkipsWhenTargetCannotJoinOrAFKFull(t *testing.T) {
	t.Run("cannot connect", func(t *testing.T) {
		r := newAFKRig(t, 1)
		a := r.members[0]
		r.seat(a, r.room)
		r.idle(a, time.Hour)
		revokeConnectVoice(t, r.db, r.afk)
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
			t.Fatal("a member who cannot join the AFK channel was dropped from voice")
		}
	})
	t.Run("full", func(t *testing.T) {
		r := newAFKRig(t, 2)
		a, b := r.members[0], r.members[1]
		if _, err := r.db.ExecContext(context.Background(), `UPDATE channels SET voice_max_users = 1 WHERE id = ?`, r.afk); err != nil {
			t.Fatal(err)
		}
		r.seat(b, r.afk)
		r.seat(a, r.room)
		r.idle(a, time.Hour)
		r.sweep()
		if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
			t.Fatal("a member was dropped from voice for a full AFK channel")
		}
	})
}

func TestSweepAFK_UserReturnsBeforeEvict(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	afkSweepSnapshotHook = func() { a.c.setLivePresence(db.StatusOnline, nil, "") }
	r.sweep()
	if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
		t.Fatal("a member who came back was moved")
	}
	if stashed(a.c) {
		t.Fatal("a refused move left a stash")
	}
	r.check()
}

func TestSweepAFK_ChannelSwitchRacesEvict(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	afkSweepSnapshotHook = func() {
		// The member's own switch lands between snapshot and eviction; their
		// idle stamp is untouched, so only the channel check can refuse.
		if !r.join(a, r.other) {
			t.Error("switch did not complete")
		}
	}
	r.sweep()
	if len(r.moved(a)) != 0 || r.rowChannel(a) != r.other || a.c.voice.channel() != r.other {
		t.Fatal("the AFK move followed a member who switched channel")
	}
	if stashed(a.c) {
		t.Fatal("a refused move left a stash")
	}
	r.check()
}

func TestSweepAFK_ParkedConnectionUntouched(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	c := a.c
	r.idle(a, time.Hour)
	afkSweepSnapshotHook = func() { r.disconnect(a, true) } // parks the membership
	r.sweep()
	for _, f := range drainMoved(c) {
		t.Fatalf("a parked connection was told to move: %+v", f)
	}
	if r.rowChannel(a) != r.room {
		t.Fatal("a parked membership's row was removed")
	}
	if got := r.hub.voiceReg.voiceGrace.snapshot()[a.userID]; got != r.room {
		t.Fatalf("parked entry = ch%d, want ch%d", got, r.room)
	}
	if stashed(c) {
		t.Fatal("a parked connection got a stash")
	}
}

func TestSweepAFK_KeepsModeratorMuteThroughRejoin(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	if ok, err := r.hub.voice.SetServerMute(context.Background(), a.userID, r.room, true); err != nil || !ok {
		t.Fatalf("SetServerMute: %v %v", ok, err)
	}
	r.idle(a, time.Hour)
	r.sweep()
	if len(r.moved(a)) != 1 {
		t.Fatal("not moved")
	}
	// The client's own re-join takes the stash back out.
	if !r.join(a, r.afk) {
		t.Fatal("re-join into the AFK channel failed")
	}
	row, err := r.db.GetVoiceState(context.Background(), a.userID)
	if err != nil || row == nil {
		t.Fatalf("no row after re-join: %v", err)
	}
	if !row.ServerMuted {
		t.Fatal("the moderator mute was lost across the AFK move")
	}
}

func TestSweepAFK_RejoinBlockRefusesAutomaticReturn(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	r.sweep()
	r.moved(a)

	// An automatic re-join of the old channel (a reconnect loop) is refused.
	r.hub.handleMessage(a.c, voiceFrame(t, "voice_join", "auto", map[string]any{"channel_id": r.room}))
	if a.c.voice.channel() != 0 {
		t.Fatal("the automatic return to the old channel was admitted")
	}
	// The member's own join is not.
	r.hub.handleMessage(a.c, voiceFrame(t, "voice_join", "own", map[string]any{"channel_id": r.room, "user_initiated": true}))
	if a.c.voice.channel() != r.room {
		t.Fatal("the member's own join was refused")
	}
}

func TestSweepAFK_BoundedPerSweepAndStopsOnCtx(t *testing.T) {
	r := newAFKRig(t, afkMovesPerSweep+3)
	for _, m := range r.members {
		r.seat(m, r.room)
		r.idle(m, time.Hour)
	}
	left := func() int {
		n := 0
		for _, m := range r.members {
			if r.rowChannel(m) == r.room {
				n++
			}
		}
		return n
	}

	// A context that ends after the snapshot moves nobody.
	ctx, cancel := context.WithCancel(context.Background())
	afkSweepSnapshotHook = cancel
	r.hub.sweepAFK(ctx)
	afkSweepSnapshotHook = nil
	if n := left(); n != len(r.members) {
		t.Fatalf("a cancelled sweep moved %d members", len(r.members)-n)
	}

	r.sweep()
	if n := left(); n != 3 {
		t.Fatalf("after one sweep %d members remain, want 3 (moved %d)", n, afkMovesPerSweep)
	}
	r.sweep()
	if n := left(); n != 0 {
		t.Fatalf("after the next sweep %d members remain, want 0", n)
	}
}

// A sweep must not move more members than the AFK channel has room for: the
// stored count does not rise until each client answers voice_moved, so the
// sweep counts its own moves. The member who does not fit stays where they are.
func TestSweepAFK_CappedChannelTakesOnlyWhatFits(t *testing.T) {
	r := newAFKRig(t, 2)
	a, b := r.members[0], r.members[1]
	if _, err := r.db.ExecContext(context.Background(), `UPDATE channels SET voice_max_users = 1 WHERE id = ?`, r.afk); err != nil {
		t.Fatal(err)
	}
	r.seat(a, r.room)
	r.seat(b, r.room)
	r.idle(a, 2*time.Hour)
	r.idle(b, time.Hour)
	r.sweep()
	if len(r.moved(a)) != 1 || r.rowChannel(a) != 0 {
		t.Fatal("the longest-idle member was not moved")
	}
	if len(r.moved(b)) != 0 || r.rowChannel(b) != r.room {
		t.Fatal("a second member was evicted for a channel with room for one")
	}
}

// A member who comes back and goes idle again inside the window has a new idle
// stamp; the sweep must judge by that, not by the stamp it snapshotted.
func TestSweepAFK_IdleAgainAfterReturnIsNotMovedOnTheOldStamp(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	afkSweepSnapshotHook = func() {
		a.c.setLivePresence(db.StatusOnline, nil, "")
		a.c.setLivePresence(db.StatusIdle, nil, "")
	}
	r.sweep()
	if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room {
		t.Fatal("a member idle again for seconds was moved on the old idle stamp")
	}
	r.check()
}

// A connection that is replaced after the snapshot is never evicted, even
// while presence and channel still match.
func TestSweepAFK_ReplacedConnectionIsNotEvicted(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	old := a.c
	afkSweepSnapshotHook = func() { r.hub.unregisterNow(old) }
	r.sweep()
	if r.rowChannel(a) != r.room || stashed(old) {
		t.Fatal("a connection that was no longer registered was evicted")
	}
}

// When the voice_moved send is refused (the member's queue is full), the
// moderator-flag stash is cleared again: nothing is left to turn the member's
// next unrelated join into a server mute.
func TestSweepAFK_FailedMovedSendClearsStash(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	if ok, err := r.hub.voice.SetServerMute(context.Background(), a.userID, r.room, true); err != nil || !ok {
		t.Fatalf("SetServerMute: %v %v", ok, err)
	}
	r.idle(a, time.Hour)
	c := a.c
	// Fill under c.mu, as the send paths do: a broadcast that finds the queue
	// full closes c.send from another goroutine.
	afkAfterEvictHook = func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for !c.sendClosed {
			select {
			case c.send <- []byte(`{"type":"filler"}`):
			default:
				return
			}
		}
	}
	r.sweep()
	if stashed(c) {
		t.Fatal("a failed voice_moved send left the moderator-flag stash behind")
	}
}

// A member with moderation in flight is skipped, not waited for: the eviction
// would otherwise race the moderator's mute and could drop it.
func TestSweepAFK_SkipsMemberWithModerationInFlight(t *testing.T) {
	r := newAFKRig(t, 1)
	a := r.members[0]
	r.seat(a, r.room)
	r.idle(a, time.Hour)
	// The moderator is another goroutine, as in production: a sweep run on
	// the goroutine that holds voiceMod would take voiceMember under it, which
	// the lock order (and the deadlock build's rank check) forbids.
	held := make(chan func())
	go func() { held <- r.hub.voiceMod.lock(a.userID) }()
	unlock := <-held
	r.sweep()
	unlock()
	if len(r.moved(a)) != 0 || r.rowChannel(a) != r.room || stashed(a.c) {
		t.Fatal("a member with moderation in flight was evicted")
	}
	r.sweep()
	if len(r.moved(a)) != 1 {
		t.Fatal("the member was not moved once moderation finished")
	}
}

// If the administrator unsets the AFK channel while a sweep is running, the
// remaining candidates are not evicted towards it.
func TestSweepAFK_StopsWhenTheAFKChannelIsUnsetMidSweep(t *testing.T) {
	r := newAFKRig(t, 2)
	a, b := r.members[0], r.members[1]
	r.seat(a, r.room)
	r.seat(b, r.room)
	r.idle(a, time.Hour)
	r.idle(b, time.Hour)
	afkSweepSnapshotHook = func() {
		if _, err := r.db.SetAFKChannel(context.Background(), nil); err != nil {
			t.Error(err)
		}
	}
	r.sweep()
	if len(r.moved(a)) != 0 || len(r.moved(b)) != 0 || r.rowChannel(a) != r.room || r.rowChannel(b) != r.room {
		t.Fatal("members were evicted towards a channel that is no longer the AFK channel")
	}
}
