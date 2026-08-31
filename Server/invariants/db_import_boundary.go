package invariants

import (
	"go/ast"
	"go/token"
	"strings"
)

// dbImportBoundaryID is the rule's stable id (a const for the same
// initialization-cycle reason as syncutilLocksID).
const dbImportBoundaryID = "db-import-boundary"

// dbImportPath is the persistence package every rule here is about.
const dbImportPath = "github.com/J3vb/OwnCord/Server/db"

// DBImportEntry is one row of the B3-0 boundary inventory: why a production
// file above the domain layer is allowed to import db, and where B3-8 sends
// it. Dispositions are the layout-refactor supplement's four:
//
//   - move:     persistence or domain decisions that belong behind a service;
//     Family names the service that takes them.
//   - adapter:  a transport adapter that uses db types or pure helpers only
//     (response shapes, status helpers) — no persistence calls.
//   - boundary: an explicit composition or transaction boundary (the process
//     entry, a CLI, health probing) that legitimately owns a handle.
//   - remove:   the import is unnecessary and goes.
//
// docs/architecture/server-boundaries.md is generated from this map by
// `go run ./cmd/dbinventory`; edit here, then regenerate.
type DBImportEntry struct {
	Disposition string
	Family      string
	Note        string
}

// DBImportAllow is the inventory. A production file outside db/ and service/
// that imports db and is not listed here fails db-import-boundary; a listed
// file that stops importing db fails TestDBImportAllowIsLive. B3-2 and B3-8
// delete rows as families move — the list only shrinks.
var DBImportAllow = map[string]DBImportEntry{
	// ── admin ─────────────────────────────────────────────────────────────
	"admin/admin.go":                  {"boundary", "", "holds the handle for the admin mux; no calls"},
	"admin/api.go":                    {"boundary", "", "passes the handle to handlers; no calls"},
	"admin/backup_maintenance.go":     {"move", "settings-ops", "BackupToSafe, integrity check, settings reads"},
	"admin/handlers_backup.go":        {"move", "settings-ops", "backup trigger and download; raw SQLDb for VACUUM INTO"},
	"admin/handlers_channel_perms.go": {"move", "channel", "override CRUD decides permission policy in the handler"},
	"admin/handlers_channels.go":      {"move", "channel", "channel CRUD + audit"},
	"admin/handlers_roles.go":         {"move", "role", "two reads; service/role.go already owns the writes"},
	"admin/handlers_settings.go":      {"move", "settings-ops", "BeginTx in a handler; TOTP census"},
	"admin/handlers_tokens.go":        {"move", "auth", "API-token CRUD duplicated in token_cli.go"},
	"admin/handlers_users.go":         {"move", "user", "user list, stats, lookups"},
	"admin/helpers.go":                {"adapter", "", "Role/User types in response helpers"},
	"admin/logstream.go":              {"boundary", "", "handle threaded to the SSE stream's auth check; no calls"},
	"admin/middleware.go":             {"move", "auth", "owner gate re-reads the role — OC-0345"},
	"admin/setup_handler.go":          {"move", "auth", "first-run owner creation (setup sub-family)"},
	"admin/setup_wizard.go":           {"move", "auth", "BeginTx for the wizard; setup sub-family"},
	"admin/types.go":                  {"adapter", "", "response DTOs; the one GetRoleByID moves with handlers_users"},
	// ── api ───────────────────────────────────────────────────────────────
	"api/channel_handler.go": {"adapter", "", "response types only; service owns the calls"},
	"api/dm_handler.go":      {"adapter", "", "DM response types + pure status helpers"},
	"api/emoji_handler.go":   {"adapter", "", "Emoji/User types only"},
	"api/gif_handler.go":     {"adapter", "", "handle in the signature, unused for calls"},
	"api/invite_handler.go":  {"adapter", "", "Invite/User types only"},
	"api/middleware.go":      {"move", "auth", "session/API-token touch and revoke"},
	"api/plugins_handler.go": {"adapter", "", "db.Auditor is the seam; WriteAudit only"},
	"api/profile_handler.go": {"move", "upload", "avatar upload creates the attachment row"},
	"api/router.go":          {"boundary", "", "health probe (PingRead, SQLDb); hub construction left in B3-3"},
	"api/upload_handler.go":  {"move", "upload", "attachment access + a raw QueryRowContext"},
	// ── auth ──────────────────────────────────────────────────────────────
	"auth/helpers.go": {"adapter", "", "db.User type in a helper signature"},
	"auth/resolve.go": {"adapter", "", "Session/APIToken/Role/User types; resolution is injected"},
	// ── composition roots and tools ───────────────────────────────────────
	// B3-3 moved the process composition root out of main.go: internal/app
	// owns the handle from open to close, and main.go no longer imports db.
	"internal/app/app.go":         {"boundary", "", "the App holds the handle for its lifetime; no calls"},
	"internal/app/database.go":    {"boundary", "", "opens the handle, migrates, clears stale state at boot"},
	"internal/app/hub.go":         {"boundary", "", "hands the handle to the hub and the service layer it builds"},
	"internal/app/maintenance.go": {"boundary", "", "periodic worker: expired sessions, backups, orphan attachments"},
	"internal/app/persistence.go": {"boundary", "", "event persister, audit writer and the boot seq seed own the handle"},
	"internal/app/plugins.go":     {"boundary", "", "passes the handle to the plugin registry as its store; no calls"},
	"token_cli.go":                {"move", "auth", "API-token CLI duplicates admin/handlers_tokens.go"},
	"cmd/seed/main.go":            {"boundary", "", "developer seeding tool owns its handle"},
	"cmd/seed/profile_alpha.go":   {"boundary", "", "the alpha profile writes through the handle main.go owns"},
	"cmd/gendocs/main.go":         {"boundary", "", "docs generator migrates its own in-memory catalog"},
	"plugin/pluginstore.go":       {"adapter", "", "PluginRow type only; the store is injected"},
	// ── ws ────────────────────────────────────────────────────────────────
	"ws/client.go":           {"adapter", "", "db.User type on the connection"},
	"ws/deps.go":             {"move", "channel", "role and DM-membership reads behind the hub's deps"},
	"ws/event.go":            {"adapter", "", "pure BroadcastStatus helper"},
	"ws/event_persister.go":  {"adapter", "", "PersistedEvent type; store is an interface"},
	"ws/eventstore.go":       {"adapter", "", "PersistedEvent type; store is an interface"},
	"ws/handlers.go":         {"move", "channel", "channel, role, session-ban and DM reads in command handlers"},
	"ws/handlers_chat.go":    {"adapter", "", "pure NewDMChannelInfo helper"},
	"ws/hub.go":              {"move", "settings-ops", "GetSetting at construction"},
	"ws/hub_broadcast.go":    {"move", "channel", "member and presence broadcast payloads read the user and role they announce"},
	"ws/hub_visibility.go":   {"move", "channel", "visibility and audience resolution reads channels, overrides, participants, users"},
	"ws/hub_sweep.go":        {"move", "voice", "stale-voice sweep reads and leaves"},
	"ws/messages.go":         {"adapter", "", "wire types + pure status helpers"},
	"ws/replay.go":           {"move", "connection", "reconnect replay selection and delivery; serve.go's row split with its code in B3-5"},
	"ws/serve.go":            {"move", "connection", "connect/disconnect lifecycle; B3-5 splits it by family first"},
	"ws/serve_auth.go":       {"move", "auth", "handshake auth: session, user and role lookups, connect audit, failed-handshake teardown"},
	"ws/serve_pumps.go":      {"move", "user", "MarkUserDisconnected on pump exit"},
	"ws/serve_ready.go":      {"move", "channel", "ready snapshot and fresh-connect: channels, overrides, unreads, DMs, members, stale-voice cleanup"},
	"ws/voice_join.go":       {"move", "voice", "voice state reads and writes"},
	"ws/voice_moderation.go": {"move", "voice", "mute/deafen/move persist voice state"},
}

// dbImportBoundary fails on any production file above the domain layer that
// imports db without an inventory row. db/ and service/ are the layers that
// may import it; everything else must be in DBImportAllow, which is the B3-0
// inventory (docs/architecture/server-boundaries.md is generated from it).
var dbImportBoundary = Rule{
	ID:    dbImportBoundaryID,
	Scope: nil, // every directory; the layers that may import are excluded in Check
	Check: checkDBImportBoundary,
}

func checkDBImportBoundary(f *ast.File, fset *token.FileSet, rel string) []Violation {
	if strings.HasPrefix(rel, "db/") || strings.HasPrefix(rel, "service/") {
		return nil
	}
	if _, listed := DBImportAllow[rel]; listed {
		return nil
	}
	for _, imp := range f.Imports {
		if strings.Trim(imp.Path.Value, `"`) != dbImportPath {
			continue
		}
		return []Violation{{
			Rule: dbImportBoundaryID,
			File: rel,
			Line: fset.Position(imp.Pos()).Line,
			Msg: "imports Server/db above the domain layer without an inventory row; " +
				"route the call through a service (see docs/architecture/server-boundaries.md), " +
				"or add a DBImportAllow entry with a disposition and reason",
		}}
	}
	return nil
}
