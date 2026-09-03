package admin

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// TestApplyAndRestart_AuditsTheOutcome pins OC-0391: replacing the running
// server binary must leave an audit row behind, and so must failing to.
//
// Until this fix handleApplyUpdate was not handed a database at all, so this
// file wrote no audit row anywhere — not on the success path, not on any
// failure path — while every neighbouring owner-only mutation on the same
// router (backup_create, backup_delete, backup_restore, config_write,
// api_token_create, plugin_install) wrote one. An owner-credential compromise
// could swap the binary and the operator's only tamper-evident record showed
// nothing: no actor, no version, no time.
//
// applyAndRestart's success branch cannot run in a test — it hands the process
// to the restart coordinator — so the outcome writer is exercised directly.
func TestApplyAndRestart_AuditsTheOutcome(t *testing.T) {
	for _, tc := range []struct {
		name   string
		action string
		detail string
	}{
		{"applied", "update_applied", "server binary replaced with v9.9.9, restarting"},
		{"failed", "update_failed", "staged server update v9.9.9 was not applied, the running binary is unchanged"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database, err := db.Open(":memory:")
			if err != nil {
				t.Fatalf("db.Open: %v", err)
			}
			t.Cleanup(func() { _ = database.Close() })
			if err := db.Migrate(database); err != nil {
				t.Fatalf("db.Migrate: %v", err)
			}

			const actor int64 = 42
			auditUpdateOutcome(context.Background(), database, actor, tc.action, tc.detail)

			var rows int
			var gotDetail string
			if err := database.QueryRowContext(context.Background(),
				`SELECT COUNT(*), COALESCE(MAX(detail), '') FROM audit_log
				  WHERE action = ? AND actor_id = ? AND target_type = 'server'`,
				tc.action, actor).Scan(&rows, &gotDetail); err != nil {
				t.Fatalf("reading the audit log: %v", err)
			}
			if rows != 1 {
				t.Fatalf("%q rows for actor %d = %d, want 1 — replacing the server binary must be audited",
					tc.action, actor, rows)
			}
			if gotDetail != tc.detail {
				t.Errorf("detail = %q, want %q", gotDetail, tc.detail)
			}
		})
	}
}

// TestAuditUpdateOutcome_NilDatabaseIsNotAPanic covers the seam the swap tests
// use: they drive applyAndRestart without a store, and an outcome row is never
// worth taking the process down for.
func TestAuditUpdateOutcome_NilDatabaseIsNotAPanic(t *testing.T) {
	auditUpdateOutcome(context.Background(), nil, 1, "update_applied", "no store configured")
}
