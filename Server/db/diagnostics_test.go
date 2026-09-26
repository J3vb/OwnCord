package db_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

func TestDiagnostics_ExportsCompiledNamesAndCountsOnly(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := db.MigrateFS(database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE secret_table_name(value TEXT DEFAULT 'private-default')`,
		`INSERT INTO schema_versions(version) VALUES('private-migration-name')`,
		`INSERT INTO users(username,password,role_id) VALUES('private-user','private-password',4)`,
	} {
		if _, err := database.SQLDb().Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := database.Diagnostics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"secret_table_name", "private-default", "private-migration-name", "private-user", "private-password"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("snapshot exposed %s", secret)
		}
	}
	if len(snapshot.Migrations) < 50 {
		t.Fatal("applied migration catalog missing")
	}
	users := int64(-1)
	for _, table := range snapshot.Tables {
		if table.Name == "users" {
			users = table.Rows
		}
	}
	if users != 1 {
		t.Fatalf("users count = %d", users)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := database.Diagnostics(ctx); err == nil {
		t.Fatal("canceled diagnostic query succeeded")
	}
}
