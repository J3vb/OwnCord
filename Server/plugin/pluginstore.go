package plugin

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// PluginStore manages installed plugins and per-plugin KV namespaces.
// *db.DB satisfies it (the methods moved into the db package when the store
// abstraction was removed in D3).
type PluginStore interface {
	InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error)
	EnablePlugin(ctx context.Context, id int64) error
	DisablePlugin(ctx context.Context, id int64) error
	UninstallPlugin(ctx context.Context, id int64) error
	GetPlugin(ctx context.Context, id int64) (*db.PluginRow, error)
	GetPluginByName(ctx context.Context, name string) (*db.PluginRow, error)
	ListPlugins(ctx context.Context) ([]db.PluginRow, error)

	PluginKVGet(ctx context.Context, pluginID int64, key string) ([]byte, error)
	PluginKVSet(ctx context.Context, pluginID int64, key string, value []byte) error
	PluginKVDelete(ctx context.Context, pluginID int64, key string) error
	PluginKVScan(ctx context.Context, pluginID int64, prefix string, limit int) (map[string][]byte, error)
}
