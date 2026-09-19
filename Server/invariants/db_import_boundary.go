package invariants

import (
	"go/ast"
	"go/token"
	"strings"
)

// dbImportBoundaryID is the rule's stable id (a const for the same
// initialization-cycle reason as syncutilLocksID).
const dbImportBoundaryID = "db-import-boundary"

// dbHandleOwnerID is the sub-id checkDBImportBoundary reports for raw-handle
// use, as opposed to a bare import. A sub-id rather than a second rule: the
// registry keys allow comments on what a rule emits (see checkSourceWith), so
// one entry, one document and one allowlist cover both halves — and
// //invariant:allow must name db-handle-owner to suppress this half.
const dbHandleOwnerID = "db-handle-owner"

// dbImportPath is the persistence package every rule here is about.
const dbImportPath = "github.com/J3vb/OwnCord/Server/db"

// DispositionBoundary is the one disposition that owns a handle outright.
const DispositionBoundary = "boundary"

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
// B6-14 added Calls and Hands, because an import is not the access: the handle
// is stored on Hub.db and on App.database, so a file in either package can use
// it without importing db at all. Both are exact multisets in the
// AuthzResidueEntry.Calls sense — measured by cmd/dbinventory against the tree,
// compared here, and only ever edited deliberately.
type DBImportEntry struct {
	Disposition string
	Family      string
	Note        string
	// Calls is the exact multiset of *db.DB method calls the file may make
	// (method name → count), including the raw accessors SQLDb, SQLReaderDB
	// and BeginTx and the ExecContext/QueryContext/QueryRowContext wrappers.
	// A boundary row that measures anything else — one more call, one fewer,
	// a different method — fails the document gate with the two multisets
	// printed side by side. adapter, move and remove rows pin nothing and must
	// measure nothing: that is what their disposition claims.
	Calls calls
	// Hands is the exact multiset of the places the file passes the bare
	// handle to (callee or assignment target → count): the composition root's
	// wiring, and anywhere else the handle is read out of its carrier and
	// given away. A hand-off is a handle use — the callee's parameter type, or
	// the field the assignment stores it into, is the owner it names — so a
	// new one is a reviewable edit here rather than a side effect. A hand-off
	// into a field renders as that field's path (`c.Store`), which is as much
	// of the owner as a call's callee name is.
	Hands calls
}

