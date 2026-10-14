package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// gateBlockingVisibility holds GetChannel for one channel until release is
// closed or the read's ctx ends: a database that stalls on the B5-7 gate.
type gateBlockingVisibility struct {
	VisibilityReader
	channelID int64
	entered   chan struct{}
	release   chan struct{}
	ended     chan error
	calls     *atomic.Int32
	panics    bool
}

func newGateBlockingVisibility(inner VisibilityReader, channelID int64) gateBlockingVisibility {
	return gateBlockingVisibility{
		VisibilityReader: inner,
		channelID:        channelID,
		entered:          make(chan struct{}, 64),
		release:          make(chan struct{}),
		ended:            make(chan error, 64),
		calls:            new(atomic.Int32),
	}
}

func (v gateBlockingVisibility) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if id != v.channelID {
		return v.VisibilityReader.GetChannel(ctx, id)
	}
	v.calls.Add(1)
	if v.panics {
		panic("gate read exploded")
	}
	v.entered <- struct{}{}
	select {
	case <-v.release:
		return v.VisibilityReader.GetChannel(ctx, id)
	case <-ctx.Done():
		v.ended <- ctx.Err()
		return nil, fmt.Errorf("gate read: %w", ctx.Err())
	}
}

func waitGateRead(t *testing.T, v gateBlockingVisibility) {
	t.Helper()
	select {
	case <-v.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the content gate read never started")
	}
}

func contentFrame(channelID int64, text string) broadcastMsg {
	msg := fmt.Appendf(nil, `{"type":"chat_message","payload":{"channel_id":%d,"content":%q}}`, channelID, text)
	return broadcastMsg{channelID: channelID, nsfwChannelID: channelID, msg: msg}
}

type gateFrame struct {
	Seq     uint64 `json:"seq"`
	Type    string `json:"type"`
	Payload struct {
		Content string `json:"content"`
	} `json:"payload"`
}

func decodeGateFrames(t *testing.T, raw [][]byte) []gateFrame {
	t.Helper()
	out := make([]gateFrame, 0, len(raw))
	for _, r := range raw {
		var f gateFrame
		if err := json.Unmarshal(r, &f); err != nil {
			t.Fatalf("decode %s: %v", r, err)
		}
		out = append(out, f)
	}
	return out
}

// pumpDispatch plays the dispatch goroutine for every frame queued now.
func pumpDispatch(h *Hub) {
	for {
		select {
		case bm := <-h.broadcast:
			h.dispatch(bm)
		default:
			return
		}
	}
}

// resolveNextGate applies the next resolver answer, as Run's select would.
func resolveNextGate(t *testing.T, h *Hub) {
	t.Helper()
	select {
	case res := <-h.gates.results:
		h.onGateResolved(res)
	case <-time.After(5 * time.Second):
		t.Fatal("no content gate answer arrived")
	}
}

// settleGates drains the queue and every lane, driving dispatch by hand.
func settleGates(t *testing.T, h *Hub) {
	t.Helper()
	pumpDispatch(h)
	for len(h.gates.lanes) > 0 {
		resolveNextGate(t, h)
		pumpDispatch(h)
	}
}

// newManualGateFixture is the NSFW fixture with its setup frames settled and
// nobody registered yet; the test plays the dispatch goroutine itself.
func newManualGateFixture(t *testing.T) *nsfwGateFixture {
	t.Helper()
	f := newNSFWGateFixture(t)
	settleGates(t, f.hub)
	return f
}

