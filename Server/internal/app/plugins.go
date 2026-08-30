package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
)

// initPlugins constructs the plugin runtime, returning nil when plugins
// are disabled or failed to start.
func initPlugins(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) *plugin.Registry {
	var pluginRegistry *plugin.Registry
	if cfg.Plugins.Enabled {
		registry, plugErr := plugin.NewRegistry(plugin.Config{
			Directory:     cfg.Plugins.Directory,
			MaxMemoryMB:   cfg.Plugins.MaxMemoryMB,
			CPUBudgetMs:   cfg.Plugins.CPUBudgetMs,
			HTTPAllowlist: cfg.Plugins.HTTPAllowlist,
			Store:         database,
		})
		if plugErr != nil {
			log.Warn("plugin runtime init failed; continuing without plugins", "error", plugErr)
		} else {
			pluginRegistry = registry
			if err := registry.LoadAll(bgCtx); err != nil {
				log.Warn("plugin loader: failed to scan directory", "error", err)
			}
		}
	}

	return pluginRegistry
}

// closePlugins shuts the plugin runtime down. A nil registry is the disabled
// case and has nothing to close. ctx is App.Close's shutdown budget: the 5s
// cap here is this step's own share of it, not a fresh root, so a wedged
// plugin cannot push teardown past the budget the operator was told about.
func closePlugins(ctx context.Context, registry *plugin.Registry) {
	if registry == nil {
		return
	}

	closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = registry.Close(closeCtx)
}
