package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/hubsettings"
)

// SettingsReader is the hub's view of the settings family: one keyed read.
type SettingsReader = hubsettings.Reader

func (h *Hub) getCachedSettings(ctx context.Context) (string, string) {
	return h.settings.cache.Get(ctx)
}

func (h *Hub) cachedUploadPolicy(ctx context.Context) UploadPolicy {
	return h.settings.cache.UploadPolicy(ctx)
}

// ExpireSettingsCache marks the cached server_name, motd and upload lists stale, so the next auth_ok
// or ready re-reads them instead of serving values up to hubsettings.TTL old. Call it after a write
// to those settings commits: Expire waits out a refresh in flight, so a refresh that read the old
// values before the commit cannot stamp them fresh after it.
func (h *Hub) ExpireSettingsCache() {
	h.settings.cache.Expire()
}

const uploadPolicyReadTimeout = 5 * time.Second

// BroadcastUploadPolicy re-reads the upload file-type lists into the settings cache and sends them
// to every client as upload_policy, so an admin save reaches open composers without a reconnect. A
// failed read sends nothing (the upload route stays authoritative).
// Unsequenced, sent straight to each client: auth_ok carries the lists on every connect and resume,
// so a replayed older frame could only overwrite newer ones. A client with a full queue is
// disconnected (trySendMsg) and gets current lists in its next auth_ok. Saves are serialised end to
// end, so two close together leave the later one. The read runs against Background with its own
// bound (HubBroadcaster carries no context).
func (h *Hub) BroadcastUploadPolicy() {
	fileTypes := h.settings.cache.FileTypes()
	if fileTypes == nil {
		return
	}
	h.settings.uploadPolicyMu.Lock()
	defer h.settings.uploadPolicyMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), uploadPolicyReadTimeout)
	defer cancel()
	p, err := fileTypes.FileTypePolicy(ctx)
	if err != nil {
		slog.Warn("upload_policy: reading the upload file-type policy failed", "error", err)
		return
	}
	h.settings.cache.SetUploadLists(p.Blocked, p.Allowed)
	msg := buildUploadPolicy(p.Blocked, p.Allowed)
	for _, c := range h.clientSnapshot() {
		c.trySendMsg(msg)
	}
}

type gameActivityState struct {
	// on is written only under mu (and once at build); read lock-free by the handler, ready and
	// auth_ok, and under presenceFeed.mu by applyActivity and the presence emitters.
	on atomic.Bool
	mu syncutil.Ranked[lockRankSerialiser] // orders ApplyGameActivityPolicy's saves
}

const gameActivityReadTimeout = 5 * time.Second

func (h *Hub) readGameActivitySwitch(ctx context.Context) (enabled, ok bool, err error) {
	return service.GameActivityEnabledFromRead(h.settings.cache.Reader().Setting(ctx, service.GameActivityEnabledKey))
}

// initGameActivityPolicy sets the switch from the stored setting at build; an unreadable setting
// turns it off (fail closed: the admin may have turned it off) and warns.
func (h *Hub) initGameActivityPolicy() {
	ctx, cancel := context.WithTimeout(context.Background(), gameActivityReadTimeout)
	defer cancel()
	enabled, ok, err := h.readGameActivitySwitch(ctx)
	if !ok {
		slog.Warn("game_activity_policy: reading the setting failed", "stage", "init", "error", err)
		enabled = false
	}
	h.settings.gameActivity.on.Store(enabled)
}

// ApplyGameActivityPolicy makes the hub follow the saved switch: re-read the stored value (saved if
// that fails), store the flag, clear every shown game when off, and send game_activity_policy to
// every client.
// Saves are serialised end to end (gameActivity.mu) and re-read under it, so two close together
// leave the database's last one. The flag is stored before the sweep takes presenceFeed.mu: a set
// reaching applyActivity after the sweep sees false and is dropped, one before it is cleared by the
// sweep (higher seq). The policy frame goes out after presenceFeed.mu is released, unsequenced and
// direct (like upload_policy; auth_ok carries the value on every connect).
// Lock order: gameActivity.mu, the settings read, presenceFeed.mu, Hub.mu (read), then the client
// leaves. The read runs against Background with its own bound.
func (h *Hub) ApplyGameActivityPolicy(saved bool) {
	h.settings.gameActivity.mu.Lock()
	defer h.settings.gameActivity.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), gameActivityReadTimeout)
	defer cancel()
	enabled, ok, err := h.readGameActivitySwitch(ctx)
	if !ok {
		slog.Warn("game_activity_policy: reading the setting failed", "stage", "apply", "error", err)
		enabled = saved
	}
	h.settings.gameActivity.on.Store(enabled)
	if !enabled {
		h.clearAllGameActivity()
	}
	msg := buildGameActivityPolicy(enabled)
	for _, c := range h.clientSnapshot() {
		c.trySendMsg(msg)
	}
}

// clearAllGameActivity clears every connection's game and song through swapActivityLocked
// (sequenced presence for a visible user, the user's own frame for an invisible one, a queued
// connect entry superseded). presenceFeed.mu is held across the sweep so no set or older presence
// lands between clears; no I/O under it.
func (h *Hub) clearAllGameActivity() {
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	for _, c := range h.clientSnapshot() {
		h.clearActivityAndListeningLocked(c)
	}
}

func (h *Hub) clientSnapshot() []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.allClientsLocked()
}

// hubSettings groups the settings cache, upload-policy serialiser, game activity switch and video
// cap. It holds ranked locks (lock_order.go); never copy it.
// uploadPolicyMu orders BroadcastUploadPolicy's saves.
type hubSettings struct {
	cache          hubsettings.Cache
	uploadPolicyMu syncutil.Ranked[lockRankSerialiser]
	gameActivity   gameActivityState
	videoCap       videoCapState
	// linkPreviews is whether the unfurl workers run; set once at start, read lock-free by ready.
	linkPreviews atomic.Bool
}

// SetLinkPreviews records whether the server builds link previews (the unfurl workers are
// running), which ready advertises as capabilities.link_previews.
func (h *Hub) SetLinkPreviews(on bool) { h.settings.linkPreviews.Store(on) }