// ARCH-019's point: a stalled gate read for one channel must not hold up
// presence, voice or any other channel's frames behind it.
func TestContentGate_PresenceAndVoiceFlowWhileGateBlocks(t *testing.T) {
	f := newNSFWGateFixture(t)
	startNSFWHub(t, f)
	v := newGateBlockingVisibility(f.hub.readers.Visibility, f.labelledID)
	f.hub.readers.Visibility = v
	t.Cleanup(func() { close(v.release) })

	aliceSend := registerEmitTestClient(f.hub, f.aliceID, f.labelledID)
	bobSend := registerEmitTestClient(f.hub, f.bobID, f.controlID)

	f.hub.enqueue(contentFrame(f.labelledID, "held"), "channel content")
	waitGateRead(t, v)

	f.hub.BroadcastToAll([]byte(`{"type":"voice_state","payload":{"user_id":9}}`))
	f.hub.BroadcastToChannel(f.controlID, []byte(`{"type":"typing","payload":{"user_id":9}}`))

	if got := len(drainChan(bobSend, 300*time.Millisecond)); got != 2 {
		t.Fatalf("bob got %d frame(s) while another channel's gate was stalled, want the voice and typing frames", got)
	}
	got := decodeGateFrames(t, drainChan(aliceSend, 100*time.Millisecond))
	if len(got) != 1 || got[0].Type != "voice_state" {
		t.Fatalf("alice got %+v while her channel's gate was stalled, want only the global voice_state", got)
	}
}

// A read that outlasts contentGateTimeout fails closed: nobody gets the frame
// live, and a resume behind it must take the full-ready path.
func TestContentGate_TimeoutFailsClosedAndForcesResync(t *testing.T) {
	f := newNSFWGateFixture(t)
	v := newGateBlockingVisibility(f.hub.readers.Visibility, f.labelledID)
	f.hub.readers.Visibility = v
	t.Cleanup(func() { close(v.release) })
	f.hub.gates.timeout = 30 * time.Millisecond
	startNSFWHub(t, f)

	aliceSend := registerEmitTestClient(f.hub, f.aliceID, f.labelledID)
	f.hub.enqueue(contentFrame(f.labelledID, "timed out"), "channel content")
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 0 {
		t.Fatalf("alice got %d frame(s) from a gate that timed out, want 0", got)
	}
	select {
	case err := <-v.ended:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("gate read ended with %v, want context.DeadlineExceeded", err)
		}
	default:
		t.Fatal("the gate read never hit its deadline")
	}
	if last := atomic.LoadUint64(&f.hub.seq); !f.hub.mustFullResync(last) {
		t.Fatalf("a resume at seq %d missed the withheld frame and must take the full-ready path", last)
	}
}

// Frames for one channel keep their enqueue order around a pending gate,
// metadata included, and are numbered in that order.
func TestContentGate_SameChannelFramesKeepEnqueueOrder(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	h.enqueue(contentFrame(f.labelledID, "first"), "channel content")
	h.BroadcastToChannel(f.labelledID, []byte(`{"type":"typing","payload":{"user_id":9}}`))
	h.enqueue(contentFrame(f.labelledID, "third"), "channel content")
	pumpDispatch(h)

	if got := len(drainChan(aliceSend, 20*time.Millisecond)); got != 0 {
		t.Fatalf("alice got %d frame(s) before the gate answered, want 0", got)
	}
	settleGates(t, h)

	got := decodeGateFrames(t, drainChan(aliceSend, 50*time.Millisecond))
	if len(got) != 3 || got[0].Payload.Content != "first" || got[1].Type != "typing" || got[2].Payload.Content != "third" {
		t.Fatalf("alice got %+v, want first, typing, third", got)
	}
	if got[0].Seq >= got[1].Seq || got[1].Seq >= got[2].Seq {
		t.Fatalf("seqs %d, %d, %d are not in enqueue order", got[0].Seq, got[1].Seq, got[2].Seq)
	}
}

// channel_delete is global, but must not overtake the channel's own content
// still waiting on its gate.
func TestContentGate_ChannelDeleteWaitsForParkedContent(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	h.enqueue(contentFrame(f.labelledID, "before delete"), "channel content")
	h.BroadcastChannelDelete(f.labelledID)
	pumpDispatch(h)
	if got := len(drainChan(aliceSend, 20*time.Millisecond)); got != 0 {
		t.Fatalf("alice got %d frame(s) before the gate answered, want 0", got)
	}
	settleGates(t, h)

	got := decodeGateFrames(t, drainChan(aliceSend, 50*time.Millisecond))
	if len(got) != 2 || got[0].Type != "chat_message" || got[1].Type != MsgTypeChannelDelete {
		t.Fatalf("alice got %+v, want the message, then channel_delete", got)
	}
}

