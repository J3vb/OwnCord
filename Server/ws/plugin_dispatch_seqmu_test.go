package ws

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/plugin"
)

// installPluginHook records every frame handed to the plugin sink, together
// with whether Hub.seqMu was free at that moment.
func installPluginHook(t *testing.T, f *nsfwGateFixture) (frames func() [][]byte, lockFree func() []bool) {
	t.Helper()
	var mu sync.Mutex
	var got [][]byte
	var free []bool
	hook := func(h *Hub, msg []byte) {
		ok := h.seqMu.TryLock()
		if ok {
			h.seqMu.Unlock()
		}
		mu.Lock()
		got = append(got, append([]byte(nil), msg...))
		free = append(free, ok)
		mu.Unlock()
	}
	pluginDispatchHook.Store(&hook)
	t.Cleanup(func() { pluginDispatchHook.Store(nil) })
	return func() [][]byte { mu.Lock(); defer mu.Unlock(); return append([][]byte(nil), got...) },
		func() []bool { mu.Lock(); defer mu.Unlock(); return append([]bool(nil), free...) }
}

func emitControlChat(t *testing.T, f *nsfwGateFixture, content string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": f.controlID, "content": content},
	})
	f.hub.EmitEvents(context.Background(), []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.controlID, payload: payload}})
}

// TestDeliverGated_PluginDispatchAfterSeqMuRelease proves the plugin sink is
// called with Hub.seqMu released, so a slow sink cannot extend the hold that
// serializes every broadcast.
func TestDeliverGated_PluginDispatchAfterSeqMuRelease(t *testing.T) {
	f := newNSFWGateFixture(t)
	startNSFWHub(t, f)
	sink := plugin.NewEventSink()
	f.hub.SetPluginEventSink(sink)
	sink.DispatchCount.Store(0)
	_, lockFree := installPluginHook(t, f)

	emitControlChat(t, f, "hello")
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	free := lockFree()
	if len(free) != 1 {
		t.Fatalf("sink hook ran %d time(s), want 1", len(free))
	}
	if !free[0] {
		t.Error("plugin sink was called while Hub.seqMu was held, want it released")
	}
	if got := sink.DispatchCount.Load(); got != 1 {
		t.Errorf("sink DispatchCount = %d, want 1", got)
	}
}

var seqPrefix = regexp.MustCompile(`^\{"seq":(\d+),`)

// TestDeliverGated_PluginDispatchInSeqOrder proves back-to-back frames reach
// the sink in seq order now that the call sits after the seqMu release.
func TestDeliverGated_PluginDispatchInSeqOrder(t *testing.T) {
	f := newNSFWGateFixture(t)
	startNSFWHub(t, f)
	sink := plugin.NewEventSink()
	f.hub.SetPluginEventSink(sink)
	frames, _ := installPluginHook(t, f)

	for _, c := range []string{"one", "two", "three"} {
		emitControlChat(t, f, c)
	}
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	got := frames()
	if len(got) != 3 {
		t.Fatalf("sink saw %d frame(s), want 3", len(got))
	}
	var prev uint64
	for i, m := range got {
		sm := seqPrefix.FindSubmatch(m)
		if sm == nil {
			t.Fatalf("frame %d carries no seq prefix: %s", i, m)
		}
		seq, err := strconv.ParseUint(string(sm[1]), 10, 64)
		if err != nil {
			t.Fatalf("frame %d seq: %v", i, err)
		}
		if seq <= prev {
			t.Errorf("frame %d seq %d not after previous %d", i, seq, prev)
		}
		prev = seq
	}
}
