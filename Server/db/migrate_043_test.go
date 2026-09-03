package db

import (
	"context"
	"io/fs"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/migrations"
)

// Migration 043 closes first-run setup on any installation that has already
// been set up. A live users row is the obvious evidence, but an erasure can
// have emptied that table before the migration runs — a marker replay erases
// past the last-admin guard — and such a server must upgrade closed. The
// audit rows an erasure unlinks rather than deletes, and the erasure_jobs
// row it writes, are the traces that say so (Codex's fourth review of #1523).
func TestMigration043_ClosesSetupOnEveryTraceOfAPriorLife(t *testing.T) {
	ctx := context.Background()
	raw, err := fs.ReadFile(migrations.FS, "043_setup_completed.sql")
	if err != nil {
		t.Fatal(err)
	}
	var update string
	for _, stmt := range splitStatements(string(raw)) {
		if strings.Contains(strings.ToUpper(stmt), "UPDATE SETTINGS") {
			update = stmt
		}
	}
	if update == "" {
		t.Fatal("no UPDATE statement in migration 043")
	}

	cases := []struct {
		name  string
		seed  func(t *testing.T, database *DB)
		close bool
	}{
		{name: "a fresh database has never been set up", seed: func(*testing.T, *DB) {}},
		{
			name: "a live user closes it",
			seed: func(t *testing.T, database *DB) {
				if _, err := database.CreateUser(ctx, "still-here", "hash", 1); err != nil {
					t.Fatal(err)
				}
			},
			close: true,
		},
		{
			name: "the erasure's own audit row closes it, the users table having been emptied",
			seed: func(t *testing.T, database *DB) {
				if err := database.LogAuditEntry(ctx, AuditEntry{Action: "account_deleted", TargetType: "user", SubjectToken: "tok"}); err != nil {
					t.Fatal(err)
				}
			},
			close: true,
		},
		{
			name: "the setup row closes it",
			seed: func(t *testing.T, database *DB) {
				if err := database.LogAuditEntry(ctx, AuditEntry{Action: "server_setup", TargetType: "server"}); err != nil {
					t.Fatal(err)
				}
			},
			close: true,
		},
		{
			name: "a replayed erasure closes it",
			seed: func(t *testing.T, database *DB) {
				if err := database.LogAuditEntry(ctx, AuditEntry{Action: "account_erasure_replayed", TargetType: "user", SubjectToken: "tok"}); err != nil {
					t.Fatal(err)
				}
			},
			close: true,
		},
		{
			// A server that was never set up still writes audit rows: the
			// maintenance loop takes the scheduled backup migration 001
			// enables by default, with actor 0 and no user in existence.
			// Closing setup on those would deny it its own first run.
			name: "the maintenance loop's own rows leave it open",
			seed: func(t *testing.T, database *DB) {
				for _, action := range []string{"backup_create", "backup_delete"} {
					if err := database.LogAuditEntry(ctx, AuditEntry{Action: action, TargetType: "server", Detail: "scheduled backup saved: x"}); err != nil {
						t.Fatal(err)
					}
				}
			},
		},
		{
			name: "an erasure job closes it",
			seed: func(t *testing.T, database *DB) {
				if _, err := database.writer.ExecContext(ctx,
					`INSERT INTO erasure_jobs (user_id, state, files) VALUES (7, 'done', '[]')`); err != nil {
					t.Fatal(err)
				}
			},
			close: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			database := openMigratedMemoryInternal(t)
			// Undo the migration's own effect, then seed the state an
			// upgrading installation would be in.
			if _, err := database.writer.ExecContext(ctx,
				`UPDATE settings SET value = '0' WHERE key = 'setup_completed'`); err != nil {
				t.Fatal(err)
			}
			if _, err := database.writer.ExecContext(ctx, `DELETE FROM users`); err != nil {
				t.Fatal(err)
			}
			if _, err := database.writer.ExecContext(ctx, `DELETE FROM audit_log`); err != nil {
				t.Fatal(err)
			}
			tc.seed(t, database)

			if _, err := database.writer.ExecContext(ctx, update); err != nil {
				t.Fatalf("migration statement: %v\n%s", err, update)
			}
			var got string
			if err := database.reader.QueryRowContext(ctx,
				`SELECT value FROM settings WHERE key = 'setup_completed'`).Scan(&got); err != nil {
				t.Fatal(err)
			}
			want := "0"
			if tc.close {
				want = "1"
			}
			if got != want {
				t.Errorf("setup_completed = %q, want %q", got, want)
			}
		})
	}
}
