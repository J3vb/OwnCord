package ws

import (
	"context"
	"log/slog"
	"time"
)

// SettingsReader is the hub's view of the settings family: one keyed read.
// service.SettingsService satisfies it in production; test helpers back it
// with a service over the test database. Defined on the consumer side so ws
// depends on the capability, not the provider.
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
	// Double-check after acquiring write lock.
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
	// The refresh serves the hub-wide settings cache, not the connection that
	// happened to trigger it — a dying connection's ctx must not fail the
	// fetches (the TTL stamp below would then pin stale values for 30s).
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

// cachedUploadPolicy returns auth_ok's upload_policy, refreshing its
// extension lists with the rest of the settings cache when it is stale.
func (h *Hub) cachedUploadPolicy(ctx context.Context) UploadPolicy {
	h.getCachedSettings(ctx)
	h.settingsMu.RLock()
	defer h.settingsMu.RUnlock()
	return h.settingsUpload
}

// uploadPolicyReadTimeout bounds BroadcastUploadPolicy's settings read.
const uploadPolicyReadTimeout = 5 * time.Second

// BroadcastUploadPolicy re-reads the upload file-type lists into the settings
// cache and sends them to every connected client as upload_policy, so a list
// the owner saves in the admin panel reaches open composers without a
// reconnect. The cache is refreshed first, so an auth_ok built after the save
// carries the new lists too. A failed read sends nothing: clients keep the
// lists they have, and the upload route stays authoritative either way.
//
// Unsequenced, sent straight to each connected client: the lists are a
// snapshot that auth_ok already carries on every connect and resume, so a
// replayed older frame could only overwrite the newer lists auth_ok just
// gave. A client whose queue is full is disconnected (trySendMsg) and gets
// the current lists in its next auth_ok.
//
// Saves are serialised end to end, so two close together leave clients and
// the cache on the later one. The admin HubBroadcaster interface carries no
// context, so the read runs against Background with its own bound.
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
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		c.trySendMsg(msg)
	}
}
