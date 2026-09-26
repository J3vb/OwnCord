package ws

import (
	"bytes"
	"context"
	"testing"
	"time"
)

// TestAppeal_StatusFrameReachesAppellantAndDeviceReplacement: NotifyAppealStatus
// is targeted by user id (SendToUserLow, mirroring NotifyModAction). The hub
// registers at most ONE client per user id (h.clients is keyed by user id),
// so "another device" is not a second simultaneous socket — it is the SAME
// user id's registration being REPLACED (a reconnect). Whichever socket is
// CURRENTLY registered receives the frame; the one it replaced gets
// nothing further, and no other connected user does either.
func TestAppeal_StatusFrameReachesAppellantAndDeviceReplacement(t *testing.T) {
	h := newEmitTestHub()
	appellant := registerEmitTestClient(h, 42, 0)
	bystander := registerEmitTestClient(h, 99, 0)

	note := "please reconsider"
	h.NotifyAppealStatus(42, "pub-appeal-1", "overturned", &note)

	msgs := drainChan(appellant, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("appellant got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"type":"appeal_status"`)) {
		t.Fatalf("frame = %s, want an appeal_status frame", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"id":"pub-appeal-1"`)) {
		t.Fatalf("frame = %s, want the public id", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"state":"overturned"`)) {
		t.Fatalf("frame = %s, want state=overturned", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"decision_note":"please reconsider"`)) {
		t.Fatalf("frame = %s, want the decision note", msgs[0])
	}

	if msgs := drainChan(bystander, 50*time.Millisecond); len(msgs) != 0 {
		t.Fatalf("a different connected user received %d messages, want 0: %v", len(msgs), msgs)
	}

	// Device replacement: h.clients is keyed by user id, so registering a
	// second socket for the SAME appellant REPLACES the first (a reconnect),
	// rather than adding a second simultaneous recipient — the frame must
	// reach whichever socket is CURRENTLY registered, and the replaced one
	// must get nothing further.
	secondDevice := registerEmitTestClient(h, 42, 0)
	h.NotifyAppealStatus(42, "pub-appeal-1", "upheld", &note)

	if msgs := drainChan(appellant, 50*time.Millisecond); len(msgs) != 0 {
		t.Fatalf("the replaced (first) device received %d messages, want 0: %v", len(msgs), msgs)
	}
	msgs = drainChan(secondDevice, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("the second device got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"state":"upheld"`)) {
		t.Fatalf("frame = %s, want state=upheld", msgs[0])
	}
}

// TestAppeal_StatusFrameNilDecisionNote: a submission-adjacent transition
// (assigned, withdrawn) carries no decision note yet.
func TestAppeal_StatusFrameNilDecisionNote(t *testing.T) {
	h := newEmitTestHub()
	send := registerEmitTestClient(h, 42, 0)

	h.NotifyAppealStatus(42, "pub-appeal-1", "assigned", nil)

	msgs := drainChan(send, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"decision_note":null`)) {
		t.Fatalf("frame = %s, want a null decision_note", msgs[0])
	}
}

// TestAppeal_StatusFrameNoConnectionIsANoOp: a disconnected appellant simply
// gets nothing — the state surfaces on their next GET /api/v1/appeals/mine.
func TestAppeal_StatusFrameNoConnectionIsANoOp(t *testing.T) {
	h := newEmitTestHub()
	h.NotifyAppealStatus(999, "pub-appeal-1", "withdrawn", nil) // no panic, no return value to check
}

// TestBroadcastAppealQueue_NoDBIsANoOp: a hub with no database handle (the
// same minimal shape newEmitTestHub builds) must not panic.
func TestBroadcastAppealQueue_NoDBIsANoOp(t *testing.T) {
	h := newEmitTestHub()
	h.BroadcastAppealQueue(context.Background(), 1, "open") // no panic
}
