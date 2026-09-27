package admin

import (
	"testing"
	"time"

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
