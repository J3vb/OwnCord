package admin

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// SystemDatabase is the database card's figures, read by
// SystemSources.Database. Sizes are 0 for an in-memory database.
type SystemDatabase struct {
	FileBytes       int64   `json:"file_bytes"`
	WALBytes        int64   `json:"wal_bytes"`
	SchemaVersion   string  `json:"schema_version"`
	ReadersInUse    int     `json:"readers_in_use"`
	ReadersOpen     int     `json:"readers_open"`
	ReadersMax      int     `json:"readers_max"`
	ReaderWaitCount int64   `json:"reader_wait_count"`
	ReaderWaitMs    float64 `json:"reader_wait_ms"`
	WriterWaitCount int64   `json:"writer_wait_count"`
	WriterWaitMs    float64 `json:"writer_wait_ms"`
}

// systemHealthDBTimeout bounds the database read, so a locked or slow
// database shows its card as unreadable instead of holding the page.
const systemHealthDBTimeout = 2 * time.Second

// Database card states.
const (
	systemDBOK          = "ok"
	systemDBTimeout     = "timeout"
	systemDBUnreadable  = "unreadable"
	systemDBNotMeasured = "not_measured"
)

type systemHealthResponse struct {
	CapturedAt time.Time `json:"captured_at"`
	// Snapshot is health.json from the support bundle, byte for byte the same
	// shape, so "Copy for support" hands over what a bundle would carry.
	Snapshot healthSnapshot       `json:"snapshot"`
	Hub      systemHealthHub      `json:"hub"`
	Database systemHealthDatabase `json:"database"`
	Process  systemHealthProcess  `json:"process"`
	LiveKit  systemHealthLiveKit  `json:"livekit"`
	// Signals are the attention panel's current measurements; each card
	// shows the ones that belong to it, so there is one warning system.
	Signals []service.AttentionSignal `json:"signals"`
}

type systemHealthHub struct {
	// Connections counts sockets (an account on two devices counts twice);
	// null when the hub does not report it.
	Connections *int `json:"connections"`
	// MaxConnections is server.max_ws_connections; 0 is unlimited.
	MaxConnections int `json:"max_connections"`
}

type systemHealthDatabase struct {
	Status string          `json:"status"`
	Stats  *SystemDatabase `json:"stats"`
}

type systemHealthProcess struct {
	UptimeSeconds *int64         `json:"uptime_seconds"`
	Build         map[string]any `json:"build"`
}

type systemHealthLiveKit struct {
	// Managed: OwnCord runs LiveKit itself, and the snapshot carries the
	// supervisor's state. An external LiveKit's figures are on the
	// Dashboard's LiveKit card.
	Managed bool `json:"managed"`
}

// handleGetSystemHealth serves the System health page: the support bundle's
// health snapshot plus the database, process and connection figures around
// it. Everything is read in process; only the database card touches the
// database, under systemHealthDBTimeout.
func handleGetSystemHealth(src SystemSources, hub HubBroadcaster, attention *service.AttentionService, version string, now func() time.Time) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		at := now().UTC()
		resp := systemHealthResponse{
			CapturedAt: at,
			Snapshot:   supportHealth(hub, at),
			Hub:        systemHealthHub{MaxConnections: src.MaxWSConnections},
			Database:   readSystemDatabase(r.Context(), src.Database),
			Process:    systemHealthProcess{Build: supportBuild(version)},
			Signals:    []service.AttentionSignal{},
		}
		if c, ok := hub.(interface{ ClientCount() int }); ok {
			resp.Hub.Connections = ptr(c.ClientCount())
		}
		if !src.Started.IsZero() {
			resp.Process.UptimeSeconds = ptr(int64(at.Sub(src.Started) / time.Second))
		}
		if v, ok := hub.(supportHubVoice); ok {
			resp.LiveKit.Managed = v.LiveKitManaged()
		}
		if attention != nil {
			resp.Signals = attention.Report().Signals
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func readSystemDatabase(parent context.Context, read func(context.Context) (SystemDatabase, error)) systemHealthDatabase {
	if read == nil {
		return systemHealthDatabase{Status: systemDBNotMeasured}
	}
	ctx, cancel := context.WithTimeout(parent, systemHealthDBTimeout)
	defer cancel()
	stats, err := read(ctx)
	switch {
	case err == nil:
		return systemHealthDatabase{Status: systemDBOK, Stats: &stats}
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
		return systemHealthDatabase{Status: systemDBTimeout}
	default:
		return systemHealthDatabase{Status: systemDBUnreadable}
	}
}
