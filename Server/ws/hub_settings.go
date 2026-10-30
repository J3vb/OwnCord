package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SettingsReader is the hub's view of the settings family: one keyed read.
// Defined on the consumer side so ws depends on the capability, not the provider.
type SettingsReader interface {
	Setting(ctx context.Context, key string) (string, error)
}

// getCachedSettings returns server_name and motd, refreshing the cache if stale.
func (h *Hub) getCachedSettings(ctx context.Context) (string, string) {
	h.settingsMu.RLock()
	if time.Since(h.settingsLastUpdate) < settingsCacheTTL {
		name, motd := h.settingsName, h.settingsMotd
		h.settingsMu.RUnlock()
		return name, motd
	}
	h.settingsMu.RUnlock()

	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	if time.Since(h.settingsLastUpdate) < settingsCacheTTL {
		return h.settingsName, h.settingsMotd
	}
	h.refreshSettingsLocked(ctx)
	return h.settingsName, h.settingsMotd
}

// refreshSettingsLocked reloads server_name and motd through the settings
// reader, and upload_policy's extension lists. Caller must hold settingsMu
// (write lock) or call during init.
func (h *Hub) refreshSettingsLocked(ctx context.Context) {
	// The refresh serves the hub-wide cache, not the connection that triggered it: a
	// dying connection's ctx must not fail the fetches, or the TTL stamp below would
	// pin stale values for 30s.
	ctx = context.WithoutCancel(ctx)
	if name, err := h.settings.Setting(ctx, "server_name"); err == nil {
		h.settingsName = name
	}
	if motd, err := h.settings.Setting(ctx, "motd"); err == nil {
		h.settingsMotd = motd
	}
	if h.uploadFileTypes != nil {
		if p, err := h.uploadFileTypes.FileTypePolicy(ctx); err == nil {
			h.settingsUpload.BlockedExtensions, h.settingsUpload.AllowedExtensions = p.Blocked, p.Allowed
		} else {
			slog.Warn("auth_ok: reading the upload file-type policy failed", "error", err)
		}
	}
	h.settingsLastUpdate = time.Now()
}

// cachedUploadPolicy returns auth_ok's upload_policy, refreshed with the settings
// cache when stale.
func (h *Hub) cachedUploadPolicy(ctx context.Context) UploadPolicy {
	h.getCachedSettings(ctx)
	h.settingsMu.RLock()
	defer h.settingsMu.RUnlock()
	return h.settingsUpload
}

// uploadPolicyReadTimeout bounds BroadcastUploadPolicy's settings read.
const uploadPolicyReadTimeout = 5 * time.Second

// BroadcastUploadPolicy re-reads the upload file-type lists into the settings cache
// and sends them to every connected client as upload_policy, so a list saved in the
// admin panel reaches open composers without a reconnect. A failed read sends
// nothing: clients keep their lists, and the upload route stays authoritative.
//
// Unsequenced, sent straight to each client: auth_ok already carries the lists on
// every connect and resume, so a replayed older frame could only overwrite newer
// lists. A client whose queue is full is disconnected (trySendMsg) and gets the
// current lists in its next auth_ok.
//
// Saves are serialised end to end, so two close together leave clients and the
// cache on the later one. The admin HubBroadcaster interface carries no context, so
// the read runs against Background with its own bound.
func (h *Hub) BroadcastUploadPolicy() {
	if h.uploadFileTypes == nil {
		return
	}
	h.uploadPolicyMu.Lock()
	defer h.uploadPolicyMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), uploadPolicyReadTimeout)
	defer cancel()
	p, err := h.uploadFileTypes.FileTypePolicy(ctx)
	if err != nil {
		slog.Warn("upload_policy: reading the upload file-type policy failed", "error", err)
		return
	}
	h.settingsMu.Lock()
	h.settingsUpload.BlockedExtensions, h.settingsUpload.AllowedExtensions = p.Blocked, p.Allowed
	h.settingsMu.Unlock()
	msg := buildUploadPolicy(p.Blocked, p.Allowed)
	for _, c := range h.clientSnapshot() {
		c.trySendMsg(msg)
	}
}

