// Package rollback holds the hand-run reversal of every migration in
// Server/migrations from the data-contract migrations onward, and the order to
// run them in.
//
// Migrations here are forward-only: the server applies them and never
// un-applies them, so a rollback is an operator action. These files are what
// that operator runs, against a database no server is holding open, after
// taking a backup. They were written with the migrations rather than
// improvised during an incident.
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
	"087_discord_import.down.sql",
	"086_channel_password.down.sql",
	"085_session_identity_key.down.sql",
	"084_attachment_voice.down.sql",
	"083_stickers.down.sql",
	"082_owner_type_permissions.down.sql",
	"081_manage_backups.down.sql",
	"080_move_members.down.sql",
	"079_thread_members.down.sql",
	"078_manage_nicknames.down.sql",
	"077_user_roles_reconcile.down.sql",
	"075_forums.down.sql",
	"076_category_permissions.down.sql",
	"074_threads.down.sql",
	"073_polls.down.sql",
	"072_channel_categories.down.sql",
	"071_message_forwards.down.sql",
	"070_user_privacy.down.sql",
	"069_profile_notes_banners.down.sql",
	"068_channel_afk.down.sql",
	"067_user_roles.down.sql",
	"066_group_dm_icon.down.sql",
	"065_group_dm_owner.down.sql",
	"064_call_log.down.sql",
	"063_mention_receipts.down.sql",
	"062_custom_status_expiry.down.sql",
	"061_member_generation_about.down.sql",
	"060_message_mentions_reply_ping.down.sql",
	"059_gif_favorites.down.sql",
	"058_revoke_trust_for_blocked_pairs.down.sql",
	"057_member_generation.down.sql",
	"056_message_pinned_at.down.sql",
	"055_invite_redemptions.down.sql",
	"054_audit_action_index.down.sql",
	"053_retention_revision.down.sql",
	"052_report_source_nsfw.down.sql",
	"051_message_delivery_receipts.down.sql",
	"050_appeals.down.sql",
	"049_moderation_actions.down.sql",
	"048_reports.down.sql",
	"047_nsfw_acknowledgements.down.sql",
	"046_message_requests.down.sql",
	"045_push_subscriptions.down.sql",
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
