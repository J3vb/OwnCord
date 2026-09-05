// Package rollback holds the hand-run reversal of every migration in
// Server/migrations that the B4 phase added and every one since, and the order to run them in.
//
// Migrations here are forward-only: the server applies them and never
// un-applies them, so a rollback is an operator action rather than a server
// one. These files are what that operator runs, against a database no server
// is holding open, after taking a backup. The reversals were written with the
// migrations (the B4 data contracts drafted theirs in
// docs/plans/hp-4-drafts/) rather than improvised during an incident.
//
// Each file reverses exactly one migration and ends by deleting that
// migration's row from schema_versions, so the next server start applies the
// migration again instead of believing it is still in place. A reversal run
// without that delete leaves the database claiming a schema it does not have.
//
// Order lists them newest first, which is the order to run them in: a
// reversal that drops a column has to run before the one that drops the table
// holding it, and the two audit-token reversals have to run in this order so
// that 042 moves its tokens back into subject_token before 041 drops the
// column they are sitting in.
//
// MarkerFile is not in Order. The deletion-marker file carries its own schema
// applied on every open (Server/db/markers.go, OpenMarkerStore) rather than
// through this directory's migrations, so its reversal runs against that file
// and has no schema_versions row to clear.
//
// README.md in this directory is the operator's copy of all of the above.
package rollback

import (
	"embed"
	"strings"
)

// FS holds the reversal scripts, embedded at compile time so the rehearsal
// runs the same bytes an operator would.
//
//go:embed *.sql
var FS embed.FS

// Order is every migration reversal, newest first — the order to run them in.
var Order = []string{
	"044_user_storage.down.sql",
	"043_setup_completed.down.sql",
	"042_audit_actor_token_backfill.down.sql",
	"041_audit_actor_token.down.sql",
	"040_erasure_replay_purge.down.sql",
	"039_retention.down.sql",
	"038_audit_unlinking.down.sql",
	"037_erasure_jobs.down.sql",
	"036_recovery_assists.down.sql",
	"035_recovery_kits.down.sql",
	"034_registration_modes.down.sql",
	"033_sessions_unseen.down.sql",
	"032_second_factor_state.down.sql",
}

// MarkerFile reverses the deletion-marker file's schema, not a migration.
const MarkerFile = "markers.down.sql"

// Migration returns the migration filename that the named reversal reverses.
// The naming contract is the whole mapping: 039_retention.down.sql reverses
// 039_retention.sql, and the reversal's own schema_versions delete names that
// same file.
func Migration(reversal string) string {
	return strings.TrimSuffix(reversal, ".down.sql") + ".sql"
}