// gameActivityState is the per-server game activity switch: the flag and the
// serialiser that orders its saves.
type gameActivityState struct {
	// on is written only under mu, and once when the hub is built; read
	// lock-free by the handler, ready and auth_ok, and under presenceMu by
	// applyActivity and the presence emitters.
	on atomic.Bool
	mu syncutil.Ranked[lockRankSerialiser] // orders ApplyGameActivityPolicy's saves
}

// gameActivityReadTimeout bounds the game activity switch's settings read.
const gameActivityReadTimeout = 5 * time.Second

// readGameActivitySwitch reads the stored game activity switch: a missing row
// means on. ok is false when the read failed.
func (h *Hub) readGameActivitySwitch(ctx context.Context) (enabled, ok bool, err error) {
	return service.GameActivityEnabledFromRead(h.settings.Setting(ctx, service.GameActivityEnabledKey))
}

// initGameActivityPolicy sets the switch from the stored setting when the hub is
// built. An unreadable setting turns it off (fail closed: the admin may have turned
// it off) and logs a warning.
func (h *Hub) initGameActivityPolicy() {
	ctx, cancel := context.WithTimeout(context.Background(), gameActivityReadTimeout)
	defer cancel()
	enabled, ok, err := h.readGameActivitySwitch(ctx)
	if !ok {
		slog.Warn("game_activity_policy: reading the setting failed", "stage", "init", "error", err)
		enabled = false
	}
	h.gameActivity.on.Store(enabled)
}

// ApplyGameActivityPolicy makes the hub follow the saved game activity switch: it
// re-reads the stored value (saved is used if that fails), stores it in the flag,
// clears every shown game when off, and sends game_activity_policy to every
// connected client.
//
// Saves are serialised end to end (gameActivity.mu) and the value is re-read under
// it, so two close together leave the hub on the database's last one. The flag is
// stored before the sweep takes presenceMu: a set reaching applyActivity after the
// sweep sees false and is dropped, and one that got there first is cleared by the
// sweep, whose frame has the higher seq. The policy frame goes out after presenceMu
// is released, unsequenced and straight to each client (like upload_policy), since
// auth_ok carries the same value on every connect and resume.
//
// Lock order: gameActivity.mu, then the settings read, then presenceMu, then Hub.mu
// (read), then the client leaves. The read runs against Background with its own
// bound (the HubBroadcaster interface carries no context).
func (h *Hub) ApplyGameActivityPolicy(saved bool) {
	h.gameActivity.mu.Lock()
	defer h.gameActivity.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), gameActivityReadTimeout)
	defer cancel()
	enabled, ok, err := h.readGameActivitySwitch(ctx)
	if !ok {
		slog.Warn("game_activity_policy: reading the setting failed", "stage", "apply", "error", err)
		enabled = saved
	}
	h.gameActivity.on.Store(enabled)
	if !enabled {
		h.clearAllGameActivity()
	}
	msg := buildGameActivityPolicy(enabled)
	for _, c := range h.clientSnapshot() {
		c.trySendMsg(msg)
	}
}

// clearAllGameActivity clears every connection's shown game and song through the
// ordinary clear path (swapActivityLocked): sequenced presence for a visible user,
// the user's own frame only for an invisible one, and a queued connect entry
// superseded. presenceMu is held across the sweep so no set or older presence frame
// lands between two clears; nothing under it does I/O.
func (h *Hub) clearAllGameActivity() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	for _, c := range h.clientSnapshot() {
		h.clearActivityAndListeningLocked(c)
	}
}

// clientSnapshot lists the connected clients, taken under Hub.mu (read).
func (h *Hub) clientSnapshot() []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.allClientsLocked()
}
