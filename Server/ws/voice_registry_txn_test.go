package ws

import (
	"context"
	"errors"
	"testing"
)

// WP 5.3b: every voice membership write goes through the lock handle
// Hub.begin returns. These tests pin the behaviours the fold into voiceTxn
// changed or must keep.

// txnFixture is a hub on the real voice service with one registered client
// that is not yet in voice.
type txnFixture struct {
	h    *Hub
	c    *Client
	uid  int64
	chID int64
}

func newTxnFixture(t *testing.T, opts func(*HubOptions)) *txnFixture {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "txn-user")
	chID := mustCreateVoiceChannel(t, database, "txn-voice")
	o := HubOptions{DB: database}
	if opts != nil {
		opts(&o)
	}
	h := newTestHubWith(t, o)
	c := NewTestClient(h, uid, make(chan []byte, 64))
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()
	return &txnFixture{h: h, c: c, uid: uid, chID: chID}
}

// join runs persistJoin + markCompleted under a fresh txn, as a completed
// voice_join does, and returns the join token.
func (f *txnFixture) join(t *testing.T) string {
	t.Helper()
	txn := f.h.begin(f.uid)
	defer txn.end()
	state, err := txn.persistJoin(context.Background(), f.c, f.chID, 0)
	if err != nil {
		t.Fatalf("persistJoin: %v", err)
	}
	if !txn.markCompleted(f.c, f.chID, state.JoinedAt) {
		t.Fatal("markCompleted did not match the join it just persisted")
	}
	return state.JoinedAt
}

func (f *txnFixture) subscribed() bool {
	return f.h.pubsub.SubscriberCount(VoiceTopic(f.chID)) > 0
}

func slotCompleted(c *Client) bool {
	c.voice.voiceMu.Lock()
	defer c.voice.voiceMu.Unlock()
	return c.voice.voiceJoinCompleted
}

// The webhook's participant_left clear used to leave voiceJoinCompleted set, so
// a later reconnect handed the new socket completed=true with channel 0. It is
// the same clearExact as the reconciler's now: every field resets together.
func TestVoiceRegistry_WebhookClearResetsCompleted(t *testing.T) {
	f := newTxnFixture(t, nil)
	token := f.join(t)

	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, token)

	if ch, tok := f.c.voice.state(); ch != 0 || tok != "" {
		t.Fatalf("slot after the webhook clear = (%d, %q), want (0, \"\")", ch, tok)
	}
	if slotCompleted(f.c) {
		t.Fatal("webhook clear left voiceJoinCompleted set with channel 0")
	}
	if f.subscribed() {
		t.Error("webhook clear left the client on the voice topic")
	}
}

// A participant_left webhook for the old join instance that lands after the
// user rejoined the same channel must leave the new membership alone; the
// webhook for the live instance then clears it completely, and a reconnect
// afterwards inherits nothing, completed flag included.
func TestVoiceRegistry_WebhookLeftRacingSameChannelRejoin(t *testing.T) {
	f := newTxnFixture(t, nil)
	ctx := context.Background()
	oldToken := f.join(t)

	// The stale webhook is queued behind the member lock while the rejoin
	// runs under it, so the rejoin always commits first.
	txn := f.h.begin(f.uid)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, oldToken)
	}()
	waitFor(t, "webhook queued on the member lock", func() bool { return f.h.voiceReg.voiceMember.refsForTest(f.uid) >= 2 })

	txn.clear(f.c)
	if _, err := txn.deleteRow(ctx, f.chID, oldToken); err != nil {
		t.Fatalf("deleteRow: %v", err)
	}
	state, err := txn.persistJoin(ctx, f.c, f.chID, 0)
	if err != nil {
		t.Fatalf("rejoin persistJoin: %v", err)
	}
	if state.JoinedAt == oldToken {
		t.Fatal("rejoin reused the old join token; the race needs a distinct instance")
	}
	if !txn.markCompleted(f.c, f.chID, state.JoinedAt) {
		t.Fatal("rejoin markCompleted did not match")
	}
	txn.end()
	<-done

	if ch, tok := f.c.voice.state(); ch != f.chID || tok != state.JoinedAt {
		t.Fatalf("stale webhook changed the rejoined slot to (%d, %q), want (%d, %q)", ch, tok, f.chID, state.JoinedAt)
	}
	if !slotCompleted(f.c) {
		t.Error("stale webhook reset the completed flag of the live join")
	}
	if !f.subscribed() {
		t.Error("stale webhook dropped the live join's voice topic subscription")
	}
	if row, err := f.h.voice.State(ctx, f.uid); err != nil || row == nil || row.JoinedAt != state.JoinedAt {
		t.Fatalf("stale webhook touched the live row: %+v, %v", row, err)
	}

	// The webhook for the live instance clears everything.
	f.h.HandleWebhookParticipantLeftForTest(f.uid, f.chID, state.JoinedAt)
	if ch, _ := f.c.voice.state(); ch != 0 {
		t.Fatalf("live webhook left channel %d in the slot", ch)
	}
	if slotCompleted(f.c) {
		t.Fatal("live webhook left voiceJoinCompleted set with channel 0")
	}

	// A resuming socket must not inherit a completed flag for no channel.
	resumed := NewTestClient(f.h, f.uid, make(chan []byte, 64))
	resumed.lastSeq = 7
	reg := f.h.begin(f.uid)
	f.h.registerNow(resumed, nil, reg)
	reg.end()
	if ch, tok := resumed.voice.state(); ch != 0 || tok != "" {
		t.Fatalf("resumed slot = (%d, %q), want empty", ch, tok)
	}
	if slotCompleted(resumed) {
		t.Fatal("reconnect handed the new socket completed=true with channel 0")
	}
}

