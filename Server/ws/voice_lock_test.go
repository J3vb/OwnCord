package ws

import (
	"context"
	"testing"
	"time"
)

// holdJoinAfterCommit pauses m's next voice_join right after its row commits,
// before c.setVoiceState. It returns a channel closed once the join is held
// there, and a release the test calls to let it go. The held join also lets
// go by itself once another caller waits on m's voice lock, so a correctly
// serialized path cannot deadlock the test.
func holdJoinAfterCommit(t *testing.T, h *vmHarness, m *vmMember) (held <-chan struct{}, release func()) {
	t.Helper()
	heldCh := make(chan struct{})
	releaseCh := make(chan struct{})
	voiceJoinPostCommitRaceHook = func(c *Client) {
		if c != m.c {
			return
		}
		close(heldCh)
		deadline := time.Now().Add(5 * time.Second)
		for {
			select {
			case <-releaseCh:
				return
			default:
			}
			if h.hub.voiceReg.voiceMember.refsForTest(m.userID) >= 2 {
				return
			}
			if time.Now().After(deadline) {
				t.Error("held join was never released")
				return
			}
			time.Sleep(time.Millisecond)
		}
	}
	t.Cleanup(func() { voiceJoinPostCommitRaceHook = nil })
	var once bool
	return heldCh, func() {
		if !once {
			once = true
			close(releaseCh)
		}
	}
}

func waitDone(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s did not finish", what)
	}
}

// TestSweepStaleVoiceStates_JoinSetsStateInsideRecheckDeleteWindow closes the
// sweep-vs-join race (ARCH-014 gap a). The sweep snapshots the joiner as a
// ghost (row committed, client still at 0), passes its live-client recheck,
// and only then does the join set its state and finish. Without one lock over
// both, the sweep deletes the row of a completed join: the client is in voice
// with no voice_states row. With the voice lock the sweep's recheck waits for
// the join and sees it.
func TestSweepStaleVoiceStates_JoinSetsStateInsideRecheckDeleteWindow(t *testing.T) {
	h := newVMHarness(t, 1)
	m := h.members[0]
	ch := h.chanOf("vl-sweep")
	h.connect(m)

	held, release := holdJoinAfterCommit(t, h, m)
	joinDone := make(chan struct{})
	go func() {
		defer close(joinDone)
		h.hub.handleMessage(m.c, voiceFrame(t, "voice_join", "vl-join", map[string]any{"channel_id": ch}))
	}()
	waitDone(t, held, "join reaching the post-commit point")

	preDeleteReached := false
	sweepStaleVoicePreDeleteRaceHook = func(userID, _ int64, _ string) {
		if userID != m.userID {
			return
		}
		preDeleteReached = true
		release()
		<-joinDone
	}
	t.Cleanup(func() { sweepStaleVoicePreDeleteRaceHook = nil })

	sweepDone := make(chan struct{})
	go func() {
		defer close(sweepDone)
		h.hub.sweepStaleVoiceStates(context.Background())
	}()
	waitDone(t, joinDone, "join")
	waitDone(t, sweepDone, "sweep")
	if preDeleteReached {
		t.Error("sweep reached its delete for a join that completed under the voice lock; the recheck missed it")
	}

	gotCh, token := m.c.voice.state()
	if gotCh != ch || !m.c.voiceJoinCompletedForHarness() {
		t.Fatalf("join did not complete: client in ch%d, completed=%v", gotCh, m.c.voiceJoinCompletedForHarness())
	}
	row, err := h.db.GetVoiceState(context.Background(), m.userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if row == nil || row.ChannelID != ch || row.JoinedAt != token {
		t.Fatalf("sweep deleted the row of a completed join: row=%+v, client=(ch%d, %q)", row, gotCh, token)
	}
}

// TestVoiceMembership_ModeratorKickSerializesWithInFlightJoin: a moderator's
// kick that lands while the target's join is between commit and setVoiceState
// waits for the join and then removes it. Without the lock the kick sees the
// client not yet in the channel, reports no eviction, and the join completes.
func TestVoiceMembership_ModeratorKickSerializesWithInFlightJoin(t *testing.T) {
	h := newVMHarness(t, 1)
	m := h.members[0]
	ch := h.chanOf("vl-kick")
	h.connect(m)

	held, release := holdJoinAfterCommit(t, h, m)
	joinDone := make(chan struct{})
	go func() {
		defer close(joinDone)
		h.hub.handleMessage(m.c, voiceFrame(t, "voice_join", "vl-join", map[string]any{"channel_id": ch}))
	}()
	waitDone(t, held, "join reaching the post-commit point")

	kicked := h.hub.DisconnectFromVoiceInChannel(context.Background(), m.userID, ch, voiceLeaveReasonModerator)
	release()
	waitDone(t, joinDone, "join")
	if !kicked {
		t.Fatal("kick during an in-flight join reported no eviction; the join then completed and kept the user in voice")
	}
	if gotCh, _ := m.c.voice.state(); gotCh != 0 {
		t.Fatalf("client still in ch%d after the kick", gotCh)
	}
	if row, err := h.db.GetVoiceState(context.Background(), m.userID); err != nil || row != nil {
		t.Fatalf("voice_states row after the kick = %+v (err %v), want none", row, err)
	}
}
