package ws

import (
	"bytes"
	"testing"
	"time"
)

// TestMentionCount_FrameReachesTargetOnly: NotifyMentionCount is targeted by
// user id (SendToUserLow, mirroring NotifyAppealStatus). The frame carries the
// channel id and the reader's new total, and no other connected user receives
// it.
func TestMentionCount_FrameReachesTargetOnly(t *testing.T) {
	h := newEmitTestHub()
	reader := registerEmitTestClient(h, 42, 0)
	bystander := registerEmitTestClient(h, 99, 0)

	h.NotifyMentionCount(42, 7, 3)

	msgs := drainChan(reader, 200*time.Millisecond)
	if len(msgs) != 1 {
		t.Fatalf("reader got %d messages, want 1: %v", len(msgs), msgs)
	}
	if !bytes.Contains(msgs[0], []byte(`"type":"mention_count"`)) {
		t.Fatalf("frame = %s, want a mention_count frame", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"channel_id":7`)) {
		t.Fatalf("frame = %s, want channel_id 7", msgs[0])
	}
	if !bytes.Contains(msgs[0], []byte(`"count":3`)) {
		t.Fatalf("frame = %s, want count 3", msgs[0])
	}

	if msgs := drainChan(bystander, 50*time.Millisecond); len(msgs) != 0 {
		t.Fatalf("a different connected user received %d messages, want 0: %v", len(msgs), msgs)
	}
}

// TestMentionCount_NoConnectionIsANoOp: a disconnected reader simply gets
// nothing — the count surfaces on their next ready.
func TestMentionCount_NoConnectionIsANoOp(t *testing.T) {
	h := newEmitTestHub()
	h.NotifyMentionCount(999, 7, 3) // no panic
}
