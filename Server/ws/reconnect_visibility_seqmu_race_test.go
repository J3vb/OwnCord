package ws

// reconnect_visibility_seqmu_race_test.go — Codex round 4, item A.
//
// api/nsfw_handler.go's markDMVisibilityChanged (and B5-6's
// broadcastDMOpen) reach Hub.MarkVisibilityChanged to force a resuming
// client onto the full-ready path after an unsequenced, targeted event.
// reconnectRegister re-checks mustFullResync and then calls registerNow
// inside the SAME h.seqMu critical section — but until this round,
// MarkVisibilityChanged bumped the watermark without taking that lock at
// all, so a concurrent call landing strictly between the check and the
// registration was invisible to both: the check had already run, and the
// caller's own direct send (notifyNSFWAck, broadcastDMOpen's SendToUser
// loop) would find the socket not yet registered.
//
// This test drives that exact interleaving through the hub, for real:
// handleReconnectPostCheckPreRegisterRaceHook fires inside reconnectRegister
// after its check has already passed and before registerNow. From there a
// genuinely concurrent goroutine calls MarkVisibilityChanged then SendToUser
// — the same order and shape as the real caller — and the test proves it
// cannot complete until this reconnect's critical section releases the lock,
// at which point the socket is already registered and the send succeeds.

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestHandleReconnect_ConcurrentVisibilityBumpBlocksUntilRegistered(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	uid, err := database.CreateUser(ctx, "seqmu-race-user", "hash", 4) // Member
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "seqmu-race-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)

	// Bracket last_seq so the resume takes the buffer tier and reaches the
	// hook, rather than an immediate mustFullResync-forced full ready. seq 96
	// is an older entry purely so the ring buffer's oldest-seq guard doesn't
	// read last_seq=97 as "too old to trust" (EventsSince requires afterSeq
	// to be strictly newer than the buffer's oldest entry).
	rb := hub.ReplayBuffer()
	rb.Push(96, chID, []byte(`{"seq":96,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"pre-existing"}}`))
	rb.Push(97, chID, []byte(`{"seq":97,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"anchor"}}`))
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(chID)+`,"content":"tail"}}`))
	hub.SeedSeq(98)
	const lastSeq = uint64(97)

	notifyResult := make(chan bool, 1)
	entering := make(chan struct{})
	returned := make(chan struct{})
	t.Cleanup(func() { handleReconnectPostCheckPreRegisterRaceHook = nil })
	handleReconnectPostCheckPreRegisterRaceHook = func() {
		go func() {
			// Signalled the instant this goroutine runs, BEFORE the locked
			// call — proof it was actually scheduled, so waiting for it
			// (below) cannot itself be starved by a slow runner the way a
			// bare time.After() could. Same order and shape as
			// api/nsfw_handler.go's markDMVisibilityChanged + notifyNSFWAck,
			// and broadcastDMOpen's bump + SendToUser loop.
			close(entering)
			hub.MarkVisibilityChanged()
			delivered := hub.SendToUser(uid, []byte(`{"type":"nsfw_ack"}`))
			notifyResult <- delivered
			close(returned)
		}()
		<-entering

		// Give the now-confirmed-scheduled goroutine every chance to
		// actually run — pure CPU yielding, no wall-clock wait — before we
		// check it hasn't finished. This only matters for making a
		// regression's false negative rare; it changes nothing about the
		// guarantee below, which holds unconditionally for the fixed code.
		for range 1000 {
			runtime.Gosched()
		}

		// The correctness check instruments the lock, not the clock:
		// hookFinished closes the instant this function returns, with
		// nothing else after the loop above, so for a genuinely serialized
		// MarkVisibilityChanged "returned" cannot win this select no matter
		// how the scheduler behaves — the concurrent goroutine is blocked on
		// h.seqMu.Lock(), which this very function is holding, so it cannot
		// even reach SendToUser (let alone close "returned") until AFTER
		// reconnectRegister releases the lock, which happens strictly after
		// this hook itself returns.
		hookFinished := make(chan struct{})
		go func() {
			select {
			case <-returned:
				t.Error("concurrent MarkVisibilityChanged (+SendToUser) completed while reconnectRegister still held h.seqMu — it must block until this critical section releases the lock")
			case <-hookFinished:
			}
		}()
		close(hookFinished)
	}

	events := dialAndResume(t, hub, token, lastSeq)
	_ = events

	// dialAndResume's own connection-close teardown races the client's
	// unregistration against this check, so the meaningful assertion is
	// SendToUser's return value itself: it only reports true if it found the
	// client in h.clients AT THE MOMENT this concurrent call finally got
	// past MarkVisibilityChanged — proof the socket was registered by then.
	select {
	case delivered := <-notifyResult:
		if !delivered {
			t.Fatal("SendToUser after the concurrent bump unblocked = false, want true — " +
				"the socket must already be registered by the time a caller that started " +
				"mid-handshake gets past MarkVisibilityChanged")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the concurrent MarkVisibilityChanged + SendToUser never completed after the reconnect finished — deadlock?")
	}
}
