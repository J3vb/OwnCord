package ws

import (
	"context"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// LiveKit posts participant_left for a session it replaced under the same identity before the new
// session's participant_joined. The handler keeps the membership when the SFU lists that identity
// under a different session id.

type leftFixture struct {
	h        *vmHarness
	m        *vmMember
	chID     int64
	room     string
	identity string
	token    string
}

func newLeftFixture(t *testing.T) *leftFixture {
	t.Helper()
	h := newVMHarness(t, 1)
	m := h.members[0]
	h.connect(m)
	chID := h.chanOf("left-presence")
	if !h.join(m, chID) {
		t.Fatal("join did not complete")
	}
	_, token := m.c.voice.state()
	return &leftFixture{h: h, m: m, chID: chID, room: RoomName(chID), token: token,
		identity: participantIdentity(m.userID, token)}
}

// left delivers participant_left for the old session, sid "PA_old".
func (f *leftFixture) left() {
	f.h.hub.HandleWebhookParticipantLeftWithSIDForTest(context.Background(), f.m.userID, f.chID, f.token, "PA_old")
}

func (f *leftFixture) row(t *testing.T) *db.VoiceState {
	t.Helper()
	row, err := f.h.hub.voice.State(context.Background(), f.m.userID)
	if err != nil {
		t.Fatalf("voice.State: %v", err)
	}
	return row
}

func (f *leftFixture) sawLeave() bool {
	return drainHasVoiceLeave(f.m.c.send, f.chID, f.m.userID)
}

func assertTornDown(t *testing.T, f *leftFixture) {
	t.Helper()
	if f.row(t) != nil {
		t.Error("voice row survived the teardown")
	}
	if ch, _ := f.m.c.voice.state(); ch != 0 {
		t.Errorf("slot channel = %d, want 0", ch)
	}
	if !f.sawLeave() {
		t.Error("no voice_leave broadcast after the teardown")
	}
}

func TestWebhookLeft_ReplacedSessionKeepsMembership(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")

	f.left()

	if row := f.row(t); row == nil || row.JoinedAt != f.token {
		t.Errorf("row = %+v, want it kept with token %q", row, f.token)
	}
	if ch, tok := f.m.c.voice.state(); ch != f.chID || tok != f.token {
		t.Errorf("slot = (%d, %q), want (%d, %q)", ch, tok, f.chID, f.token)
	}
	if f.sawLeave() {
		t.Error("voice_leave was broadcast for a replaced session")
	}
}

func TestWebhookLeft_SameSessionStillListedTearsDown(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_old")
	f.left()
	assertTornDown(t, f)
}

func TestWebhookLeft_EmptyEventSIDFallsBackToIdentity(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")
	f.h.hub.HandleWebhookParticipantLeftWithSIDForTest(context.Background(), f.m.userID, f.chID, f.token, "")
	if f.row(t) == nil {
		t.Error("an identity-only match must keep the membership")
	}
}

func TestWebhookLeft_IdentityGoneTearsDown(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.remove(f.room, f.identity)
	f.left()
	assertTornDown(t, f)
}

func TestWebhookLeft_SFUErrorTearsDown(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")
	f.h.sfu.setListFailure(true)
	f.left()
	assertTornDown(t, f)
}

// A reappearance under another join token is another identity string and does not count.
func TestWebhookLeft_NewTokenIdentityDoesNotCount(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.remove(f.room, f.identity)
	f.h.sfu.addWithSID(f.room, participantIdentity(f.m.userID, "another-token"), "PA_new")
	f.left()
	assertTornDown(t, f)
}

func TestWebhookLeft_ClientGoneReplacedSessionKeepsRow(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")
	f.h.hub.mu.Lock()
	delete(f.h.hub.clients, f.m.userID)
	f.h.hub.mu.Unlock()

	f.left()

	if f.row(t) == nil {
		t.Error("client-gone branch deleted the row of a replaced session")
	}
}

// The new session's participant_joined, delivered after the skipped left, is accepted as is.
func TestWebhookLeft_ThenJoinedKeepsNewSession(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")

	f.left()
	f.h.hub.HandleWebhookParticipantJoinedForTest(f.identity, f.room)

	if !f.h.sfu.has(f.room, f.identity) {
		t.Error("the new session was removed from the SFU")
	}
	if row := f.row(t); row == nil || row.JoinedAt != f.token {
		t.Errorf("row = %+v, want it unchanged with token %q", row, f.token)
	}
	if u := f.h.sfu.unhandledRPCs(); len(u) != 0 {
		t.Errorf("unexpected SFU RPCs: %s", strings.Join(u, ","))
	}
}

// After a skipped left, a session that really is gone is still reaped by the reconciler.
func TestWebhookLeft_SkippedThenReapedByReconciler(t *testing.T) {
	f := newLeftFixture(t)
	f.h.sfu.addWithSID(f.room, f.identity, "PA_new")
	f.left()
	f.h.sfu.remove(f.room, f.identity)

	f.h.hub.reconcileVoiceMembership(context.Background())
	f.h.hub.reconcileVoiceMembership(context.Background())

	if f.row(t) != nil {
		t.Error("reconciler did not reap the membership after two misses")
	}
	if !f.sawLeave() {
		t.Error("no voice_leave after the reconciler reaped the membership")
	}
}