// DBImportAllow is the inventory. A production file outside db/ and service/
// that imports db and is not listed here fails db-import-boundary; a listed
// file that stops importing db fails TestDBImportAllowIsLive. B3-2 and B3-8
// deleted rows as families moved — the list only shrinks, and every row left
// is an adapter (db types, no persistence call) or a boundary that
// legitimately owns a handle.
var DBImportAllow = map[string]DBImportEntry{
	// ── admin ─────────────────────────────────────────────────────────────
	"admin/admin.go":                  {Disposition: "boundary", Note: "holds the handle for the admin mux; no calls"},
	"admin/api.go":                    {Disposition: "boundary", Note: "passes the handle to the handlers and services it builds; no calls of its own", Hands: calls{"service.NewDiagnosticsService": 1, "service.NewSessionService": 1, "service.NewSetupService": 1, "service.NewTokenService": 1, "service.NewUserService": 1}},
	"admin/backup_maintenance.go":     {Disposition: "boundary", Note: "scheduled backup mechanics on the maintenance tick; settings via the service", Calls: calls{"BackupToSafe": 1}},
	"admin/handlers_backup.go":        {Disposition: "boundary", Note: "backup create/list/delete/restore owns the handle: VACUUM INTO, WAL checkpoint, close-and-swap", Calls: calls{"BackupToSafe": 2, "Close": 1, "LogAudit": 1, "SQLDb": 1}},
	"admin/handlers_channel_perms.go": {Disposition: "adapter", Note: "override response shapes; the service owns the policy and the calls"},
	"admin/handlers_channels.go":      {Disposition: "adapter", Note: "db.Channel in the resolver and response shapes; the service owns the calls"},
	"admin/handlers_users.go":         {Disposition: "adapter", Note: "UserWithRole/User/Role types in the panel response shapes; UserService owns the reads"},
	"admin/helpers.go":                {Disposition: "adapter", Note: "Role/User types in response helpers"},
	"admin/logstream.go":              {Disposition: "boundary", Note: "handle threaded to the SSE stream's auth check; no calls of its own", Hands: calls{"auth.ResolveTokenHash": 2}},
	"admin/middleware.go":             {Disposition: "adapter", Note: "Role/User/Session types in the request context; SessionService resolves the bearer token"},
	"admin/types.go":                  {Disposition: "adapter", Note: "response DTOs only — its GetRoleByID went with the user family"},
	"admin/update_handlers.go":        {Disposition: "boundary", Note: "audits the binary swap (OC-0391) with WriteAudit/LogAudit; no other calls", Calls: calls{"LogAudit": 1}},
	// ── api ───────────────────────────────────────────────────────────────
	"api/appeal_handler.go":           {Disposition: "adapter", Note: "db.User from the auth context and db.ModerationAction response type only; AppealService owns every call"},
	"api/channel_handler.go":          {Disposition: "adapter", Note: "response types only; service owns the calls"},
	"api/dm_handler.go":               {Disposition: "adapter", Note: "DM response types + pure status helpers"},
	"api/dm_request_handler.go":       {Disposition: "adapter", Note: "message-request response types; the service owns the calls"},
	"api/emoji_handler.go":            {Disposition: "adapter", Note: "Emoji/User types only"},
	"api/invite_handler.go":           {Disposition: "adapter", Note: "Invite/User types only"},
	"api/middleware.go":               {Disposition: "adapter", Note: "User/Session/Role types on the context keys; SessionService owns the resolution, the touches and the expired-session discard"},
	"api/moderation_handler.go":       {Disposition: "adapter", Note: "db.ModerationAction response type only; ModerationService owns every call"},
	"api/moderation_queue_handler.go": {Disposition: "adapter", Note: "db.User from the auth context only; ReportService owns every call"},
	"api/nsfw_handler.go":             {Disposition: "adapter", Note: "db.User type on the context key only; NSFWService owns every call"},
	"api/plugins_handler.go":          {Disposition: "adapter", Note: "db.Auditor is the seam; WriteAudit only"},
	"api/profile_handler.go":          {Disposition: "adapter", Note: "User/Session types in the profile and session response shapes; the services own the calls"},
	"api/push_handler.go":             {Disposition: "adapter", Note: "db.User type on the context key only; PushService owns every call"},
	"api/report_handler.go":           {Disposition: "adapter", Note: "db.User from the auth context only; ReportService owns every call"},
	"api/router.go":                   {Disposition: "boundary", Note: "health probe (PingRead, SQLDb, SQLReaderDB); hub construction left in B3-3", Calls: calls{"PingRead": 1, "SQLDb": 1, "SQLReaderDB": 1}, Hands: calls{"admin.NewHandler": 1, "service.NewAuthService": 1}},
	"api/upload_handler.go":           {Disposition: "adapter", Note: "AttachmentAccess/User/Role types while serving the bytes; UploadService owns the access decisions"},
	// ── auth ──────────────────────────────────────────────────────────────
	"auth/helpers.go": {Disposition: "adapter", Note: "db.User type in a helper signature"},
	"auth/resolve.go": {Disposition: "adapter", Note: "Session/APIToken/Role/User types; resolution is injected"},
	// ── composition roots and tools ───────────────────────────────────────
	// B3-3 moved the process composition root out of main.go: internal/app
	// owns the handle from open to close, and main.go no longer imports db.
	"internal/app/app.go":      {Disposition: "boundary", Note: "the App holds the handle for its lifetime; no calls"},
	"internal/app/database.go": {Disposition: "boundary", Note: "opens the handle, migrates, clears stale state at boot", Calls: calls{"ClearAllVoiceStates": 1, "ResetAllUserStatuses": 1}},
	"internal/app/erasure.go":  {Disposition: "boundary", Note: "opens the deletion-marker file and replays it against the handle before anything serves (B4-10)", Calls: calls{"CheckpointErasureWAL": 1, "Close": 2}, Hands: calls{"service.NewErasureService": 1, "service.NewRetentionService": 1}},
	"internal/app/hub.go":      {Disposition: "boundary", Note: "hands the handle to the hub and the service layer it builds", Hands: calls{"auth.NewPersistentRateLimiter": 1, "service.New": 1, "ws.DBReaders": 1, "ws.HubOptions": 1}},
	// B6-14: no import of its own — the start/stop sequence opens the handle
	// through openDatabase (the package's own constructor, not db.Open*),
	// registers its Close and wires it into everything, all of which is handle
	// use the import-only gate could not see. The Hands multiset is that
	// wiring, one entry per step; the pinned Close is the close step.
	"internal/app/lifecycle.go":   {Disposition: "boundary", Note: "the start and stop sequence hands App.database to every step that needs it, and registers the close that releases it", Calls: calls{"Close": 1}, Hands: calls{"StartRuntime": 1, "api.NewRouter": 1, "initDatabase": 1, "initPlugins": 1, "newAuditWriter": 1, "openMarkers": 1, "service.NewPushDispatcher": 1, "startEventPersister": 1, "startMaintenanceLoop": 1}},
	"internal/app/maintenance.go": {Disposition: "boundary", Note: "periodic worker: expired sessions, backups, orphan attachments", Calls: calls{"CleanupExpiredSecondFactorState": 1, "DeleteExpiredMessageDeliveryReceipts": 1, "DeleteExpiredSessions": 1, "DeleteOrphanedAttachments": 1, "FindOrphanedVoiceMutes": 1, "RetireModerationActions": 1}, Hands: calls{"admin.MaintainBackups": 1}},
	"internal/app/persistence.go": {Disposition: "boundary", Note: "event persister, audit writer and the boot seq seed own the handle", Calls: calls{"GetMaxEventSeq": 1, "GetSetting": 1, "SetAuditWriter": 1, "SetSetting": 1}, Hands: calls{"ws.NewEventPersister": 1, "ws.StartEventPruner": 1}},
	"internal/app/plugins.go":     {Disposition: "boundary", Note: "passes the handle to the plugin registry as its store; no calls of its own", Hands: calls{"plugin.Config": 1}},
	"token_cli.go":                {Disposition: "boundary", Note: "the token CLI opens, migrates and closes its own handle for the bootstrap path; TokenService owns every query", Calls: calls{"Close": 1}, Hands: calls{"service.NewTokenService": 1}},
	"cmd/seed/main.go":            {Disposition: "boundary", Note: "developer seeding tool owns its handle", Calls: calls{"Close": 1, "CreateChannel": 1, "CreateMessage": 2, "CreateUser": 1, "GetOrCreateDMChannel": 1, "GetUserByUsername": 1, "ListChannels": 1, "QueryRowContext": 1}},
	"cmd/seed/profile_alpha.go":   {Disposition: "boundary", Note: "the alpha profile writes through the handle main.go owns", Calls: calls{"BeginTx": 1, "ExecContext": 2, "QueryRowContext": 1}},
	"cmd/gendocs/main.go":         {Disposition: "boundary", Note: "docs generator migrates its own in-memory catalog", Calls: calls{"Close": 2, "QueryContext": 2}, Hands: calls{"api.NewRouter": 1, "app.StartRuntime": 1}},
	"plugin/pluginstore.go":       {Disposition: "adapter", Note: "PluginRow type only; the store is injected"},
	// ── ws ────────────────────────────────────────────────────────────────
	"ws/client.go":          {Disposition: "adapter", Note: "db.User type on the connection"},
	"ws/deps.go":            {Disposition: "adapter", Note: "dispatch helpers read through the DispatchReader seam (readers.go); db types in signatures"},
	"ws/event.go":           {Disposition: "adapter", Note: "pure BroadcastStatus helper"},
	"ws/event_persister.go": {Disposition: "adapter", Note: "PersistedEvent type; store is an interface"},
	"ws/eventstore.go":      {Disposition: "adapter", Note: "PersistedEvent type; store is an interface"},
	"ws/handlers.go":        {Disposition: "adapter", Note: "command handlers read through the DispatchReader seam; db types in payload shapes"},
	"ws/handlers_chat.go":   {Disposition: "adapter", Note: "pure NewDMChannelInfo helper"},
	"ws/hub.go":             {Disposition: "boundary", Note: "Hub state holds the handle the families read through; no calls"},
	// B6-14: no import of its own — the replay purge reaches Hub.db directly,
	// and deliberately. PurgeUserFromReplay and PurgeMessagesFromReplay run
	// awaitDispatch, then persister.Flush, then take seqMu and do tombstone,
	// watermark, ring drop and the persisted-row delete as ONE critical
	// section, so no broadcast is sequenced in between (HP-4 decision 1).
	// Routing the delete through the EventStore seam would not be a pure
	// refactor: h.eventStore is set only when event persistence is enabled,
	// while h.db is set whenever a database exists, so a purge gated on the
	// seam would skip rows a previous enabled boot persisted — an erasure
	// regression. The two calls stay direct and are pinned here instead, so
	// moving one is a visible edit to this row rather than a side effect.
	"ws/hub_events.go":       {Disposition: "boundary", Note: "replay purge: ring drop and persisted-row delete are one seqMu critical section (HP-4 decision 1), so the delete is never gated on the persistence seam being wired", Calls: calls{"DeleteEventsForMessages": 1, "DeleteEventsForUser": 1}},
	"ws/hub_options.go":      {Disposition: "boundary", Note: "construction validates and stores the handle, and gives it to the permission checker; no calls of its own", Hands: calls{"permissions.NewChecker": 1}},
	"ws/hub_broadcast.go":    {Disposition: "adapter", Note: "member payloads read through the MemberPayloadReader seam; db types + pure BroadcastStatus"},
	"ws/hub_presence.go":     {Disposition: "adapter", Note: "presence coalescer; pure BroadcastStatus helper and the MemberSummary shape"},
	"ws/hub_visibility.go":   {Disposition: "adapter", Note: "visibility and audience resolve through the VisibilityReader seam; db types in signatures"},
	"ws/messages.go":         {Disposition: "adapter", Note: "wire types + pure status helpers"},
	"ws/readers.go":          {Disposition: "adapter", Note: "the hub's read seams plus the service-backed VoiceStore, PresenceStamper and SocketAuthenticator: db types in the interface signatures, and DBReaders wiring the handle behind the read seams"},
	"ws/replay.go":           {Disposition: "adapter", Note: "PersistedEvent type in the cold-tier filter; the resume path's reads bind the VisibilityReader seam and its status stamp goes through PresenceStamper"},
	"ws/serve_auth.go":       {Disposition: "adapter", Note: "db.User on the handshake result and the pure StatusOffline const; SessionService resolves the token and writes the connect audit"},
	"ws/serve_pumps.go":      {Disposition: "adapter", Note: "pure StatusOffline const; the disconnect write goes through the PresenceStamper seam (readers.go)"},
	"ws/serve_ready.go":      {Disposition: "adapter", Note: "ready snapshot reads through ReadySnapshotReader; fresh-connect stale-voice cleanup through VoiceService"},
	"ws/voice_join.go":       {Disposition: "adapter", Note: "Channel/VoiceState/ChannelOverride types in the join sequence; VoiceService owns the voice_states reads and writes"},
	"ws/voice_moderation.go": {Disposition: "adapter", Note: "Role/VoiceState types in the moderation gate; VoiceService owns the writes, the rollback and the audit row"},
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
	entry, listed := DBImportAllow[rel]
	var out []Violation
	if !listed {
		for _, imp := range f.Imports {
			if strings.Trim(imp.Path.Value, `"`) != dbImportPath {
				continue
			}
			out = append(out, Violation{
				Rule: dbImportBoundaryID,
				File: rel,
				Line: fset.Position(imp.Pos()).Line,
				Msg: "imports Server/db above the domain layer without an inventory row; " +
					"route the call through a service (see docs/architecture/server-boundaries.md), " +
					"or add a DBImportAllow entry with a disposition and reason",
			})
			break
		}
	}
	if entry.Disposition != DispositionBoundary {
		out = append(out, checkRawHandleOwner(f, fset, rel)...)
	}
	return out
}

