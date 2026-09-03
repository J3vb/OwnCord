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
//     Family names the service that takes them. B3-8 emptied this: no row
//     carries it any more, which is the phase's exit criterion. A new one is
//     a deliberate statement that something is on its way out, not a parking
//     space — the alternative to writing it is moving the code.
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
// deleted rows as families moved — the list only shrinks, and every row left
// is an adapter (db types, no persistence call) or a boundary that
// legitimately owns a handle.
var DBImportAllow = map[string]DBImportEntry{
	// ── admin ─────────────────────────────────────────────────────────────
	"admin/admin.go":                  {"boundary", "", "holds the handle for the admin mux; no calls"},
	"admin/api.go":                    {"boundary", "", "passes the handle to handlers; no calls"},
	"admin/backup_maintenance.go":     {"boundary", "", "scheduled backup mechanics on the maintenance tick; settings via the service"},
	"admin/handlers_backup.go":        {"boundary", "", "backup create/list/delete/restore owns the handle: VACUUM INTO, WAL checkpoint, close-and-swap"},
	"admin/handlers_channel_perms.go": {"adapter", "", "override response shapes; the service owns the policy and the calls"},
	"admin/handlers_channels.go":      {"adapter", "", "db.Channel in the resolver and response shapes; the service owns the calls"},
	"admin/handlers_users.go":         {"adapter", "", "UserWithRole/User/Role types in the panel response shapes; UserService owns the reads"},
	"admin/helpers.go":                {"adapter", "", "Role/User types in response helpers"},
	"admin/logstream.go":              {"boundary", "", "handle threaded to the SSE stream's auth check; no calls"},
	"admin/middleware.go":             {"adapter", "", "Role/User/Session types in the request context; SessionService resolves the bearer token"},
	"admin/types.go":                  {"adapter", "", "response DTOs only — its GetRoleByID went with the user family"},
	"admin/update_handlers.go":        {"boundary", "", "audits the binary swap (OC-0391) with WriteAudit/LogAudit; no other calls"},
	// ── api ───────────────────────────────────────────────────────────────
	"api/channel_handler.go": {"adapter", "", "response types only; service owns the calls"},
	"api/dm_handler.go":      {"adapter", "", "DM response types + pure status helpers"},
	"api/emoji_handler.go":   {"adapter", "", "Emoji/User types only"},
	"api/invite_handler.go":  {"adapter", "", "Invite/User types only"},
	"api/middleware.go":      {"adapter", "", "User/Session/Role types on the context keys; SessionService owns the resolution, the touches and the expired-session discard"},
	"api/plugins_handler.go": {"adapter", "", "db.Auditor is the seam; WriteAudit only"},
	"api/profile_handler.go": {"adapter", "", "User/Session types in the profile and session response shapes; the services own the calls"},
	"api/router.go":          {"boundary", "", "health probe (PingRead, SQLDb); hub construction left in B3-3"},
	"api/upload_handler.go":  {"adapter", "", "AttachmentAccess/User/Role types while serving the bytes; UploadService owns the access decisions"},
	// ── auth ──────────────────────────────────────────────────────────────
	"auth/helpers.go": {"adapter", "", "db.User type in a helper signature"},
	"auth/resolve.go": {"adapter", "", "Session/APIToken/Role/User types; resolution is injected"},
	// ── composition roots and tools ───────────────────────────────────────
	// B3-3 moved the process composition root out of main.go: internal/app
	// owns the handle from open to close, and main.go no longer imports db.
	"internal/app/app.go":         {"boundary", "", "the App holds the handle for its lifetime; no calls"},
	"internal/app/database.go":    {"boundary", "", "opens the handle, migrates, clears stale state at boot"},
	"internal/app/erasure.go":     {"boundary", "", "opens the deletion-marker file and replays it against the handle before anything serves (B4-10)"},
	"internal/app/hub.go":         {"boundary", "", "hands the handle to the hub and the service layer it builds"},
	"internal/app/maintenance.go": {"boundary", "", "periodic worker: expired sessions, backups, orphan attachments"},
	"internal/app/persistence.go": {"boundary", "", "event persister, audit writer and the boot seq seed own the handle"},
	"internal/app/plugins.go":     {"boundary", "", "passes the handle to the plugin registry as its store; no calls"},
	"token_cli.go":                {"boundary", "", "the token CLI opens, migrates and closes its own handle for the bootstrap path; TokenService owns every query"},
	"cmd/seed/main.go":            {"boundary", "", "developer seeding tool owns its handle"},
	"cmd/seed/profile_alpha.go":   {"boundary", "", "the alpha profile writes through the handle main.go owns"},
	"cmd/gendocs/main.go":         {"boundary", "", "docs generator migrates its own in-memory catalog"},
	"plugin/pluginstore.go":       {"adapter", "", "PluginRow type only; the store is injected"},
	// ── ws ────────────────────────────────────────────────────────────────
	"ws/client.go":           {"adapter", "", "db.User type on the connection"},
	"ws/deps.go":             {"adapter", "", "dispatch helpers read through the DispatchReader seam (readers.go); db types in signatures"},
	"ws/event.go":            {"adapter", "", "pure BroadcastStatus helper"},
	"ws/event_persister.go":  {"adapter", "", "PersistedEvent type; store is an interface"},
	"ws/eventstore.go":       {"adapter", "", "PersistedEvent type; store is an interface"},
	"ws/handlers.go":         {"adapter", "", "command handlers read through the DispatchReader seam; db types in payload shapes"},
	"ws/handlers_chat.go":    {"adapter", "", "pure NewDMChannelInfo helper"},
	"ws/hub.go":              {"boundary", "", "Hub state holds the handle the families read through; no calls"},
	"ws/hub_options.go":      {"boundary", "", "construction validates and stores the handle; no calls"},
	"ws/hub_broadcast.go":    {"adapter", "", "member payloads read through the MemberPayloadReader seam; db types + pure BroadcastStatus"},
	"ws/hub_presence.go":     {"adapter", "", "presence coalescer; pure BroadcastStatus helper and the MemberSummary shape"},
	"ws/hub_visibility.go":   {"adapter", "", "visibility and audience resolve through the VisibilityReader seam; db types in signatures"},
	"ws/messages.go":         {"adapter", "", "wire types + pure status helpers"},
	"ws/readers.go":          {"adapter", "", "the hub's read seams plus the service-backed VoiceStore, PresenceStamper and SocketAuthenticator: db types in the interface signatures, and DBReaders wiring the handle behind the read seams"},
	"ws/replay.go":           {"adapter", "", "PersistedEvent type in the cold-tier filter; the resume path's reads bind the VisibilityReader seam and its status stamp goes through PresenceStamper"},
	"ws/serve_auth.go":       {"adapter", "", "db.User on the handshake result and the pure StatusOffline const; SessionService resolves the token and writes the connect audit"},
	"ws/serve_pumps.go":      {"adapter", "", "pure StatusOffline const; the disconnect write goes through the PresenceStamper seam (readers.go)"},
	"ws/serve_ready.go":      {"adapter", "", "ready snapshot reads through ReadySnapshotReader; fresh-connect stale-voice cleanup through VoiceService"},
	"ws/voice_join.go":       {"adapter", "", "Channel/VoiceState/ChannelOverride types in the join sequence; VoiceService owns the voice_states reads and writes"},
	"ws/voice_moderation.go": {"adapter", "", "Role/VoiceState types in the moderation gate; VoiceService owns the writes, the rollback and the audit row"},
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