// awaitDispatch promises every frame enqueued before it has been sequenced,
// so its barrier waits for parked content.
func TestContentGate_AwaitDispatch_WaitsForParkedContent(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	h.enqueue(contentFrame(f.labelledID, "parked"), "channel content")
	done := make(chan struct{})
	h.enqueue(broadcastMsg{barrier: done}, "barrier")
	pumpDispatch(h)
	select {
	case <-done:
		t.Fatal("the barrier closed while content enqueued before it was still parked")
	default:
	}

	resolveNextGate(t, h)
	select {
	case <-done:
	default:
		t.Fatal("the barrier stayed open after the content ahead of it was delivered")
	}
	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 1 {
		t.Fatalf("alice got %d frame(s), want 1", got)
	}
}

// Content enqueued after a barrier does not hold it: the barrier closes once
// what was ahead of it is delivered, even while later frames still park.
func TestContentGate_AwaitDispatch_NotStarvedByLaterContent(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub

	h.enqueue(contentFrame(f.labelledID, "ahead"), "channel content")
	done := make(chan struct{})
	h.enqueue(broadcastMsg{barrier: done}, "barrier")
	h.enqueue(contentFrame(f.labelledID, "behind"), "channel content")
	pumpDispatch(h)

	resolveNextGate(t, h)
	select {
	case <-done:
	default:
		t.Fatal("the barrier waited on content enqueued after it")
	}
	if h.gates.parked != 1 {
		t.Fatalf("parked = %d, want only the later frame", h.gates.parked)
	}
	settleGates(t, h)
}

// A queue drop is settled only once nothing dequeued is still waiting to be
// sequenced: a parked frame is ahead of the dropped one's place.
func TestContentGate_QueueDrop_UnsettledWhileContentParked(t *testing.T) {
	h := newEmitTestHub()
	h.queueDrops.dropped.Add(1)
	h.gates.parked = 1

	h.seqMu.Lock()
	h.applyQueueContentDrops()
	h.seqMu.Unlock()
	if h.queueDrops.applied == h.queueDrops.dropped.Load() {
		t.Fatal("a drop settled while a dequeued frame was still parked")
	}

	h.gates.parked = 0
	h.seqMu.Lock()
	h.applyQueueContentDrops()
	h.seqMu.Unlock()
	if h.queueDrops.applied != h.queueDrops.dropped.Load() {
		t.Fatal("the drop did not settle once nothing was parked")
	}
}

// Frames that park behind a read in flight share one follow-up read, not one
// each.
func TestContentGate_OneReadCoversBacklog(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	v := newGateBlockingVisibility(h.readers.Visibility, f.labelledID)
	close(v.release)
	h.readers.Visibility = v
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	for i := range 5 {
		h.enqueue(contentFrame(f.labelledID, fmt.Sprint(i)), "channel content")
	}
	pumpDispatch(h)
	settleGates(t, h)

	if got := v.calls.Load(); got != 2 {
		t.Fatalf("GetChannel ran %d times for 5 frames, want 2 (the first, then one for the backlog)", got)
	}
	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 5 {
		t.Fatalf("alice got %d frame(s), want 5", got)
	}
}

// Stop interrupts a gate read blocked on the database, and Done waits for it.
func TestContentGate_StopInterruptsBlockedResolve(t *testing.T) {
	f := newNSFWGateFixture(t)
	go f.hub.Run()
	waitUntilRunning(t, f.hub)
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	v := newGateBlockingVisibility(f.hub.readers.Visibility, f.labelledID)
	f.hub.readers.Visibility = v
	t.Cleanup(func() { close(v.release) })

	f.hub.enqueue(contentFrame(f.labelledID, "stuck"), "channel content")
	waitGateRead(t, v)

	start := time.Now()
	f.hub.Stop()
	select {
	case <-f.hub.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done never closed after Stop during a blocked gate read")
	}
	if waited := time.Since(start); waited >= contentGateTimeout {
		t.Fatalf("Stop waited %v, as long as the gate timeout: it did not cancel the read", waited)
	}
	select {
	case err := <-v.ended:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("gate read ended with %v, want context.Canceled from Stop", err)
		}
	default:
		t.Fatal("Done closed while the gate read was still blocked")
	}
}

