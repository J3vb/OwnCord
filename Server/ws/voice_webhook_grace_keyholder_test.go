package ws

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// A participant_left webhook for a member parked in the RT-8 grace window
// deletes the row and the grace entry together, so expireVoiceGrace ->
// finishVoiceLeave (the normal re-election) never runs for that member. The
// webhook must re-elect itself, or the key-holder map keeps naming a member
// who is gone and the room's rekey offers are rejected with NOT_KEY_HOLDER.

// graceRoom is a txnFixture whose client (the lowest user id, so the elected
// key holder) shares a voice channel with a second, still-connected member.
type graceRoom struct {
	*txnFixture
	otherUID   int64
	other      *Client
	otherSend  chan []byte
	parkedTok  string
	otherToken string
}

func newGraceRoom(t *testing.T) *graceRoom {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "grace-holder")
	otherUID := seedHarvestVoiceUser(t, database, "grace-other")
	chID := mustCreateVoiceChannel(t, database, "grace-voice")
	h := newTestHubWith(t, HubOptions{DB: database})
	c := NewTestClient(h, uid, make(chan []byte, 64))
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()
	f := &txnFixture{h: h, c: c, uid: uid, chID: chID}
	r := &graceRoom{txnFixture: f}
	r.parkedTok = f.join(t)

	// A second member with a higher id, joined through the same persist path.
	r.otherUID = otherUID
	r.otherSend = make(chan []byte, 64)
	r.other = NewTestClient(f.h, r.otherUID, r.otherSend)
	f.h.mu.Lock()
	f.h.clients[r.otherUID] = []*Client{r.other}
	f.h.mu.Unlock()
	txn := f.h.begin(r.otherUID)
	state, err := txn.persistJoin(context.Background(), r.other, f.chID, 0)
	if err != nil {
		txn.end()
		t.Fatalf("persistJoin other: %v", err)
	}
	if !txn.markCompleted(r.other, f.chID, state.JoinedAt) {
		txn.end()
		t.Fatal("markCompleted other did not match its join")
	}
	txn.end()
	r.otherToken = state.JoinedAt

	f.h.updateKeyHolder(f.chID)
	if !f.h.IsVoiceKeyHolder(f.chID, f.uid) {
		t.Fatal("pre-condition: the lowest user id should hold the key")
	}
	return r
}

// park drops the first member's socket the way readPump's teardown does: the
// client leaves h.clients and its completed membership parks in the window.
func (r *graceRoom) park(t *testing.T) {
	t.Helper()
	r.h.mu.Lock()
	delete(r.h.clients, r.uid)
	r.h.mu.Unlock()
	txn := r.h.begin(r.uid)
	r.h.disconnectVoice(context.Background(), txn, r.c, "test")
	txn.end()
	if !r.h.voiceReg.voiceGrace.has(r.uid, r.chID) {
		t.Fatal("pre-condition: the membership should be parked")
	}
	if !r.h.IsVoiceKeyHolder(r.chID, r.uid) {
		t.Fatal("pre-condition: a parked member keeps the key until its window ends")
	}
}

