package ws

import (
	"context"
	"strings"
	"testing"
)

// With webhooks on, LiveKit posts participant_left for a session it replaced under the same
// identity before the new session's participant_joined. The handler asks the SFU whether the
// identity is still in the room and keeps the membership if so.

func newWebhookLeftFixture(t *testing.T) (*txnFixture, *fakeSFU, string, string) {
	t.Helper()
	sfu := newFakeSFU()
	lk := sfu.serve(t)
	f := newTxnFixture(t, func(o *HubOptions) { o.LiveKit = lk })
	token := f.join(t)
	return f, sfu, RoomName(f.chID), participantIdentity(f.uid, token)
}

func (f *txnFixture) rowPresent(t *testing.T) bool {
	t.Helper()
	row, err := f.h.voice.State(context.Background(), f.uid)
	if err != nil {
		t.Fatalf("voice.State: %v", err)
	}
	return row != nil
}

func tokenOf(identity string) string {
	_, token, _ := strings.Cut(identity, ":")
	return token
}

func hasFrame(ch chan []byte) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestWebhookLeft_IdentityStillInRoomKeepsMembership(t *testing.T) {
	f, sfu, room, identity := newWebhookLeftFixture(t)
	sfu.add(room, identity) // the replacing session, same identity
	for len(f.c.send) > 0 {
		<-f.c.send
	}

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tokenOf(identity))

	if ch, _ := f.c.voice.state(); ch != f.chID {
		t.Errorf("slot channel = %d, want %d kept", ch, f.chID)
	}
	if !f.rowPresent(t) {
		t.Error("voice row was deleted although the identity is still in the room")
	}
	if hasFrame(f.c.send) {
		t.Error("a frame (voice_leave) was broadcast for a replaced session")
	}
}

func TestWebhookLeft_IdentityGoneTearsDown(t *testing.T) {
	f, _, _, identity := newWebhookLeftFixture(t)

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tokenOf(identity))

	if ch, _ := f.c.voice.state(); ch != 0 {
		t.Errorf("slot channel = %d, want 0 after teardown", ch)
	}
	if f.rowPresent(t) {
		t.Error("voice row survived although the SFU no longer lists the identity")
	}
}

func TestWebhookLeft_SFUErrorTearsDown(t *testing.T) {
	f, sfu, room, identity := newWebhookLeftFixture(t)
	sfu.add(room, identity)
	sfu.setListFailure(true)

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tokenOf(identity))

	if f.rowPresent(t) {
		t.Error("an unavailable SFU must fall back to teardown, row survived")
	}
}

// The identity reappearing under a new join token is a different identity string: the old one
// is gone, so the old session's leave tears down its own membership.
func TestWebhookLeft_NewTokenIdentityDoesNotCount(t *testing.T) {
	f, sfu, room, identity := newWebhookLeftFixture(t)
	sfu.add(room, participantIdentity(f.uid, "another-token"))

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tokenOf(identity))

	if f.rowPresent(t) {
		t.Error("a different join token's identity kept the old membership alive")
	}
}

func TestWebhookLeft_NoRowClientGoneIdentityStillInRoomKeepsRow(t *testing.T) {
	f, sfu, room, identity := newWebhookLeftFixture(t)
	sfu.add(room, identity)
	f.h.mu.Lock()
	delete(f.h.clients, f.uid)
	f.h.mu.Unlock()

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tokenOf(identity))

	if !f.rowPresent(t) {
		t.Error("client-gone branch deleted the row although the identity is still in the room")
	}
}
