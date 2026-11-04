package admin

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/livekitproc"
	"github.com/J3vb/OwnCord/Server/metrics"
)

// supportHealthHub is the narrow fake the health snapshot reads through: the
// hub broadcaster subset plus the LiveKit supervisor accessors added by SRE-04.
type supportHealthHub struct {
	HubBroadcaster
	managed bool
	status  livekitproc.Status
}

func (h supportHealthHub) LiveKitManaged() bool                     { return h.managed }
func (h supportHealthHub) LiveKitProcessStatus() livekitproc.Status { return h.status }
func (h supportHealthHub) UserCount() int                           { return 3 }

// SRE-M1's in-process latency surface, satisfied so the snapshot's latency
// branch is exercised.
func (h supportHealthHub) TopicShedCount() uint64         { return 4 }
func (h supportHealthHub) BroadcastMs() metrics.Summary   { return metrics.Summary{Count: 10, P95: 5} }
func (h supportHealthHub) DispatchLagMs() metrics.Summary { return metrics.Summary{Count: 2, P95: 30} }
func (h supportHealthHub) ChatAckMs() metrics.Summary     { return metrics.Summary{Count: 3, P95: 11} }
func (h supportHealthHub) BroadcastQueueDepth() int       { return 6 }
func (h supportHealthHub) SeqMuMaxHoldMs() float64        { return 205 }

// A managed companion contributes its local running/restart/gave-up state,
// read from the supervisor, never probed.
func TestSupportHealth_ManagedLiveKitFields(t *testing.T) {
	hub := supportHealthHub{managed: true, status: livekitproc.Status{Running: true, Restarts: 2}}
	out := supportHealth(hub, time.Now())

	if out.LiveKitManaged == nil || !*out.LiveKitManaged {
		t.Errorf("livekit_managed = %v, want true", out.LiveKitManaged)
	}
	if out.LiveKitHealthy == nil || !*out.LiveKitHealthy {
		t.Errorf("livekit_healthy = %v, want true", out.LiveKitHealthy)
	}
	if out.LiveKitRestarts == nil || *out.LiveKitRestarts != 2 {
		t.Errorf("livekit_restarts = %v, want 2", out.LiveKitRestarts)
	}
	if out.LiveKitGaveUp == nil || *out.LiveKitGaveUp {
		t.Errorf("livekit_gave_up = %v, want false", out.LiveKitGaveUp)
	}
	if out.ConnectedUsers == nil || *out.ConnectedUsers != 3 {
		t.Errorf("connected_users = %v, want 3", out.ConnectedUsers)
	}
}

// The support bundle carries SRE-M1's latency surface as aggregate numbers:
// the shed counter, the three histograms, the queue-depth gauge and the
// max-seqMu-hold gauge.
func TestSupportHealth_LatencyFields(t *testing.T) {
	out := supportHealth(supportHealthHub{}, time.Now())
	if out.TopicShedsTotal == nil || *out.TopicShedsTotal != 4 {
		t.Errorf("topic_sheds_total = %v, want 4", out.TopicShedsTotal)
	}
	if out.HubBroadcastQueueDepth == nil || *out.HubBroadcastQueueDepth != 6 {
		t.Errorf("hub_broadcast_queue_depth = %v, want 6", out.HubBroadcastQueueDepth)
	}
	if out.HubSeqMuMaxHoldMs == nil || *out.HubSeqMuMaxHoldMs != 205.0 {
		t.Errorf("hub_seqmu_max_hold_ms = %v, want 205", out.HubSeqMuMaxHoldMs)
	}
	for key, v := range map[string]*metrics.Summary{"ws_broadcast_ms": out.WSBroadcastMs, "ws_dispatch_lag_ms": out.WSDispatchLagMs, "chat_send_ack_ms": out.ChatSendAckMs} {
		if v == nil {
			t.Errorf("%s missing", key)
		}
	}
}

