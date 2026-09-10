package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"slices"

	"github.com/J3vb/OwnCord/Server/migrations"
)

// DiagnosticTable is a count, never a row or a schema definition. Names come
// from this binary's allowlist, so custom schema names cannot leak data.
type DiagnosticTable struct {
	Name string `json:"name"`
	Rows int64  `json:"rows"`
}

// DiagnosticSnapshot excludes SQL definitions, settings, identities and rows.
type DiagnosticSnapshot struct {
	Migrations        []string          `json:"migrations"`
	Tables            []DiagnosticTable `json:"tables"`
	WriterWaitCount   int64             `json:"writer_wait_count"`
	WriterWaitSeconds float64           `json:"writer_wait_seconds"`
}

var diagnosticTables = []string{
	"api_tokens", "appeals", "attachments", "audit_log", "channel_overrides",
	"channel_retention", "channel_user_overrides", "channels", "dm_open_state",
	"dm_participants", "emoji", "erasure_jobs", "events", "invites",
	"login_attempts", "message_delivery_receipts", "message_mentions", "message_requests",
	"messages", "moderation_actions", "nsfw_acknowledgements", "partial_auth_challenges",
	"pending_totp_enrollments", "push_subscriptions",
	"rate_lockouts", "reactions", "read_states", "recovery_assists", "recovery_kits",
	"report_events", "report_evidence", "report_notes", "reports", "retention_runs",
	"roles", "schema_versions", "sessions", "settings", "sounds", "totp_recovery_codes",
	"totp_used_codes", "trusted_senders", "user_blocks", "user_storage", "users", "voice_states",
}

// Diagnostics reads all counts from one short-lived read transaction. Query
// text is dynamic only for identifiers from the binary-owned list above;
// sqlc cannot express dynamic identifiers. Callers impose a total deadline.
func (d *DB) Diagnostics(ctx context.Context) (*DiagnosticSnapshot, error) {
	tx, err := d.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("diagnostics begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	out := &DiagnosticSnapshot{Tables: []DiagnosticTable{}, Migrations: []string{}}
	for _, table := range diagnosticTables {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)", table).Scan(&exists); err != nil {
			return nil, fmt.Errorf("diagnostics table presence: %w", err)
		}
		if !exists {
			continue
		}
		var count int64
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM \""+table+"\"").Scan(&count); err != nil { //nolint:gosec // identifiers exclusively from diagnosticTables, never input or schema rows
			return nil, fmt.Errorf("diagnostics count: %w", err)
		}
		out.Tables = append(out.Tables, DiagnosticTable{Name: table, Rows: count})
	}
	known, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return nil, fmt.Errorf("diagnostics migration catalog: %w", err)
	}
	for _, name := range known {
		var applied bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM schema_versions WHERE version = ?)", name).Scan(&applied); err != nil {
			return nil, fmt.Errorf("diagnostics migration presence: %w", err)
		}
		if applied {
			out.Migrations = append(out.Migrations, name)
		}
	}
	slices.Sort(out.Migrations)
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("diagnostics commit: %w", err)
	}
	stats := d.writer.Stats()
	out.WriterWaitCount, out.WriterWaitSeconds = stats.WaitCount, stats.WaitDuration.Seconds()
	return out, nil
}
