package ws_test

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/ws"
)

// jsonKeys returns the json tag names of struct type t.
func jsonKeys(t reflect.Type) []string {
	var keys []string
	for f := range t.Fields() {
		if name, _, _ := strings.Cut(f.Tag.Get("json"), ","); name != "" && name != "-" {
			keys = append(keys, name)
		}
	}
	return keys
}

// TestHub_WindowSourcesNamesMatchJSON pins that the names the hub registers
// with the windowed sampler are the keys api.WindowMetrics serialises, and
// that each one repeats a top-level /api/v1/metrics key. A renamed source would
// otherwise silently report a window of zeros.
func TestHub_WindowSourcesNamesMatchJSON(t *testing.T) {
	hub, _ := newTestHub(t)
	hists, gauges, counters := hub.WindowSources()

	windowKeys := jsonKeys(reflect.TypeFor[api.WindowMetrics]())
	topKeys := jsonKeys(reflect.TypeFor[api.ServerMetrics]())
	phaseKeys := jsonKeys(reflect.TypeFor[ws.VoiceJoinPhases]())

	seen := map[string]bool{}
	claim := func(name string) {
		t.Helper()
		if seen[name] {
			t.Errorf("duplicate source name %q", name)
		}
		seen[name] = true
	}
	covered := map[string]bool{}
	check := func(name string) {
		t.Helper()
		claim(name)
		key, phase, isPhase := strings.Cut(name, ".")
		if isPhase && (key != "voice_join_ms" || !slices.Contains(phaseKeys, phase)) {
			t.Errorf("source %q is not a voice_join_ms phase", name)
		}
		if !slices.Contains(windowKeys, key) {
			t.Errorf("source %q has no WindowMetrics JSON key", name)
		}
		if !slices.Contains(topKeys, key) {
			t.Errorf("source %q has no top-level ServerMetrics JSON key", name)
		}
		covered[key] = true
	}
	for _, h := range hists {
		check(h.Name)
	}
	for _, g := range gauges {
		check(g.Name)
	}
	for _, c := range counters {
		check(c.Name)
	}
	if len(phaseKeys) != 6 {
		t.Fatalf("voice phases = %d, want 6", len(phaseKeys))
	}
	for _, p := range phaseKeys {
		if !seen["voice_join_ms."+p] {
			t.Errorf("voice phase %q is not windowed", p)
		}
	}

	// Every WindowMetrics key is fed by a hub source, except the window's own
	// fields and the database pools, which internal/app registers.
	for _, key := range windowKeys {
		if key == "seconds" || key == "as_of" || strings.HasPrefix(key, "db_") || covered[key] {
			continue
		}
		t.Errorf("WindowMetrics key %q has no hub source", key)
	}
}