// While as many frames are parked as the queue holds, Run stops reading it,
// so enqueue's own wait and drop accounting take over.
func TestContentGate_ParkCapAppliesBackpressure(t *testing.T) {
	h := newEmitTestHub()
	if h.broadcastIn() == nil {
		t.Fatal("an idle hub is not reading its queue")
	}
	h.gates.parked = cap(h.broadcast)
	if h.broadcastIn() != nil {
		t.Fatal("Run still reads the queue with the park limit reached")
	}
}

// A resolver that panics fails closed like a read error instead of taking the
// hub down or leaving the lane parked forever.
func TestContentGate_ResolverPanicFailsClosed(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	v := newGateBlockingVisibility(h.readers.Visibility, f.labelledID)
	v.panics = true
	h.readers.Visibility = v
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	h.enqueue(contentFrame(f.labelledID, "panicked"), "channel content")
	settleGates(t, h)

	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 0 {
		t.Fatalf("alice got %d frame(s) from a gate whose read panicked, want 0", got)
	}
	if last := atomic.LoadUint64(&h.seq); !h.mustFullResync(last) {
		t.Fatalf("a resume at seq %d missed the withheld frame and must take the full-ready path", last)
	}
}

// A delivery that panics on a lane's last entry must not leave the lane
// behind: later frames for that channel would park with no read to drain
// them, holding every barrier and every queue-drop settlement.
func TestContentGate_PanicOnLastDeliveryDoesNotStrandLane(t *testing.T) {
	f := newManualGateFixture(t)
	h := f.hub
	aliceSend := registerEmitTestClient(h, f.aliceID, f.labelledID)

	h.enqueue(contentFrame(f.labelledID, "explodes"), "channel content")
	pumpDispatch(h)
	replay := h.replayBuf
	h.replayBuf = nil
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("delivery did not panic")
			}
		}()
		resolveNextGate(t, h)
	}()
	h.replayBuf = replay

	if len(h.gates.lanes) != 0 || h.gates.parked != 0 {
		t.Fatalf("lanes = %d, parked = %d after the panic, want none", len(h.gates.lanes), h.gates.parked)
	}
	h.BroadcastToChannel(f.labelledID, []byte(`{"type":"typing","payload":{"user_id":9}}`))
	pumpDispatch(h)
	got := decodeGateFrames(t, drainChan(aliceSend, 50*time.Millisecond))
	if len(got) != 1 || got[0].Type != "typing" {
		t.Fatalf("alice got %+v, want the typing frame delivered at once", got)
	}
}

// Barriers still parked when Run exits are released, so awaitDispatch does
// not wait out its ctx on a hub that will never drain them.
func TestContentGate_RunExitReleasesParkedBarriers(t *testing.T) {
	f := newNSFWGateFixture(t)
	startNSFWHub(t, f)
	v := newGateBlockingVisibility(f.hub.readers.Visibility, f.labelledID)
	f.hub.readers.Visibility = v
	t.Cleanup(func() { close(v.release) })

	f.hub.enqueue(contentFrame(f.labelledID, "stuck"), "channel content")
	waitGateRead(t, v)
	errc := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { errc <- f.hub.awaitDispatch(ctx) }()
	select {
	case err := <-errc:
		t.Fatalf("awaitDispatch returned %v while content ahead of it was parked", err)
	case <-time.After(50 * time.Millisecond):
	}

	f.hub.Stop()
	if err := <-errc; err != nil {
		t.Fatalf("awaitDispatch = %v after Run exited, want nil once its barrier was released", err)
	}
}