type failingLeaveStore struct {
	VoiceStore
	err error
}

func (s failingLeaveStore) LeaveIfMatch(context.Context, int64, int64, string) (bool, error) {
	return false, s.err
}

// deleteRow drops the matching grace entry before it touches the database, so
// a failed delete leaves the row for the stale sweep and no timer that would
// tear the same membership down a second time.
func TestVoiceRegistry_DeleteRowErrorDropsGraceKeepsRow(t *testing.T) {
	errBoom := errors.New("database is locked")
	f := newTxnFixture(t, nil)
	real := f.h.voice
	token := f.join(t)

	// Park the membership as a dropped socket would.
	f.h.voiceReg.voiceGrace.put(f.uid, &voiceGraceEntry{client: f.c, snap: slotSnap{chID: f.chID, joinToken: token}}, func() {})
	t.Cleanup(func() { f.h.voiceReg.voiceGrace.take(f.uid) })

	f.h.voice = failingLeaveStore{VoiceStore: real, err: errBoom}
	txn := f.h.begin(f.uid)
	deleted, err := txn.deleteRow(context.Background(), f.chID, token)
	txn.end()

	if !errors.Is(err, errBoom) {
		t.Fatalf("deleteRow error = %v, want it to wrap the store error", err)
	}
	if deleted {
		t.Error("deleteRow reported a delete that failed")
	}
	if f.h.voiceReg.voiceGrace.get(f.uid) != nil {
		t.Error("a failed delete kept the grace entry")
	}
	row, rowErr := real.State(context.Background(), f.uid)
	if rowErr != nil || row == nil || row.JoinedAt != token {
		t.Fatalf("a failed delete changed the row: %+v, %v", row, rowErr)
	}
}

// Every clear variant drops the VoiceTopic subscription markCompleted added
// (OC-0219), so no caller can clear the slot and forget the pairing.
func TestVoiceRegistry_ClearAlwaysUnsubscribes(t *testing.T) {
	cases := []struct {
		name  string
		clear func(txn *voiceTxn, f *txnFixture, token string) bool
	}{
		{"clear", func(txn *voiceTxn, f *txnFixture, _ string) bool {
			return txn.clear(f.c).chID == f.chID
		}},
		{"clearIfChannel", func(txn *voiceTxn, f *txnFixture, _ string) bool {
			_, ok := txn.clearIfChannel(f.c, f.chID)
			return ok
		}},
		{"clearExact", func(txn *voiceTxn, f *txnFixture, token string) bool {
			ok := txn.clearExact(f.c, f.chID, token)
			return ok
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newTxnFixture(t, nil)
			token := f.join(t)
			if !f.subscribed() {
				t.Fatal("markCompleted did not subscribe the client")
			}

			txn := f.h.begin(f.uid)
			ok := tc.clear(txn, f, token)
			txn.end()

			if !ok {
				t.Fatal("the clear did not match")
			}
			if f.subscribed() {
				t.Error("the clear left the client on the voice topic")
			}
			if ch, tok := f.c.voice.state(); ch != 0 || tok != "" || slotCompleted(f.c) {
				t.Errorf("slot after %s = (%d, %q, completed=%v), want empty", tc.name, ch, tok, slotCompleted(f.c))
			}
		})
	}
}

// The token refresh adopts a token only for a slot that has none: the completed
// flag survives, and a cached token is never overwritten.
func TestVoiceRegistry_SetJoinTokenKeepsCompletedAndCachedToken(t *testing.T) {
	f := newTxnFixture(t, nil)
	token := f.join(t)

	txn := f.h.begin(f.uid)
	txn.setJoinToken(f.c, "other")
	txn.end()
	if _, tok := f.c.voice.state(); tok != token {
		t.Fatalf("cached token overwritten: %q, want %q", tok, token)
	}
	if !slotCompleted(f.c) {
		t.Fatal("setJoinToken reset the completed flag")
	}

	// A slot in a channel with no token adopts it, still completed.
	f.c.voice.voiceMu.Lock()
	f.c.voice.voiceJoinToken = ""
	f.c.voice.voiceMu.Unlock()
	txn = f.h.begin(f.uid)
	txn.setJoinToken(f.c, "adopted")
	txn.end()
	if ch, tok := f.c.voice.state(); ch != f.chID || tok != "adopted" {
		t.Fatalf("slot = (%d, %q), want (%d, adopted)", ch, tok, f.chID)
	}
	if !slotCompleted(f.c) {
		t.Fatal("adopting a token reset the completed flag")
	}
}
