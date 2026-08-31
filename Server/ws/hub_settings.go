package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The db-import-boundary rule and the boundaries-doc inventory track files by
// their db import. This file's persistence runs through the h.db field, which
// needs no import — so the import is pinned here deliberately, keeping the
// settings-ops reads on the inventory's books instead of invisible to it.
var _ *db.DB

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

// refreshSettingsLocked reloads server_name and motd from the DB.
// Caller must hold settingsMu (write lock) or call during init.
func (h *Hub) refreshSettingsLocked(ctx context.Context) {
	if h.db == nil {
		return
	}
	// The refresh serves the hub-wide settings cache, not the connection that
	// happened to trigger it — a dying connection's ctx must not fail the
	// fetches (the TTL stamp below would then pin stale values for 30s).
	ctx = context.WithoutCancel(ctx)
	if name, err := h.db.GetSetting(ctx, "server_name"); err == nil {
		h.settingsName = name
	}
	if motd, err := h.db.GetSetting(ctx, "motd"); err == nil {
		h.settingsMotd = motd
	}
	h.settingsLastUpdate = time.Now()
}
