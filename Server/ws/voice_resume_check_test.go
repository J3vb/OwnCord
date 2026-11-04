package ws

// voice_resume_check_test.go: a membership a resumed socket took over is ended
// when its join is not at the SFU, and only then.

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// resumeCheckClock pins the resume-check clock for a test; advance moves it.
type resumeCheckClock struct{ at atomic.Int64 }

func (c *resumeCheckClock) now() time.Time { return time.Unix(0, c.at.Load()) }

func (c *resumeCheckClock) advance(d time.Duration) { c.at.Add(int64(d)) }

func pinResumeCheckClock(h *vmHarness) *resumeCheckClock {
	clk := &resumeCheckClock{}
	clk.at.Store(time.Now().UnixNano())
	s := &h.hub.voiceResumeChecks
	s.mu.Lock()
	s.now = clk.now
	s.mu.Unlock()
	return clk
}

// runResumeChecks runs one pass of the production check, then the harness oracle.
func (h *vmHarness) runResumeChecks() {
	h.step++
	h.t.Helper()
	h.hub.checkResumedVoice(context.Background())
	h.note("resume checks")
	h.check()
}

// parkAndResume joins m to chID, drops the socket inside the grace window and
// resumes it, returning the inherited join token.
func (h *vmHarness) parkAndResume(m *vmMember, chID int64) string {
	h.t.Helper()
	h.connect(m)
	if !h.join(m, chID) {
		h.t.Fatal("setup join did not complete")
	}
	_, token := m.c.voice.state()
	h.disconnect(m, true)
	h.resume(m)
	if ch, got := m.c.voice.state(); ch != chID || got != token {
		h.t.Fatalf("resume inherited %d/%s, want %d/%s", ch, got, chID, token)
	}
	return token
}

// TestVoiceResumeCheck_EndsJoinMissingAtSFU: the resumed client gave the call up
// while offline, so its join never shows at the SFU. Before the delay nothing
// happens, the first miss only schedules a second look, and the second miss
// ends the membership with reason "unconfirmed".
func TestVoiceResumeCheck_EndsJoinMissingAtSFU(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-ghost")
	clk := pinResumeCheckClock(h)
	h.parkAndResume(alice, chID)
	h.severSFU(alice)

	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != chID {
		t.Fatal("membership ended before the check delay")
	}

	clk.advance(voiceResumeCheckDelay)
	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != chID {
		t.Fatal("membership ended on the first miss")
	}
	clk.advance(voiceResumeConfirmGap - time.Second)
	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != chID {
		t.Fatal("second look ran before the confirm gap")
	}

	buf := captureVoiceLog(t)
	clk.advance(time.Second)
	h.runResumeChecks()
	if row := h.rowOf(alice); row != nil {
		t.Fatalf("ghost row survived the resume check: %+v", row)
	}
	if ch := alice.c.voice.channel(); ch != 0 {
		t.Fatalf("resumed client still in ch%d", ch)
	}
	if !strings.Contains(buf.String(), "reason="+voiceLeaveReasonUnconfirmed) {
		t.Fatalf("leave not logged with reason %q:\n%s", voiceLeaveReasonUnconfirmed, buf.String())
	}
	if h.hub.voiceResumeChecks.pending() {
		t.Fatal("check still pending after it ran")
	}
}

// TestVoiceResumeCheck_KeepsJoinPresentAtSFU: the LiveKit session survived the
// socket drop, so the identity is at the SFU and the call is kept.
func TestVoiceResumeCheck_KeepsJoinPresentAtSFU(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-live")
	clk := pinResumeCheckClock(h)
	token := h.parkAndResume(alice, chID)

	clk.advance(voiceResumeCheckDelay)
	h.runResumeChecks()
	if ch, got := alice.c.voice.state(); ch != chID || got != token {
		t.Fatalf("live call changed by the resume check: %d/%s", ch, got)
	}
	if h.hub.voiceResumeChecks.pending() {
		t.Fatal("confirmed check still pending")
	}
	h.leave(alice)
}

// TestVoiceResumeCheck_KeepsCallThatReconnectsBetweenLooks: the media path is
// still recovering at the first look and back by the second, so the call stays.
func TestVoiceResumeCheck_KeepsCallThatReconnectsBetweenLooks(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-recovering")
	clk := pinResumeCheckClock(h)
	token := h.parkAndResume(alice, chID)
	h.severSFU(alice)

	clk.advance(voiceResumeCheckDelay)
	h.hub.checkResumedVoice(context.Background())
	h.sfu.add(RoomName(chID), participantIdentity(alice.userID, token))
	clk.advance(voiceResumeConfirmGap)
	h.runResumeChecks()
	if ch, got := alice.c.voice.state(); ch != chID || got != token {
		t.Fatalf("a call back at the SFU by the second look was ended: %d/%s", ch, got)
	}
	if h.hub.voiceResumeChecks.pending() {
		t.Fatal("confirmed check still pending")
	}
	h.leave(alice)
}

