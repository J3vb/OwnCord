package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// videoCapState is the server-wide per-person video upload cap in bits per second (0 = no cap) and
// the serialiser ordering its saves.
type videoCapState struct {
	// bitrate is written only under mu (and once at build); read lock-free by auth_ok.
	bitrate atomic.Int64
	mu      syncutil.Ranked[lockRankSerialiser] // orders ApplyVideoBitrateCap's saves
}

// applyVideoCapAfterSnapshotHook runs in ApplyVideoBitrateCap after the client snapshot, before the
// sends. Test-only: a connection it registers is missing from the snapshot and must read the new
// value from the store, pinning store-before-snapshot.
var applyVideoCapAfterSnapshotHook func()

const videoCapReadTimeout = 5 * time.Second

func (h *Hub) readVideoBitrateCap(ctx context.Context) (bitrate int, ok bool, err error) {
	return service.VoiceMaxVideoBitrateFromRead(h.settings.cache.Reader().Setting(ctx, service.VoiceMaxVideoKbpsKey))
}

// initVideoBitrateCap sets the cap from the stored setting at build; an unreadable setting leaves
// no cap and warns.
func (h *Hub) initVideoBitrateCap() {
	ctx, cancel := context.WithTimeout(context.Background(), videoCapReadTimeout)
	defer cancel()
	bitrate, ok, err := h.readVideoBitrateCap(ctx)
	if !ok {
		slog.Warn("video_bitrate_cap: reading the setting failed", "stage", "init", "error", err)
		bitrate = 0
	}
	h.settings.videoCap.bitrate.Store(int64(bitrate))
}

func (h *Hub) videoBitrateCap() int {
	return int(h.settings.videoCap.bitrate.Load())
}

// ApplyVideoBitrateCap makes the hub follow the saved cap: re-read the stored value (savedKbps if
// that fails), store it, and send video_bitrate_cap to every client so a live share or camera
// follows without a rejoin.
// Saves are serialised end to end (videoCap.mu) and re-read under it, so two close together leave
// the database's last one. The value is stored before the client snapshot: a connection registered
// after builds auth_ok from the new value, and one in the snapshot gets the frame on a queue that
// drains after its auth_ok. Unsequenced like game_activity_policy.
// Lock order: videoCap.mu, the settings read, Hub.mu (read), then the client leaves. The read runs
// against Background with its own bound.
func (h *Hub) ApplyVideoBitrateCap(savedKbps int) {
	h.settings.videoCap.mu.Lock()
	defer h.settings.videoCap.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), videoCapReadTimeout)
	defer cancel()
	bitrate, ok, err := h.readVideoBitrateCap(ctx)
	if !ok {
		slog.Warn("video_bitrate_cap: reading the setting failed", "stage", "apply", "error", err)
		bitrate = savedKbps * 1000
	}
	h.settings.videoCap.bitrate.Store(int64(bitrate))
	msg := buildVideoBitrateCap(bitrate)
	clients := h.clientSnapshot()
	if applyVideoCapAfterSnapshotHook != nil {
		applyVideoCapAfterSnapshotHook()
	}
	for _, c := range clients {
		c.trySendMsg(msg)
	}
}
