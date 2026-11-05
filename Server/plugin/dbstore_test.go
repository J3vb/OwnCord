package plugin

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// openPluginTestDB opens an in-memory database with the full migration set
// applied (the plugins and plugin_kv tables live in migration 015). *db.DB
// satisfies the PluginStore interface directly — D3 removed the store
// abstraction and its MemStore fake, so plugin tests run against a real DB.
func openPluginTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	mustDo(t, "db.Open", err)
	t.Cleanup(func() { _ = database.Close() })
	mustDo(t, "db.Migrate", db.Migrate(database))
	return database
}
