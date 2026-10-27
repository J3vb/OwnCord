package ws

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func cseqOf(t *testing.T, frame []byte) uint64 {
	t.Helper()
	var f struct {
		Cseq uint64 `json:"cseq"`
	}
	if err := json.Unmarshal(frame, &f); err != nil {
		t.Fatalf("decode %s: %v", frame, err)
	}
	return f.Cseq
}

func TestStampCseq_SequencedOnly(t *testing.T) {
	c := &Client{}
	unsequenced := []byte(`{"type":"pong"}`)
	if got := c.stampCseq(unsequenced); !bytes.Equal(got, unsequenced) {
		t.Fatalf("unsequenced frame changed: %s", got)
	}
	for want := uint64(1); want <= 3; want++ {
		got := c.stampCseq(wrapWithSeq([]byte(`{"type":"typing","payload":{}}`), 40+want))
		if !bytes.HasPrefix(got, []byte(`{"cseq":`)) {
			t.Fatalf("cseq is not the first field: %s", got)
		}
		if n := cseqOf(t, got); n != want {
			t.Fatalf("cseq = %d, want %d (%s)", n, want, got)
		}
		var f struct {
			Seq  uint64 `json:"seq"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(got, &f); err != nil || f.Seq != 40+want || f.Type != "typing" {
			t.Fatalf("stamped frame lost its fields: %s (%v)", got, err)
		}
	}
}

func TestStampCseq_LossPendingSkipsOnce(t *testing.T) {
	c := &Client{}
	frame := wrapWithSeq([]byte(`{"type":"typing"}`), 7)
	if n := cseqOf(t, c.stampCseq(frame)); n != 1 {
		t.Fatalf("first cseq = %d, want 1", n)
	}
	c.cseq.lossPending.Store(true)
	c.cseq.lossPending.Store(true)
	if n := cseqOf(t, c.stampCseq(frame)); n != 3 {
		t.Fatalf("cseq after a loss = %d, want 3", n)
	}
	if n := cseqOf(t, c.stampCseq(frame)); n != 4 {
		t.Fatalf("cseq after the skip = %d, want 4", n)
	}
}

func TestStampCseq_ReleasesLargeBuffer(t *testing.T) {
	c := &Client{}
	big := wrapWithSeq([]byte(`{"type":"chat_message","payload":{"content":"`+strings.Repeat("x", cseqBufKeep)+`"}}`), 1)
	c.stampCseq(big)
	if c.cseq.buf != nil {
		t.Fatalf("kept a %d-byte stamping buffer after a large frame", cap(c.cseq.buf))
	}
	c.stampCseq(wrapWithSeq([]byte(`{"type":"typing"}`), 2))
	if c.cseq.buf == nil {
		t.Fatal("a small frame's buffer should be kept for reuse")
	}
}

// Frames this connection never receives (another channel's) must not use up
// a cseq, so the client sees a contiguous count.
func TestCseq_FilteredFramesDoNotAdvance(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	bobSend := registerEmitTestClient(h, 2, 6)
	bob := h.clients[2][0]

	h.BroadcastToChannel(5, []byte(`{"type":"typing","payload":{"channel_id":5}}`))
	h.BroadcastToChannel(6, []byte(`{"type":"typing","payload":{"channel_id":6}}`))
	h.BroadcastToChannel(5, []byte(`{"type":"typing","payload":{"channel_id":5}}`))
	h.BroadcastToAll([]byte(`{"type":"server_notice"}`))
	h.BroadcastToChannel(6, []byte(`{"type":"typing","payload":{"channel_id":6}}`))
	drainQueueThroughDispatch(h)

	frames := drainChan(bobSend, 20*time.Millisecond)
	if len(frames) != 3 {
		t.Fatalf("bob got %d frames, want 3", len(frames))
	}
	for i, f := range frames {
		if n := cseqOf(t, bob.stampCseq(f)); n != uint64(i+1) {
			t.Fatalf("frame %d cseq = %d, want %d", i, n, i+1)
		}
	}
}