// receivesWithin reports whether a frame containing substr reaches ch before
// the timeout; the broadcast is delivered by the hub's dispatch goroutine.
func receivesWithin(ch chan []byte, substr string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		select {
		case b := <-ch:
			if strings.Contains(string(b), substr) {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

func TestWebhookParticipantLeft_ParkedKeyHolderReelects(t *testing.T) {
	r := newGraceRoom(t)
	startActivityHub(t, r.h)
	r.park(t)

	r.h.HandleWebhookParticipantLeftForTest(r.uid, r.chID, r.parkedTok)

	if r.h.IsVoiceKeyHolder(r.chID, r.uid) {
		t.Error("the departed parked member is still the key holder")
	}
	if !r.h.IsVoiceKeyHolder(r.chID, r.otherUID) {
		t.Error("the remaining member was not elected key holder")
	}
	if r.h.voiceReg.voiceGrace.get(r.uid) != nil {
		t.Error("the grace entry survived the webhook")
	}
	if row, err := r.h.voice.State(context.Background(), r.uid); err != nil || row != nil {
		t.Errorf("the parked member's row survived: %+v, %v", row, err)
	}
	if !receivesWithin(r.otherSend, `"voice_leave"`, 2*time.Second) {
		t.Error("the remaining member was not sent the voice_leave")
	}
}

func TestWebhookParticipantLeft_ParkedNonHolderKeepsHolder(t *testing.T) {
	r := newGraceRoom(t)
	// Park the higher-id member; the lowest id (r.uid) stays the holder.
	r.h.mu.Lock()
	delete(r.h.clients, r.otherUID)
	r.h.mu.Unlock()
	txn := r.h.begin(r.otherUID)
	r.h.disconnectVoice(context.Background(), txn, r.other, "test")
	txn.end()
	if !r.h.voiceReg.voiceGrace.has(r.otherUID, r.chID) {
		t.Fatal("pre-condition: the non-holder should be parked")
	}

	r.h.HandleWebhookParticipantLeftForTest(r.otherUID, r.chID, r.otherToken)

	if !r.h.IsVoiceKeyHolder(r.chID, r.uid) {
		t.Error("removing a parked non-holder moved the key holder")
	}
	if r.h.voiceReg.voiceGrace.get(r.otherUID) != nil {
		t.Error("the grace entry survived the webhook")
	}
	if row, err := r.h.voice.State(context.Background(), r.otherUID); err != nil || row != nil {
		t.Errorf("the parked member's row survived: %+v, %v", row, err)
	}
}

func TestWebhookParticipantLeft_ParkedLastMemberEmptiesChannel(t *testing.T) {
	f := newTxnFixture(t, nil)
	tok := f.join(t)
	f.h.updateKeyHolder(f.chID)
	f.h.mu.Lock()
	delete(f.h.clients, f.uid)
	f.h.mu.Unlock()
	txn := f.h.begin(f.uid)
	f.h.disconnectVoice(context.Background(), txn, f.c, "test")
	txn.end()

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, tok)

	f.h.keyHolderMu.RLock()
	_, named := f.h.voiceKeyHolders[f.chID]
	f.h.keyHolderMu.RUnlock()
	if named {
		t.Error("an empty channel still has a key holder entry")
	}
	if f.h.voiceReg.voiceGrace.get(f.uid) != nil {
		t.Error("the grace entry survived the webhook")
	}
}

// A late leave for an older join instance removes nothing, so a holder that is
// merely parked keeps the key and its entry and row stay.
func TestWebhookParticipantLeft_StaleTokenKeepsParkedHolder(t *testing.T) {
	r := newGraceRoom(t)
	r.park(t)

	r.h.HandleWebhookParticipantLeftForTest(r.uid, r.chID, "older-join-token")

	if !r.h.IsVoiceKeyHolder(r.chID, r.uid) {
		t.Error("a stale-token leave demoted the parked key holder")
	}
	if !r.h.voiceReg.voiceGrace.has(r.uid, r.chID) {
		t.Error("a stale-token leave dropped the grace entry")
	}
	if row, err := r.h.voice.State(context.Background(), r.uid); err != nil || row == nil || row.JoinedAt != r.parkedTok {
		t.Errorf("a stale-token leave changed the row: %+v, %v", row, err)
	}
}

// A race/deadlock probe, not an ordering proof: it runs the webhook and a
// resuming socket concurrently. Both run under the member lock, so the outcome
// is one or the other and never a live slot over a deleted row (or a
// live row with no slot) — and the key holder is never left on a gone member.
func TestWebhookParticipantLeft_RacingGraceResumeIsConsistent(t *testing.T) {
	for range 8 {
		r := newGraceRoom(t)
		r.park(t)

		resumed := NewTestClient(r.h, r.uid, make(chan []byte, 64))
		resumed.lastSeq = 3
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			r.h.HandleWebhookParticipantLeftForTest(r.uid, r.chID, r.parkedTok)
		}()
		go func() {
			defer wg.Done()
			reg := r.h.begin(r.uid)
			r.h.registerNow(resumed, nil, reg)
			reg.end()
		}()
		wg.Wait()

		row, err := r.h.voice.State(context.Background(), r.uid)
		if err != nil {
			t.Fatal(err)
		}
		slotCh := resumed.voice.channel()
		if (row != nil) != (slotCh != 0) {
			t.Fatalf("inconsistent outcome: row=%+v slot channel=%d", row, slotCh)
		}
		if r.h.voiceReg.voiceGrace.get(r.uid) != nil {
			t.Fatal("a grace entry outlived both the webhook and the resume")
		}
		if slotCh == 0 && r.h.IsVoiceKeyHolder(r.chID, r.uid) {
			t.Fatal("key holder left on a member who is no longer in voice")
		}
	}
}
