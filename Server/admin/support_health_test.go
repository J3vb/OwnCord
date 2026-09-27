package admin

import (
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/ws"
)

// supportHealthHub is the narrow fake the health snapshot reads through: the
// hub broadcaster subset plus the LiveKit supervisor accessors added by SRE-04.
type supportHealthHub struct {
	HubBroadcaster
	managed bool
	status  ws.LiveKitProcessStatus
}

func (h supportHealthHub) LiveKitManaged() bool                          { return h.managed }
func (h supportHealthHub) LiveKitProcessStatus() ws.LiveKitProcessStatus { return h.status }
func (h supportHealthHub) ClientCount() int                              { return 3 }

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
	hub := supportHealthHub{managed: true, status: ws.LiveKitProcessStatus{Running: true, Restarts: 2}}
	out := supportHealth(hub, time.Now())

	if out["livekit_managed"] != true {
		t.Errorf("livekit_managed = %v, want true", out["livekit_managed"])
	}
	if out["livekit_healthy"] != true {
		t.Errorf("livekit_healthy = %v, want true", out["livekit_healthy"])
	}
	if out["livekit_restarts"] != 2 {
		t.Errorf("livekit_restarts = %v, want 2", out["livekit_restarts"])
	}
	if out["livekit_gave_up"] != false {
		t.Errorf("livekit_gave_up = %v, want false", out["livekit_gave_up"])
	}
	if out["connected_users"] != 3 {
		t.Errorf("connected_users = %v, want 3", out["connected_users"])
	}
}

// The support bundle carries SRE-M1's latency surface as aggregate numbers:
// the shed counter, the three histograms, the queue-depth gauge and the
// max-seqMu-hold gauge.
func TestSupportHealth_LatencyFields(t *testing.T) {
	out := supportHealth(supportHealthHub{}, time.Now())
	if out["topic_sheds_total"] != uint64(4) {
		t.Errorf("topic_sheds_total = %v, want 4", out["topic_sheds_total"])
	}
	if out["hub_broadcast_queue_depth"] != 6 {
		t.Errorf("hub_broadcast_queue_depth = %v, want 6", out["hub_broadcast_queue_depth"])
	}
	if out["hub_seqmu_max_hold_ms"] != 205.0 {
		t.Errorf("hub_seqmu_max_hold_ms = %v, want 205", out["hub_seqmu_max_hold_ms"])
	}
	for _, key := range []string{"ws_broadcast_ms", "ws_dispatch_lag_ms", "chat_send_ack_ms"} {
		if _, ok := out[key].(metrics.Summary); !ok {
			t.Errorf("%s = %T, want metrics.Summary", key, out[key])
		}
	}
}

// The bundle carries the aggregated goroutine summary (function names and
// counts), never a full dump with argument values (SRE-M1 / SRE-03).
func TestSupportHealth_GoroutineSummaryIsAggregated(t *testing.T) {
	out := supportHealth(nil, time.Now())
	summary, ok := out["goroutine_summary"].(string)
	if !ok {
		t.Fatalf("goroutine_summary = %T, want string", out["goroutine_summary"])
	}
	// This test's own goroutine is running, so the profile must be non-empty
	// and start with the aggregated header pprof writes for debug=1.
	if summary == "" {
		t.Fatal("goroutine_summary is empty; the profile could not be read")
	}
	if !strings.Contains(summary, "goroutine profile:") {
		t.Errorf("goroutine_summary does not look like an aggregated profile: %.80q", summary)
	}
}

// An externally managed (or unconfigured) LiveKit contributes no LiveKit
// fields at all: the panel must not read a fabricated "healthy".
func TestSupportHealth_UnmanagedOmitsLiveKitFields(t *testing.T) {
	out := supportHealth(supportHealthHub{}, time.Now())
	for _, key := range []string{"livekit_managed", "livekit_healthy", "livekit_restarts", "livekit_gave_up"} {
		if _, exists := out[key]; exists {
			t.Errorf("unmanaged hub reported %q; the snapshot must not invent LiveKit state", key)
		}
	}
}

// A nil hub is tolerated (partial wirings and tests).
func TestSupportHealth_NilHub(t *testing.T) {
	out := supportHealth(nil, time.Now())
	if out["database_readable"] != true {
		t.Errorf("database_readable = %v, want true", out["database_readable"])
	}
}
