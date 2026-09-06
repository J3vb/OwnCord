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
	bumpDone := make(chan struct{})
	t.Cleanup(func() { handleReconnectPostCheckPreRegisterRaceHook = nil })
	handleReconnectPostCheckPreRegisterRaceHook = func() {
		go func() {
			// Same order and shape as api/nsfw_handler.go's
			// markDMVisibilityChanged + notifyNSFWAck, and broadcastDMOpen's
			// bump + SendToUser loop.
			hub.MarkVisibilityChanged()
			close(bumpDone)
			notifyResult <- hub.SendToUser(uid, []byte(`{"type":"nsfw_ack"}`))
		}()
		// reconnectRegister (this goroutine) is holding h.seqMu right now —
		// the concurrent call above can only be blocked inside
		// MarkVisibilityChanged's Lock(), never past it. Any completion
		// observed here would mean the two calls interleaved instead of
		// serializing.
		select {
		case <-bumpDone:
			t.Error("concurrent MarkVisibilityChanged completed while reconnectRegister still held h.seqMu — it must block until this critical section releases the lock")
		case <-time.After(50 * time.Millisecond):
		}
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
