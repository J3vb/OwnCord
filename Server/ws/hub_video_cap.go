package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// videoCapState is the server-wide video upload cap per person: the value in
// bits per second (0 = no cap) and the serialiser that orders its saves.
type videoCapState struct {
	// bitrate is written only under mu, and once when the hub is built; read
	// lock-free by auth_ok.
	bitrate atomic.Int64
	mu      syncutil.Ranked[lockRankSerialiser] // orders ApplyVideoBitrateCap's saves
}

// applyVideoCapAfterSnapshotHook, when non-nil, runs in ApplyVideoBitrateCap
// right after the client snapshot, before the sends. Test-only: a connection it
// registers is missing from the snapshot, so it must read the new value from
// the store, which pins the store-before-snapshot order.
var applyVideoCapAfterSnapshotHook func()

// videoCapReadTimeout bounds the video cap's settings read.
const videoCapReadTimeout = 5 * time.Second

// readVideoBitrateCap reads the stored cap in bits per second: a missing row
// means no cap. ok is false when the read failed.
func (h *Hub) readVideoBitrateCap(ctx context.Context) (bitrate int, ok bool, err error) {
	return service.VoiceMaxVideoBitrateFromRead(h.settings.cache.Reader().Setting(ctx, service.VoiceMaxVideoKbpsKey))
}

// initVideoBitrateCap sets the cap from the stored setting when the hub is built.
// An unreadable setting leaves no cap (the behaviour before the setting existed)
// and logs a warning; the next save sets it.
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

// videoBitrateCap is the cap in force, in bits per second (0 = no cap).
func (h *Hub) videoBitrateCap() int {
	return int(h.settings.videoCap.bitrate.Load())
}

// ApplyVideoBitrateCap makes the hub follow the saved video cap: it re-reads the
// stored value (savedKbps is used if that fails), stores it, and sends
// video_bitrate_cap to every connected client, so a share or camera already live
// follows the new cap without a rejoin.
//
// Saves are serialised end to end (videoCap.mu) and the value is re-read under it,
// so two close together leave the hub and clients on the database's last one.
// The value is stored before the client snapshot: a connection registered after
// the snapshot builds its auth_ok after the store and reads the new value, and
// one in the snapshot gets the frame on its send queue, which drains only after
// its auth_ok. Unsequenced, like game_activity_policy: auth_ok carries the same
// value on every connect and resume.
//
// Lock order: videoCap.mu, then the settings read, then Hub.mu (read), then the
// client leaves. The read runs against Background with its own bound (the
// HubBroadcaster interface carries no context).
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