// An externally managed (or unconfigured) LiveKit contributes no LiveKit
// fields at all: the panel must not read a fabricated "healthy".
func TestSupportHealth_UnmanagedOmitsLiveKitFields(t *testing.T) {
	data, err := json.Marshal(supportHealth(supportHealthHub{}, time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"livekit_managed", "livekit_healthy", "livekit_restarts", "livekit_gave_up"} {
		if _, exists := out[key]; exists {
			t.Errorf("unmanaged hub reported %q; the snapshot must not invent LiveKit state", key)
		}
	}
}

// A nil hub is tolerated (partial wirings and tests).
func TestSupportHealth_NilHub(t *testing.T) {
	out := supportHealth(nil, time.Now())
	if !out.DatabaseReadable {
		t.Errorf("database_readable = %v, want true", out.DatabaseReadable)
	}
	if out.ConnectedUsers != nil {
		t.Errorf("connected_users = %v, want absent", *out.ConnectedUsers)
	}
}

// supportHealthMetricsHub also satisfies the counter interface, so every
// optional group of the snapshot is filled.
type supportHealthMetricsHub struct{ supportHealthHub }

func (supportHealthMetricsHub) VoiceSessionCount() int     { return 2 }
func (supportHealthMetricsHub) BroadcastDropCount() uint64 { return 7 }
func (supportHealthMetricsHub) DispatchAlive() bool        { return false }
func (supportHealthMetricsHub) BackpressureStats() (uint64, uint64, uint64) {
	return 1, 0, 9
}
func (supportHealthMetricsHub) ReconnectTierStats() (uint64, uint64, uint64) {
	return 5, 0, 2
}
func (supportHealthMetricsHub) ConnRejectCount() uint64 { return 0 }

// legacySupportHealth is the map the typed snapshot replaced, kept here to
// prove health.json in the bundle did not change.
func legacySupportHealth(hub HubBroadcaster, at time.Time, goroutines int, heap uint64, gc uint32) map[string]any {
	out := map[string]any{"captured_at": at, "scope": supportHealthScope, "database_readable": true, "goroutines": goroutines, "heap_alloc_bytes": heap, "gc_cycles": gc}
	if hub != nil {
		out["connected_users"] = hub.UserCount()
	}
	if h, ok := hub.(supportHubMetrics); ok {
		out["voice_sessions"] = h.VoiceSessionCount()
		out["broadcast_drops"] = h.BroadcastDropCount()
		out["dispatch_alive"] = h.DispatchAlive()
		out["ws_connection_rejects"] = h.ConnRejectCount()
		out["queue_disconnects"], out["high_priority_fallbacks"], out["low_priority_drops"] = h.BackpressureStats()
		out["reconnect_buffer"], out["reconnect_database"], out["reconnect_full"] = h.ReconnectTierStats()
	}
	if h, ok := hub.(supportHubLatency); ok {
		out["topic_sheds_total"] = h.TopicShedCount()
		out["ws_broadcast_ms"] = h.BroadcastMs()
		out["ws_dispatch_lag_ms"] = h.DispatchLagMs()
		out["chat_send_ack_ms"] = h.ChatAckMs()
		out["hub_broadcast_queue_depth"] = h.BroadcastQueueDepth()
		out["hub_seqmu_max_hold_ms"] = h.SeqMuMaxHoldMs()
	}
	if v, ok := hub.(supportHubVoice); ok && v.LiveKitManaged() {
		status := v.LiveKitProcessStatus()
		out["livekit_managed"] = true
		out["livekit_healthy"] = status.Running
		out["livekit_restarts"] = status.Restarts
		out["livekit_gave_up"] = status.GaveUp
		if !status.NextRetryAt.IsZero() {
			out["livekit_next_retry_at"] = status.NextRetryAt.UTC()
		}
	}
	return out
}

// health.json is byte-identical to what the bundle wrote before the snapshot
// became a typed struct, for every combination of what the hub reports.
func TestSupportHealth_BundleBytesUnchanged(t *testing.T) {
	at := time.Date(2026, 11, 3, 19, 0, 0, 0, time.UTC)
	hubs := map[string]HubBroadcaster{
		"nil":             nil,
		"latency":         supportHealthHub{},
		"managed":         supportHealthHub{managed: true, status: livekitproc.Status{Restarts: 1, GaveUp: true, NextRetryAt: time.Date(2026, 11, 3, 19, 10, 0, 0, time.UTC)}},
		"metrics+managed": supportHealthMetricsHub{supportHealthHub{managed: true}},
	}
	for name, hub := range hubs {
		got := supportHealth(hub, at)
		want := legacySupportHealth(hub, at, got.Goroutines, got.HeapAllocBytes, got.GCCycles)
		gotJSON, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		wantJSON, err := json.MarshalIndent(want, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(gotJSON, wantJSON) {
			t.Errorf("%s: health.json changed\ngot:  %s\nwant: %s", name, gotJSON, wantJSON)
		}
	}
}

// Every field of the snapshot is in the byte test above, so a new field must
// be added there (and to the legacy map) on purpose.
func TestSupportHealth_FieldCount(t *testing.T) {
	if n := reflect.TypeFor[healthSnapshot]().NumField(); n != 28 {
		t.Errorf("healthSnapshot has %d fields; update TestSupportHealth_BundleBytesUnchanged and this count", n)
	}
}
