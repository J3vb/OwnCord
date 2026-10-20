package ws_test

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestHub_LatencyCountsNamesMatchJSON pins that LatencyCounts is keyed by the
// JSON histogram names (the ones WindowSources registers), one entry per
// histogram and no other. The Prometheus exposition looks the counts up by
// those names, so a renamed key would silently drop a family.
func TestHub_LatencyCountsNamesMatchJSON(t *testing.T) {
	hub, _ := newTestHub(t)
	counts := hub.LatencyCounts()

	topKeys := jsonKeys(reflect.TypeFor[api.ServerMetrics]())
	phaseKeys := jsonKeys(reflect.TypeFor[ws.VoiceJoinPhases]())

	want := make([]string, 0, 3+len(phaseKeys))
	want = append(want, "ws_broadcast_ms", "ws_dispatch_lag_ms", "chat_send_ack_ms")
	for _, p := range phaseKeys {
		want = append(want, "voice_join_ms."+p)
	}
	if len(counts) != len(want) {
		t.Errorf("LatencyCounts has %d entries, want %d (%v)", len(counts), len(want), want)
	}
	for _, name := range want {
		if _, ok := counts[name]; !ok {
			t.Errorf("LatencyCounts has no %q", name)
		}
	}
	for name := range counts {
		key, phase, isPhase := strings.Cut(name, ".")
		if !slices.Contains(topKeys, key) {
			t.Errorf("LatencyCounts key %q has no top-level ServerMetrics JSON key", name)
		}
		if isPhase && !slices.Contains(phaseKeys, phase) {
			t.Errorf("LatencyCounts key %q is not a voice_join_ms phase", name)
		}
	}
}
