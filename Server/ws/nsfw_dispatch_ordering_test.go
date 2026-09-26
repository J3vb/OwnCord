package ws

// nsfw_dispatch_ordering_test.go pins OC-0449's ordering contract: a
// content-bearing channel event's B5-7 gate is resolved when the event reaches
// the dispatch loop, not when it was enqueued.
//
// Every test here uses the same barrier. nsfwDispatchResolveRaceHook parks the
// dispatch goroutine at the gate's resolution boundary — the one place where
// the event is committed to the queue but its label and acknowledgements have
// not yet been read — and the test mutates consent there, before releasing it.
// That is the difference between proving the contract and hoping a sleep lands
// in the window: a mutation the test performs while dispatch is parked
// provably completes before the read.
//
// These tests fail on the parent commit for the reported reason, because the
// parent resolved the gate at enqueue: by the time dispatch was parked its
// filter had already been computed and was carried in the queued entry.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/plugin"
)

// dispatchGateBarrier parks the first content-bearing channel event at the
// gate's resolution boundary. reached closes when dispatch is parked there;
// release lets it proceed. Both are idempotent, and cleanup releases the gate
// so a failing test can never leave the dispatch goroutine parked.
func dispatchGateBarrier(t *testing.T) (reached <-chan struct{}, release func()) {
	t.Helper()
	reachedCh := make(chan struct{})
	gate := make(chan struct{})
	var parked, rel sync.Once
	nsfwDispatchResolveRaceHook = func(int64) {
		parked.Do(func() {
			close(reachedCh)
			<-gate
		})
	}
	release = func() { rel.Do(func() { close(gate) }) }
	t.Cleanup(func() {
		release()
		nsfwDispatchResolveRaceHook = nil
	})
	return reachedCh, release
}

// startNSFWHub runs the fixture's hub and drains the events its own setup
// emitted, so the barrier installed afterwards parks on the event under test
// rather than on a fixture frame. No clients are registered yet, so draining
// delivers nothing.
func startNSFWHub(t *testing.T, f *nsfwGateFixture) {
	t.Helper()
	go f.hub.Run()
	t.Cleanup(f.hub.Stop)
	waitUntilRunning(t, f.hub)
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch (drain fixture events): %v", err)
	}
}

// waitParked fails the test rather than hanging if dispatch never reaches the
// boundary, releasing the gate first so cleanup cannot deadlock.
func waitParked(t *testing.T, reached <-chan struct{}, release func()) {
	t.Helper()
	select {
	case <-reached:
	case <-time.After(10 * time.Second):
		release()
		t.Fatal("dispatch never reached the gate's resolution boundary")
	}
}

// TestNSFW_RevokeBetweenEnqueueAndDispatchWithholdsContent is the reported
// defect: consent revoked while the frame waits in the broadcast queue must
// stop that frame, and must stop it only for the member who revoked. bob holds
// an acknowledgement too and is the control — a fix that withheld the event
// channel-wide would pass alice's half and fail his.
func TestNSFW_RevokeBetweenEnqueueAndDispatchWithholdsContent(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()
	startNSFWHub(t, f)

	if _, err := f.db.AcknowledgeNSFW(ctx, f.bobID, f.labelledID); err != nil {
		t.Fatalf("AcknowledgeNSFW(bob): %v", err)
	}
	bobSend := registerEmitTestClient(f.hub, f.bobID, f.labelledID)
	aliceSend := registerEmitTestClient(f.hub, f.aliceID, f.labelledID)

	reached, release := dispatchGateBarrier(t)

	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.labelledID, "content": "queued then revoked"},
	})
	f.hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.labelledID, payload: payload}})

	waitParked(t, reached, release)
	if err := f.db.RevokeNSFW(ctx, f.aliceID, f.labelledID); err != nil {
		t.Fatalf("RevokeNSFW(alice): %v", err)
	}
	release()

	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 0 {
		t.Errorf("alice received %d frame(s) after revoking while the frame waited, want 0", got)
	}
	if got := len(drainChan(bobSend, 50*time.Millisecond)); got != 1 {
		t.Errorf("bob received %d frame(s), want exactly 1 — one member revoking must not withhold the event from the rest", got)
	}
}

// TestNSFW_LabelBetweenEnqueueAndDispatchWithholdsContent is the same defect
// from the other direction: the frame was queued while the channel was still
// unlabelled, so the parent carried no filter for it at all. Labelling the
// channel before it dispatches must withhold it from every subscriber who has
// no acknowledgement — here, both of them — and from the plugin sink, which
// decision 13 says never receives a labelled channel's content.
func TestNSFW_LabelBetweenEnqueueAndDispatchWithholdsContent(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()
	startNSFWHub(t, f)

	sink := plugin.NewEventSink()
	f.hub.SetPluginEventSink(sink)
	// The drain above delivered the fixture's own events to the sink before it
	// was installed; this counter starts from here.
	sink.DispatchCount.Store(0)

	bobSend := registerEmitTestClient(f.hub, f.bobID, f.controlID)
	aliceSend := registerEmitTestClient(f.hub, f.aliceID, f.controlID)

	reached, release := dispatchGateBarrier(t)

	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.controlID, "content": "queued unlabelled"},
	})
	f.hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.controlID, payload: payload}})

	waitParked(t, reached, release)
	if _, err := f.db.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.controlID); err != nil {
		t.Fatalf("label the control channel: %v", err)
	}
	release()

	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	for name, send := range map[string]chan []byte{"bob": bobSend, "alice": aliceSend} {
		if got := len(drainChan(send, 50*time.Millisecond)); got != 0 {
			t.Errorf("%s received %d frame(s) from a channel labelled while the frame waited, want 0", name, got)
		}
	}
	if got := sink.DispatchCount.Load(); got != 0 {
		t.Errorf("the plugin sink received %d call(s) for a channel labelled while the frame waited, want 0", got)
	}
}

// TestNSFW_ChannelDeletedBetweenEnqueueAndDispatchWithholdsContent: a channel
// that no longer exists cannot have its label confirmed, so the gate fails
// closed — alice holds an acknowledgement and must still receive nothing. The
// trailing event proves the dispatch loop survived the missing row rather than
// panicking or wedging on it.
func TestNSFW_ChannelDeletedBetweenEnqueueAndDispatchWithholdsContent(t *testing.T) {
	f := newNSFWGateFixture(t)
	ctx := context.Background()
	startNSFWHub(t, f)

	aliceSend := registerEmitTestClient(f.hub, f.aliceID, f.labelledID)
	controlSend := registerEmitTestClient(f.hub, f.aliceID, f.controlID)

	reached, release := dispatchGateBarrier(t)

	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.labelledID, "content": "queued then deleted"},
	})
	f.hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.labelledID, payload: payload}})

	waitParked(t, reached, release)
	if _, err := f.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, f.labelledID); err != nil {
		t.Fatalf("delete the labelled channel: %v", err)
	}
	release()

	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	if got := len(drainChan(aliceSend, 50*time.Millisecond)); got != 0 {
		t.Errorf("alice received %d frame(s) from a channel that no longer exists, want 0", got)
	}

	// The hub is still dispatching: an ordinary unlabelled channel's content
	// still reaches its subscriber.
	controlPayload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.controlID, "content": "after the deletion"},
	})
	f.hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.controlID, payload: controlPayload}})
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch (after deletion): %v", err)
	}
	if got := len(drainChan(controlSend, 50*time.Millisecond)); got != 1 {
		t.Errorf("the control channel delivered %d frame(s) after the deletion, want 1 — dispatch must survive a channel deleted under it", got)
	}
}