// rawHandleTypes are the database/sql types a *db.DB hands out: the pools
// behind SQLDb/SQLReaderDB and the transaction BeginTx returns. Threading one
// of them through a file is owning a handle by another name.
var rawHandleTypes = map[string]bool{"DB": true, "Tx": true, "Conn": true}

// checkRawHandleOwner is the half of db-import-boundary that looks at use
// rather than imports, for a file that is not a boundary row. It takes only
// what a single file can prove without type information, which is deliberately
// narrow: the handle is usually reached through a package field (h.db) that no
// single file declares, and that shape is caught by cmd/dbinventory's
// package-wide walk instead, where it becomes a row rather than a violation.
//
// What one file does prove:
//
//   - SQLDb() and SQLReaderDB() name nothing else in this tree — they are
//     *db.DB's raw-pool accessors, whatever the receiver is spelled as;
//   - BeginTx() on a value this file declares *db.DB — by name or as the
//     struct field its own type declaration introduces — opens a transaction
//     the file then owns;
//   - a *sql.DB, *sql.Tx or *sql.Conn in a file that also imports db is that
//     handle escaping into database/sql. A file that opens its own sql.DB and
//     never touches Server/db is a different question, and not this one.
func checkRawHandleOwner(f *ast.File, fset *token.FileSet, rel string) []Violation {
	var out []Violation
	alias := DBHandleAlias(f)
	vars := DBHandleVars(f, alias, nil, DBHandleCtors(f, alias))
	sqlNames, _ := importNames(f, "database/sql")
	add := func(pos token.Pos, what string) {
		out = append(out, Violation{
			Rule: dbHandleOwnerID,
			File: rel,
			Line: fset.Position(pos).Line,
			Msg: what + " — only a boundary row owns a raw database handle " +
				"(docs/architecture/server-boundaries.md). Route it through a service, " +
				"or give the file a DBImportAllow boundary row saying which handle or " +
				"transaction it owns and pinning the calls it makes",
		})
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			sel, ok := x.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "SQLDb", "SQLReaderDB":
				add(sel.Sel.Pos(), "calls "+sel.Sel.Name+"(), the raw database/sql pool behind the db handle")
			case "BeginTx":
				// The receiver names the handle either directly
				// (database.BeginTx) or as a field this file declares
				// (a.database.BeginTx) — DBHandleVars carries both, because a
				// struct field typed *db.DB is a *db.DB declaration like any
				// other. A field declared in another file is not this rule's
				// shape: no single file declares it, and cmd/dbinventory's
				// package-wide walk is what catches that one.
				var recv string
				switch r := sel.X.(type) {
				case *ast.Ident:
					recv = r.Name
				case *ast.SelectorExpr:
					recv = r.Sel.Name
				}
				if vars[recv] {
					add(sel.Sel.Pos(), "calls BeginTx() on the db handle, opening a transaction boundary")
				}
			}
		case *ast.StarExpr:
			if alias == "" {
				return true
			}
			sel, ok := x.X.(*ast.SelectorExpr)
			if !ok || !rawHandleTypes[sel.Sel.Name] {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && sqlNames[id.Name] {
				add(x.Pos(), "holds a *"+id.Name+"."+sel.Sel.Name+" alongside its db import")
			}
		}
		return true
	})
	return out
}