// TestVoiceResumeCheck_NewerResumeRestartsCheck: the socket drops and resumes
// again after a first miss. The newer resume's check replaces the old one and
// starts over, so the old miss does not count toward ending the call.
func TestVoiceResumeCheck_NewerResumeRestartsCheck(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-reresume")
	clk := pinResumeCheckClock(h)
	h.parkAndResume(alice, chID)
	h.severSFU(alice)

	clk.advance(voiceResumeCheckDelay)
	h.hub.checkResumedVoice(context.Background())
	_, token := alice.c.voice.state()
	h.sfu.add(RoomName(chID), participantIdentity(alice.userID, token))
	h.disconnect(alice, true)
	h.resume(alice)
	h.severSFU(alice)

	clk.advance(voiceResumeConfirmGap)
	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != chID {
		t.Fatal("the old check's miss counted against the newer resume")
	}
	clk.advance(voiceResumeConfirmGap)
	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != 0 {
		t.Fatal("the newer resume's own two misses did not end the ghost")
	}
}

// TestVoiceResumeCheck_FailedListIsNotAbsent: a failing SFU list keeps the call
// and retries; past the give-up bound the check is dropped, call still kept.
func TestVoiceResumeCheck_FailedListIsNotAbsent(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-list-fail")
	clk := pinResumeCheckClock(h)
	h.parkAndResume(alice, chID)

	h.sfu.setListFailure(true)
	clk.advance(voiceResumeCheckDelay)
	h.hub.checkResumedVoice(context.Background())
	if alice.c.voice.channel() != chID {
		t.Fatal("a failed SFU list ended the call")
	}
	if !h.hub.voiceResumeChecks.pending() {
		t.Fatal("a failed list dropped the check instead of retrying")
	}
	clk.advance(voiceResumeCheckGiveUp + time.Second)
	h.hub.checkResumedVoice(context.Background())
	if h.hub.voiceResumeChecks.pending() {
		t.Fatal("check kept past the give-up bound")
	}
	if alice.c.voice.channel() != chID {
		t.Fatal("giving up ended the call")
	}
	h.sfu.setListFailure(false)
	h.leave(alice)
}

// TestVoiceResumeCheck_RejoinSupersedes: the user leaves and joins again before
// the check runs. The check names the old join only, so the new call is kept.
func TestVoiceResumeCheck_RejoinSupersedes(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-rejoin")
	clk := pinResumeCheckClock(h)
	old := h.parkAndResume(alice, chID)
	h.severSFU(alice)
	h.leave(alice)
	if !h.join(alice, chID) {
		t.Fatal("rejoin did not complete")
	}
	_, fresh := alice.c.voice.state()
	if fresh == old {
		t.Fatal("rejoin reused the old join token")
	}

	clk.advance(voiceResumeCheckDelay)
	h.runResumeChecks()
	clk.advance(voiceResumeConfirmGap)
	h.runResumeChecks()
	if ch, got := alice.c.voice.state(); ch != chID || got != fresh {
		t.Fatalf("resume check touched the new join: %d/%s, want %d/%s", ch, got, chID, fresh)
	}
	h.leave(alice)
}

// TestVoiceResumeCheck_DroppedAgainLeavesParked: the resumed socket drops again
// before the check, parking the membership. The grace window owns it, so the
// check does nothing and the parked entry survives.
func TestVoiceResumeCheck_DroppedAgainLeavesParked(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-reparked")
	clk := pinResumeCheckClock(h)
	h.parkAndResume(alice, chID)
	h.disconnect(alice, true)

	clk.advance(voiceResumeCheckDelay)
	h.hub.checkResumedVoice(context.Background())
	clk.advance(voiceResumeConfirmGap)
	h.hub.checkResumedVoice(context.Background())
	if !h.hub.voiceHub.reg.voiceGrace.has(alice.userID, chID) {
		t.Fatal("resume check tore down a membership parked again")
	}
	h.expireGrace(alice)
}

// TestVoiceResumeCheck_FreshConnectNotChecked: only a resume schedules a check.
func TestVoiceResumeCheck_FreshConnectNotChecked(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("resume-check-fresh")
	h.connect(alice)
	if !h.join(alice, chID) {
		t.Fatal("join did not complete")
	}
	if h.hub.voiceResumeChecks.pending() {
		t.Fatal("a fresh connect's join scheduled a resume check")
	}
	h.leave(alice)
}
