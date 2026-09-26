package ws

import (
	"context"
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
// reader. Caller must hold settingsMu (write lock) or call during init.
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
	h.settingsLastUpdate = time.Now()
}
