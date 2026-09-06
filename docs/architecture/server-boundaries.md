# Server boundaries — database-call and lifecycle inventory

**Written:** 2026-08-29 (B3-0), measured at `dev` `ad4defc2`.
**Re-measured:** 2026-08-30 (B3-2) — the first table and the auth slice's
after-state at `fe1d11b8` (pre-squash; the squash SHA is in the plan's B3-2
evidence block); 2026-08-30 (B3-3) — the first table again, and the hub
lifecycle section's after-state rows, on `feat/b3-3-lifecycle`; 2026-08-31
(B3-4) — the construction-and-setters after-state, on
`feat/b3-4-hub-options`; 2026-08-31 (B3-5, first split PR) — the first table,
on `feat/b3-5-ws-split` (handshake auth and fresh-connect rows moved with
their code); 2026-08-31 (B3-5, second split PR) — the first table, on
`feat/b3-5-ws-split-2` (the reconnect replay family split out of
`serve.go`'s row into a new `ws/replay.go` row; the registry move added no
row — that family makes no `db` use); 2026-08-31 (B3-5, third split PR) —
the first table, on `feat/b3-5-ws-split-3` (the visibility responsibility
gathered from `hub_broadcast.go`, `serve.go` and `hub.go` into a new
`ws/hub_visibility.go` row; `hub_broadcast.go`'s row now carries only the
member/presence payload reads); 2026-08-31 (B3-5, fourth split PR) — the
first table, on `feat/b3-5-ws-split-4` (voice broadcast leftovers joined
`voice_broadcast.go`'s code with no row change — that file makes no `db`
use — and the presence coalescer split into a new `ws/hub_presence.go`
adapter row, its only `db` use the pure `BroadcastStatus` helper;
`hub_broadcast.go`'s row is down to the member payload reads); 2026-08-31
(B3-5, finisher PR) — the first table, on `feat/b3-5-ws-split-5`
(`hub.go`'s `GetSetting` calls left with the settings cache for
`hub_settings.go`; that file's persistence runs through the `h.db` field,
which needs no import, so it **pins** the `db` import — a documented
`var _ *db.DB` — to stay on the rule's and this table's books: the rule
and rows track importers, and a field-calling file without the pin would
be invisible to both, which a review flagged on the finisher PR. `hub.go`
and the new `hub_options.go` are type-only `boundary` rows
holding/validating the handle. The disposition counts were also
re-derived from the tool's summary: `boundary` had been stale at 12
since the seed-profile row landed); 2026-08-31 (B3-8, settings/audit
family) — the first table, on `feat/b3-8-settings-family`: the family's
persistence now lives only in `db/` and `service/`. The thinned
`admin/handlers_settings.go` and the reader-backed `ws/hub_settings.go`
(pin removed — the file no longer touches `db` at all) stop importing
`db`, so both rows are deleted; the backup pair takes the disposition
this table forecast — `boundary` — now that settings-ops owns the
settings (`backup_maintenance.go` reads schedule/retention through the
service and keeps only backup mechanics; `handlers_backup.go` owns the
handle for VACUUM INTO, the WAL checkpoint and close-and-swap restore).
`settings-ops` disappears from the move targets: 28 → 24 `move`,
15 → 17 `boundary`; 2026-08-31 (B3-8, channel family part 1) — the first
table, on `feat/b3-8-channel-family`: the admin channel CRUD moves behind
`service.ChannelService` with the S-03 contract, and both sibling
resolvers go through the one S-04 policy. `admin/handlers_channels.go`
turns type-only `adapter` (the audit-log read joined the settings/audit
service); `admin/handlers_channel_perms.go` keeps its `move` row for the
override CRUD, resolution now via the service (24 → 23 `move`,
18 → 19 `adapter`). The family's remaining rows — the override CRUD and
the five `ws` channel read rows — land in parts 2 and 3; 2026-08-31
(B3-8, channel family part 2) — the first table, on
`feat/b3-8-channel-family-2`: the override CRUD's policy (the
union escalation guard — clearing a deny is a grant — both hierarchy
rules, mask clamping, audits, and who to invalidate) moves into
`service.ChannelService`; `admin/handlers_channel_perms.go` turns
type-only `adapter` (23 → 22 `move`, 19 → 20 `adapter`). The two
`HasAdmin` residue rows in `authz_chokepoint.go` moved to their new
service symbols with the code. Only the five `ws` channel read rows
(part 3) remain of the family; 2026-08-31 (B3-8, channel family part 3) —
the first table, on `feat/b3-8-channel-family-3`: the hub's snapshot,
visibility, member-payload and dispatch reads go through consumer-side
seams (`ws/readers.go` — the SettingsReader pattern, per owner decision),
`DBReaders` wiring the handle behind them at the composition root. The
five rows turn seam-named `adapter`; `readers.go` itself is a type-only
`adapter` row; `service.RequireDMNotBlocked` narrows to its own
three-read `DMBlockReader`. **The channel family is complete**: `channel`
disappears from the move targets (22 → 17 `move`, 20 → 26 `adapter`).
**Owner:** the B3 plan,
[plans/b3-server-architecture-guardrails-2026-08-29.md](../plans/b3-server-architecture-guardrails-2026-08-29.md).
**Regenerate the first table:** `cd Server && go run ./cmd/dbinventory` and
paste its output between the markers below. The tool exits non-zero when a
file imports `db` without a row, or a row names a file that no longer imports
it — the same two failures `go test ./invariants/` reports.

This is the inventory the roadmap's B3 entry gate asks for ("hotspots and
direct database call sites have an owned inventory") and the evidence its exit
gate consumes ("every direct database use above the domain layer is justified
or removed"). It answers three questions for every production Go file above
the domain layer: does it import `db`; what does it use `db` for; and what
happens to that use — one of four dispositions from the
[layout-refactor supplement](../plans/developer-experience-layout-refactor-2026-08-29.md):

| Disposition | Meaning                                                                                                               | Rows |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---: |
| `move`      | persistence or a domain decision that belongs behind a service; **Family** names the service B3-8 (or B3-2) builds    |    0 |
| `adapter`   | a transport adapter that uses `db` types or pure helpers only — response shapes, status helpers — no persistence call |   42 |
| `boundary`  | an explicit composition or transaction boundary that legitimately owns a handle (process entry, CLIs, health probe)   |   20 |
| `remove`    | the import is unnecessary and goes                                                                                    |    0 |

The rows live in code, not only here: `Server/invariants/db_import_boundary.go`
holds them as `DBImportAllow`, the `db-import-boundary` rule fails any new
importer that has no row, and `TestDBImportAllowIsLive` fails any row whose
file stopped importing `db`. The `db` surface only shrinks — B3-2 deleted the
two auth handler rows (28 → 26 `move`), B3-8 deletes a family's rows as it
moves. A B3-5 file split can spread one row's code across two rows without
adding any new `db` use (`serve.go` → `replay.go`, then the visibility
gather into `hub_visibility.go`; the finisher turned `hub.go` type-only
while `hub_settings.go` took its `move` row — 26 → 28 `move` across the
series with the calls behind them only moved), so it is the surface, not
the row count, that ratchets. B3-8 then took it down: settings/audit
(28 → 24), the channel family's three parts (24 → 17), the upload family
(17 → 15), and the role family, whose single row is **deleted** rather
than downgraded because `admin/handlers_roles.go` stopped importing `db`
entirely (15 → 14) — the first file to leave the table since B3-2 — the
user family (14 → 12), which took the admin panel's user reads behind
`UserService` and the connection teardown's one write behind a seam, and
the voice family (12 → 10), which took `voice_states` behind `VoiceService`
and left `ws/hub_sweep.go` holding only its session-sweep read, so that row
changes family rather than disposition, the connection family (10 → 9),
after which every remaining `move` row belonged to one family, `auth`, and
then the auth family itself, in three sub-families: tokens (9 → 7), sessions
(7 → 2) and setup (2 → **0**).

**`move` is now empty, and that is B3-8's exit criterion.** Six of the auth
family's nine rows were **deleted** rather than downgraded — the files stopped
importing `db` at all — and `token_cli.go` became `boundary`, because a
bootstrap CLI legitimately opens and migrates its own handle even once it makes
no query of its own. That put the table at its low-water mark, 57 rows;
B5-7 added one row back — `api/nsfw_handler.go`, type-only `adapter`
(`db.User` on the context key; `NSFWService` owns every call) — and B5-8
added two more — `api/moderation_queue_handler.go` and
`api/report_handler.go`, both type-only `adapter` (`db.User` from the auth
context only; ReportService owns every call) — and B5-9 added one more —
`api/moderation_handler.go`, type-only `adapter` (`db.ModerationAction`
response type only; `ModerationService` owns every call) — and B5-10 added
one more still — `api/appeal_handler.go`, type-only `adapter` (`db.User`
from the auth context and `db.ModerationAction` response type only;
`AppealService` owns every call) — so the table is up from 57 rows to 62,
and every row left is an `adapter` (db types, no persistence call) or a
`boundary` that owns a handle on purpose. A future `move` row is a
deliberate statement that something is on its way out, not a parking
space: the alternative to writing one is moving the code.

## How the measurement works

`Server/cmd/dbinventory` is syntactic (`go/parser` + `go/ast`, no type
information), like the invariants package. It records three things per file:

- **`db.*` types** — selectors that `db` declares as types (`db.User`,
  `db.Channel`, …). A file whose only use is types is **type-only**: it
  shapes data, it does not persist.
- **`db.*` funcs and sentinels** — package-level functions (`db.WriteAudit()`,
  `db.Open()`) and values (`db.ErrNotFound`). Pure helpers such as
  `db.StatusForViewer()` and `db.BroadcastStatus()` land here too; they are
  computations over already-loaded rows, not queries.
- **`*db.DB` method calls** — calls whose receiver is an identifier declared
  `*db.DB` in the file (parameter, result, var, or assigned from `db.Open*`),
  or a selector whose final field is declared `*db.DB` anywhere in the same
  package (`h.db.X`, `s.deps.DB.X`). This is the persistence surface the
  dispositions are about.

A shape the walker cannot see (a `*db.DB` reaching a file through an
interface, say) shows up as a row with an import and no recorded calls —
which is a row worth reading. Since the channel family's part 3, the hub's
read seams (`ws/readers.go`) are deliberately that shape: the consumer rows
name their seam, `DBReaders` wires the handle behind them at the composition
root, and the seam interfaces are the authoritative list of what those files
may read. 41 of the 62 rows are type-only, 33 of them `adapter`.
Type-only is a shape, not a verdict, and while `move` was still populated the
table kept the two apart — `admin/middleware.go` was type-only and still a
`move`, because what had to leave it was a decision it took on an
already-loaded row rather than a query it issued. Reading the shape column as
the disposition would have called it done. Both columns are still here for
that reason: the shape is measured, the disposition is judged.

Three seams in `ws/readers.go` are type-only with a difference worth naming:
unlike the read seams, `*db.DB` does **not** satisfy `VoiceStore`,
`PresenceStamper` or `SocketAuthenticator`. Their methods are
`service.VoiceService`'s, `service.UserService`'s and
`service.SessionService`'s, so the decisions behind them — which insert a
capacity limit selects, which channel a compensating write may touch, which
saved status survives a reconnect, whether a refusal is a bad credential or an
outage — cannot be answered by the handle alone. That is the line between a
seam that narrows the handle and a family that has moved, and it is why
`HubReaders` (which `DBReaders` wires wholesale) now holds only the four
handle-backed read seams.

## Database-call inventory

<!-- dbinventory:start -->

| File                              | `db.*` types                                                                                                                                                    | `db.*` funcs and sentinels                                                   | `*db.DB` method calls                                                                                                                    | Shape     | Disposition | Family | Why                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/admin.go`                  | `DB`                                                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | holds the handle for the admin mux; no calls                                                                                                                                                  |
| `admin/api.go`                    | `DB×2`                                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | passes the handle to handlers; no calls                                                                                                                                                       |
| `admin/backup_maintenance.go`     | `DB×3`                                                                                                                                                          | `CheckBackupIntegrity()` `ErrNotFound×2` `RetentionMaxDays` `WriteAudit()×2` | `BackupToSafe`                                                                                                                           | calls     | boundary    | —      | scheduled backup mechanics on the maintenance tick; settings via the service                                                                                                                  |
| `admin/handlers_backup.go`        | `DB×5`                                                                                                                                                          | `CheckBackupIntegrity()×2` `WriteAudit()×2`                                  | `BackupToSafe×2` `Close` `LogAudit` `SQLDb`                                                                                              | calls     | boundary    | —      | backup create/list/delete/restore owns the handle: VACUUM INTO, WAL checkpoint, close-and-swap                                                                                                |
| `admin/handlers_channel_perms.go` | `Channel×3` `ChannelRoleOverride×2` `ChannelUserOverride×2` `Role`                                                                                              | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | override response shapes; the service owns the policy and the calls                                                                                                                           |
| `admin/handlers_channels.go`      | `Channel`                                                                                                                                                       | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.Channel in the resolver and response shapes; the service owns the calls                                                                                                                    |
| `admin/handlers_users.go`         | `Role` `User`                                                                                                                                                   | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | UserWithRole/User/Role types in the panel response shapes; UserService owns the reads                                                                                                         |
| `admin/helpers.go`                | `Role×2` `User`                                                                                                                                                 | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Role/User types in response helpers                                                                                                                                                           |
| `admin/logstream.go`              | `DB×3`                                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | handle threaded to the SSE stream's auth check; no calls                                                                                                                                      |
| `admin/middleware.go`             | `Role×2`                                                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Role/User/Session types in the request context; SessionService resolves the bearer token                                                                                                      |
| `admin/types.go`                  | `Channel×3` `Role` `User` `UserWithRole`                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | response DTOs only — its GetRoleByID went with the user family                                                                                                                                |
| `admin/update_handlers.go`        | `DB×3`                                                                                                                                                          | `WriteAudit()`                                                               | `LogAudit`                                                                                                                               | calls     | boundary    | —      | audits the binary swap (OC-0391) with WriteAudit/LogAudit; no other calls                                                                                                                     |
| `api/appeal_handler.go`           | `ModerationAction` `User×3`                                                                                                                                     | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User from the auth context and db.ModerationAction response type only; AppealService owns every call                                                                                       |
| `api/channel_handler.go`          | `DB` `MessageAPIResponse×2` `MessageSearchResult×2` `ReactionUser` `User×8`                                                                                     | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | response types only; service owns the calls                                                                                                                                                   |
| `api/dm_handler.go`               | `DB` `DMChannelInfo` `DMUser×2` `User×8`                                                                                                                        | `NewDMChannelInfo()` `StatusForViewer()`                                     | —                                                                                                                                        | calls     | adapter     | —      | DM response types + pure status helpers                                                                                                                                                       |
| `api/dm_request_handler.go`       | `MessageRequest×2` `User×2`                                                                                                                                     | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | message-request response types; the service owns the calls                                                                                                                                    |
| `api/emoji_handler.go`            | `DB` `Emoji×3` `User×2`                                                                                                                                         | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Emoji/User types only                                                                                                                                                                         |
| `api/invite_handler.go`           | `DB` `Invite` `User×2`                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Invite/User types only                                                                                                                                                                        |
| `api/middleware.go`               | `Role` `Session` `User`                                                                                                                                         | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | User/Session/Role types on the context keys; SessionService owns the resolution, the touches and the expired-session discard                                                                  |
| `api/moderation_handler.go`       | `ModerationAction`                                                                                                                                              | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.ModerationAction response type only; ModerationService owns every call                                                                                                                     |
| `api/moderation_queue_handler.go` | `User`                                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User from the auth context only; ReportService owns every call                                                                                                                             |
| `api/nsfw_handler.go`             | `User×2`                                                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User type on the context key only; NSFWService owns every call                                                                                                                             |
| `api/plugins_handler.go`          | `Auditor×2`                                                                                                                                                     | `WriteAudit()`                                                               | —                                                                                                                                        | calls     | adapter     | —      | db.Auditor is the seam; WriteAudit only                                                                                                                                                       |
| `api/profile_handler.go`          | `DB` `Session×3` `User×8`                                                                                                                                       | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | User/Session types in the profile and session response shapes; the services own the calls                                                                                                     |
| `api/push_handler.go`             | `User×3`                                                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User type on the context key only; PushService owns every call                                                                                                                             |
| `api/report_handler.go`           | `User×2`                                                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User from the auth context only; ReportService owns every call                                                                                                                             |
| `api/router.go`                   | `DB×5`                                                                                                                                                          | —                                                                            | `PingRead` `SQLDb`                                                                                                                       | calls     | boundary    | —      | health probe (PingRead, SQLDb); hub construction left in B3-3                                                                                                                                 |
| `api/upload_handler.go`           | `Role` `User×2`                                                                                                                                                 | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | AttachmentAccess/User/Role types while serving the bytes; UploadService owns the access decisions                                                                                             |
| `auth/helpers.go`                 | `User`                                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User type in a helper signature                                                                                                                                                            |
| `auth/resolve.go`                 | `APIToken` `Role×2` `Session×2` `User×2`                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Session/APIToken/Role/User types; resolution is injected                                                                                                                                      |
| `cmd/gendocs/main.go`             | `DB×4`                                                                                                                                                          | `Migrate()` `Open()`                                                         | `Close×2` `QueryContext×2`                                                                                                               | calls     | boundary    | —      | docs generator migrates its own in-memory catalog                                                                                                                                             |
| `cmd/seed/main.go`                | `DB×6`                                                                                                                                                          | `Migrate()` `Open()`                                                         | `Close` `CreateChannel` `CreateMessage×2` `CreateUser` `GetOrCreateDMChannel` `GetUserByUsername` `ListChannels` `QueryRowContext`       | calls     | boundary    | —      | developer seeding tool owns its handle                                                                                                                                                        |
| `cmd/seed/profile_alpha.go`       | `DB×3`                                                                                                                                                          | `Migrate()`                                                                  | `BeginTx` `ExecContext×2` `QueryRowContext`                                                                                              | calls     | boundary    | —      | the alpha profile writes through the handle main.go owns                                                                                                                                      |
| `internal/app/app.go`             | `AuditWriter` `DB` `MarkerStore`                                                                                                                                | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | the App holds the handle for its lifetime; no calls                                                                                                                                           |
| `internal/app/database.go`        | `DB×2`                                                                                                                                                          | `Migrate()` `OpenWithMaxReaders()`                                           | `ClearAllVoiceStates` `ResetAllUserStatuses`                                                                                             | calls     | boundary    | —      | opens the handle, migrates, clears stale state at boot                                                                                                                                        |
| `internal/app/erasure.go`         | `DB` `MarkerStore`                                                                                                                                              | `OpenMarkerStore()`                                                          | `Close×2`                                                                                                                                | calls     | boundary    | —      | opens the deletion-marker file and replays it against the handle before anything serves (B4-10)                                                                                               |
| `internal/app/hub.go`             | `DB`                                                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | hands the handle to the hub and the service layer it builds                                                                                                                                   |
| `internal/app/maintenance.go`     | `DB×3`                                                                                                                                                          | —                                                                            | `CleanupExpiredSecondFactorState` `DeleteExpiredSessions` `DeleteOrphanedAttachments` `FindOrphanedVoiceMutes` `RetireModerationActions` | calls     | boundary    | —      | periodic worker: expired sessions, backups, orphan attachments                                                                                                                                |
| `internal/app/persistence.go`     | `AuditWriter×2` `DB×4`                                                                                                                                          | `ErrNotFound` `NewAuditWriter()`                                             | `GetMaxEventSeq` `GetSetting` `SetAuditWriter` `SetSetting`                                                                              | calls     | boundary    | —      | event persister, audit writer and the boot seq seed own the handle                                                                                                                            |
| `internal/app/plugins.go`         | `DB`                                                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | passes the handle to the plugin registry as its store; no calls                                                                                                                               |
| `plugin/pluginstore.go`           | `PluginRow×3`                                                                                                                                                   | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | PluginRow type only; the store is injected                                                                                                                                                    |
| `token_cli.go`                    | —                                                                                                                                                               | `Migrate()` `OpenShared()`                                                   | `Close`                                                                                                                                  | calls     | boundary    | —      | the token CLI opens, migrates and closes its own handle for the bootstrap path; TokenService owns every query                                                                                 |
| `ws/client.go`                    | `User×2`                                                                                                                                                        | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | db.User type on the connection                                                                                                                                                                |
| `ws/deps.go`                      | `Channel`                                                                                                                                                       | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | dispatch helpers read through the DispatchReader seam (readers.go); db types in signatures                                                                                                    |
| `ws/event.go`                     | —                                                                                                                                                               | `BroadcastStatus()`                                                          | —                                                                                                                                        | calls     | adapter     | —      | pure BroadcastStatus helper                                                                                                                                                                   |
| `ws/event_persister.go`           | `PersistedEvent×2`                                                                                                                                              | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | PersistedEvent type; store is an interface                                                                                                                                                    |
| `ws/eventstore.go`                | `PersistedEvent×3`                                                                                                                                              | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | PersistedEvent type; store is an interface                                                                                                                                                    |
| `ws/handlers.go`                  | `User`                                                                                                                                                          | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | command handlers read through the DispatchReader seam; db types in payload shapes                                                                                                             |
| `ws/handlers_chat.go`             | —                                                                                                                                                               | `NewDMChannelInfo()`                                                         | —                                                                                                                                        | calls     | adapter     | —      | pure NewDMChannelInfo helper                                                                                                                                                                  |
| `ws/hub.go`                       | `DB`                                                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | Hub state holds the handle the families read through; no calls                                                                                                                                |
| `ws/hub_broadcast.go`             | `Channel×2` `Emoji` `Role`                                                                                                                                      | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | member payloads read through the MemberPayloadReader seam; db types + pure BroadcastStatus                                                                                                    |
| `ws/hub_options.go`               | `DB`                                                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | boundary    | —      | construction validates and stores the handle; no calls                                                                                                                                        |
| `ws/hub_presence.go`              | —                                                                                                                                                               | `BroadcastStatus()`                                                          | —                                                                                                                                        | calls     | adapter     | —      | presence coalescer; pure BroadcastStatus helper and the MemberSummary shape                                                                                                                   |
| `ws/hub_visibility.go`            | `Channel×2` `ChannelOverride` `User`                                                                                                                            | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | visibility and audience resolve through the VisibilityReader seam; db types in signatures                                                                                                     |
| `ws/messages.go`                  | `Channel×4` `DMChannelInfo×2` `DMUser×2` `Emoji` `MessageRequest` `Role×3` `User×3` `VoiceState`                                                                | `BroadcastStatus()` `StatusForViewer()`                                      | —                                                                                                                                        | calls     | adapter     | —      | wire types + pure status helpers                                                                                                                                                              |
| `ws/readers.go`                   | `Channel×3` `ChannelOverride×2` `ChannelUnread` `DB` `DMChannelInfo` `MemberSummary` `ModerationNotice` `Role×4` `SessionWithBanStatus` `User×4` `VoiceState×5` | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | the hub's read seams plus the service-backed VoiceStore, PresenceStamper and SocketAuthenticator: db types in the interface signatures, and DBReaders wiring the handle behind the read seams |
| `ws/replay.go`                    | `PersistedEvent` `User`                                                                                                                                         | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | PersistedEvent type in the cold-tier filter; the resume path's reads bind the VisibilityReader seam and its status stamp goes through PresenceStamper                                         |
| `ws/serve_auth.go`                | `User`                                                                                                                                                          | `StatusOffline`                                                              | —                                                                                                                                        | calls     | adapter     | —      | db.User on the handshake result and the pure StatusOffline const; SessionService resolves the token and writes the connect audit                                                              |
| `ws/serve_pumps.go`               | —                                                                                                                                                               | `StatusOffline`                                                              | —                                                                                                                                        | calls     | adapter     | —      | pure StatusOffline const; the disconnect write goes through the PresenceStamper seam (readers.go)                                                                                             |
| `ws/serve_ready.go`               | `Channel×11` `ChannelOverride×6` `ChannelUnread×2` `DMChannelInfo×4` `MemberSummary×3` `Role×4` `User` `VoiceState×5`                                           | `StatusOffline×3`                                                            | —                                                                                                                                        | calls     | adapter     | —      | ready snapshot reads through ReadySnapshotReader; fresh-connect stale-voice cleanup through VoiceService                                                                                      |
| `ws/voice_join.go`                | `Channel×3` `ChannelOverride` `VoiceState×5`                                                                                                                    | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Channel/VoiceState/ChannelOverride types in the join sequence; VoiceService owns the voice_states reads and writes                                                                            |
| `ws/voice_moderation.go`          | `Role` `VoiceState×2`                                                                                                                                           | —                                                                            | —                                                                                                                                        | type-only | adapter     | —      | Role/VoiceState types in the moderation gate; VoiceService owns the writes, the rollback and the audit row                                                                                    |

62 files import `db` outside `db/` and `service/` (. 1, admin 12, api 16, auth 2, cmd/gendocs 1, cmd/seed 2, internal/app 7, plugin 1, ws 20); 41 are type-only; 0 unlisted.
Dispositions: adapter 42, boundary 20. Move targets: .

<!-- dbinventory:end -->

Reading the table:

- **Type-only rows (41, of which 33 are `adapter`)** mostly need no service:
  the `db` types they use are the wire and response shapes. Whether those
  types should live outside `db` is a B3-8 question per family, not a
  boundary violation. The count was 14 at B3-0 and rose as families moved
  their calls behind services and left their types behind. No row carries a
  `move` disposition any more: the last nine went together when the auth
  family closed (`8a5817a1`), `ws/replay.go` having become an `adapter` a
  commit earlier (`87d4ed37`). Type-only is now purely a shape observation,
  not a queue.
- **`ws/serve_ready.go`** is the single heaviest reader: the ready snapshot
  reads channels, overrides, unreads, DM channels, members, roles and voice
  states in one place. B3-5 made it the "fresh-connect initialisation" file
  (`handleFreshConnect` and its stale-voice cleanup moved in from
  `serve.go`); the channel family's part 3 put those reads behind
  `ReadySnapshotReader` and `StaleVoiceCleaner`, which is why the row is now
  `adapter` with no recorded calls.
- **One raw SQL escape** is left above the domain layer:
  `admin/handlers_backup.go` (`SQLDb` for `VACUUM INTO`), and it is a
  `boundary` — backup create/restore legitimately owns the handle. The other,
  `api/upload_handler.go`'s bare `QueryRowContext` over `messages.deleted`,
  went with the upload family: it is `db.IsMessageDeleted` now, asked through
  `UploadService.Resolve`.
- **Duplicated persistence** was what the family split was for, and B3-8
  closed all three instances. API-token CRUD left `admin/handlers_tokens.go`,
  which no longer imports `db` at all; `token_cli.go` keeps a `boundary` row
  because a bootstrap CLI owns its own handle. The owner-role read (OC-0345)
  left `admin/middleware.go`, now type-only behind `SessionService`, while
  `api/middleware.go` keeps its own row. The voice-state reads left
  `ws/hub_sweep.go` entirely, leaving `voice_join.go` and
  `voice_moderation.go` type-only behind `VoiceService`.
- **`ws/serve.go`** and **`ws/replay.go`** are the `connection` rows: not a
  domain family but the connect/disconnect lifecycle that touches four of
  them. B3-5 splits it by responsibility first (`replay.go` carries the
  reconnect replay family since the second split PR — type-only, it passes
  the handle to the shared helpers still in `serve.go`); the pieces then
  join their families' rows.

## Hub lifecycle inventory

Input to B3-3 (`internal/app/`) and B3-4 (constructor options). The
before-state was measured at `ad4defc2`; the after-state rows are B3-3's, on
`feat/b3-3-lifecycle`, and are what B3-4 starts from.

### Construction and setters (S-11) — before B3-3

`ws.NewHub(database, limiter, svc)` was called **once**, inside
`api.NewRouter` (`Server/api/router.go:106`) — not in `main.go`. The seven
post-construction setters and where they were called:

| Setter                    | Declared                     | Called from                       | Required before `Run`?                                                                     |
| ------------------------- | ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `SetPluginRegistry`       | `ws/hub_events.go:60`        | `api/router.go:325`               | only when plugins are enabled — optional collaborator                                      |
| `SetPluginEventSink`      | `ws/hub_events.go:70`        | `api/router.go:328`               | same                                                                                       |
| `SetLiveKit`              | `ws/hub_livekit.go:10`       | `api/router.go:342`               | **yes** for voice: every voice join needs the token signer; nil means voice silently fails |
| `SetLiveKitProcess`       | `ws/hub_livekit.go:48`       | `api/router.go:360`               | only when the supervised LiveKit process is configured                                     |
| `SetEventPersister`       | `ws/hub_events.go:40`        | `main.go:453`                     | **yes** when persistence is on: events emitted before it is set are not persisted          |
| `SetEventStore`           | `ws/hub_events.go:48`        | `main.go:454`                     | **yes** for replay: resume without a store answers a full `ready`                          |
| `SetPendingVoiceModFlags` | `ws/voice_moderation.go:599` | voice moderation paths at runtime | no — genuinely replaceable runtime state; stays a setter                                   |

Two owners (the router and `main.go`) set collaborators on one hub, and the
hub started (`hub.Run`, `ws/hub.go:273`) with no check that the required ones
were present.

### Construction and setters (S-11) — after B3-3

`ws.NewHub` is called from `app.StartRuntime`
(`Server/internal/app/hub.go`), which also applies every setter that must
land before `hub.Run` and then starts the dispatch goroutine.
`api.NewRouter` takes the built hub as part of `api.Runtime` and returns only
the handler and its cleanup.

| Setter                    | Called from (before)              | Called from (after)                                   | Still required before `Run`?   |
| ------------------------- | --------------------------------- | ----------------------------------------------------- | ------------------------------ |
| `SetPluginRegistry`       | `api/router.go:325`               | `internal/app/hub.go` (`wirePlugins`)                 | optional                       |
| `SetPluginEventSink`      | `api/router.go:328`               | `internal/app/hub.go` (`wirePlugins`)                 | optional                       |
| `SetLiveKit`              | `api/router.go:342`               | `internal/app/hub.go` (`startVoice`)                  | **yes** for voice              |
| `SetLiveKitProcess`       | `api/router.go:360`               | `internal/app/hub.go` (`startVoice`)                  | when supervised                |
| `SetEventPersister`       | `main.go:453`                     | `internal/app/persistence.go` (`startEventPersister`) | **yes** when persistence is on |
| `SetEventStore`           | `main.go:454`                     | `internal/app/persistence.go` (`startEventPersister`) | **yes** for replay             |
| `SetPendingVoiceModFlags` | voice moderation paths at runtime | unchanged                                             | no                             |

One **owner**: every row is now inside `internal/app`. Two of them are still
in a second file — the persister and the store are set where the persister is
built, one lifecycle stage after the hub, because both setters are explicitly
safe to call after `Run` has started (`ws/hub_events.go`) and moving them
earlier would reorder the boot. B3-4 is what collapses them into validated
`HubOptions` at the single construction point; the router is no longer one of
the places that has to change for it.

### Construction and setters (S-11) — after B3-4

`ws.NewHub(opts HubOptions) (*Hub, error)` refuses to construct without its
required collaborators — `DB`, `Limiter`, `Settings`, all four `Readers`
seams (`Visibility`, `Ready`, `Members`, `Dispatch`), `Voice`, `Presence` and
`Auth` — each with its own error except the seams, which `Readers.complete()`
refuses as one bundle (`validateHubOptions`, `ws/hub_options.go`) —
and validates option coherence (a `LiveKitProcess` without a `LiveKit` client
is an error, as is a negative replay budget). The eight setters' final
dispositions:

| Former setter             | Now                                             | Why                                                                                                                        |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SetLiveKit`              | `HubOptions.LiveKit`                            | was `rejectIfRunning`-guarded — construction wiring, never runtime state                                                   |
| `SetLiveKitProcess`       | `HubOptions.LiveKitProcess`                     | same; the restart path relaunches the whole app, nothing re-sets a process on a live hub; requires `LiveKit` at validation |
| `SetPluginRegistry`       | `HubOptions.PluginRegistry`                     | same                                                                                                                       |
| `ConfigureReplay`         | `HubOptions.ReplayRingSize` / `ReplayColdLimit` | same — the dispatch loop reads the ring unlocked, so it is sized exactly once                                              |
| `SetEventPersister`       | **still a setter** (`ws/hub_events.go`)         | atomic hot-swap; the persister is built one lifecycle stage after the hub and cannot exist before it                       |
| `SetEventStore`           | **still a setter** (`ws/hub_events.go`)         | same store wiring stage; atomic                                                                                            |
| `SetPluginEventSink`      | **still a setter** (`ws/hub_events.go`)         | the sink consumes the built hub's broadcaster — a genuine two-phase wire                                                   |
| `SetPendingVoiceModFlags` | **still a setter** (`ws/voice_moderation.go`)   | per-user runtime state, the one the B3-0 table already kept                                                                |

`rejectIfRunning` was deleted with its last construction-phase caller. The
single production call site is `internal/app.StartRuntime`; a missing
collaborator is now a `startHub` error at boot instead of a later panic
(`TestNewHub_RequiredCollaborators`, `TestHub_LiveKitProcessRequiresClient`).

### Locks

Five locks on `Hub`, all `syncutil` (so the `-tags deadlock` pass sees them):

| Lock          | Declared        | Guards (from the field comment)                                         |
| ------------- | --------------- | ----------------------------------------------------------------------- |
| `mu`          | `ws/hub.go:25`  | the client registry and subscriptions                                   |
| `seqMu`       | `ws/hub.go:58`  | seq assignment + replay insertion + delivery order, serialised together |
| `settingsMu`  | `ws/hub.go:122` | the cached server settings                                              |
| `keyHolderMu` | `ws/hub.go:130` | the voice E2EE key-holder map                                           |
| `presenceMu`  | `ws/hub.go:135` | presence coalescing state                                               |

**The lock order is not written down anywhere** — not in `Server/CLAUDE.md`,
`docs/architecture/websocket.md`, or `hub.go`. It is proven only by the
`-tags deadlock -count=10 ./ws/` pass. B3-5 records the order in `hub.go`'s
package comment before it moves a single function, so every pure-move commit
has something to be checked against.

### Start, drain, stop — before B3-3 (`main.go` `run`, `main.go:107`)

Start order, then the `defer` stack that undid it (LIFO — the last started
was the first stopped):

| #   | Start (`main.go`)                                        | Stop (`defer`, in registration order — ran in reverse)     |
| --- | -------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | background context                                       | `bgCancel()` `:118`                                        |
| 2   | `runOpenDatabase` → `db.OpenWithMaxReaders` `:314-322`   | `database.Close()` `:148`                                  |
| 3   | `runInitDatabase` → `db.Migrate` `:333-347`              | —                                                          |
| 4   | `runInitTelemetry` `:369`                                | `telemetryStop()` `:156`                                   |
| 5   | `runInitPlugins` `:392`                                  | `runClosePlugins` `:161`                                   |
| 6   | `api.NewRouter` → **hub built here** `:164`              | `routerCleanup()` `:165`, then `hub.GracefulStop()` `:172` |
| 7   | `runStartEventPersistence` `:435` (sets persister/store) | `runStopEventPersistence` `:176`                           |
| 8   | `runStartAuditWriter` `:488`                             | `runStopAuditWriter` `:186`                                |
| 9   | `runStartACME` `:505`                                    | via `runShutdownServers` `:667`                            |
| 10  | `runStartMaintenance` `:527`                             | `maintenanceStop()` `:207`                                 |
| 11  | `signal.NotifyContext` `:214`                            | `stop()` `:215`                                            |
| 12  | `runServeAndWait` `:629` → `runShutdownServers` `:667`   | `srv.Shutdown`, `acmeSrv.Shutdown`, hub drain              |

Three facts B3-3's composite close had to preserve, each already encoded in a
comment at the cited line: the audit writer's stop is registered **after**
`database.Close` so it flushes before the handle goes (`:183-186`); event
persistence stops before the LIFO-later `database.Close` so no prune is still
running (`:476`); `hub.GracefulStop` must run even on an early return so the
supervised LiveKit process is not orphaned (`:168-172`). Any early `return
err` between steps 2 and 12 relied on this defer stack — there was no single
close function, which is exactly what B3-3's failure-injection test now pins.

### Start, drain, stop — after B3-3 (`App.stages()` / `App.Close`)

`Server/internal/app/lifecycle.go` declares the start sequence as a list, and
`App.Close` walks the close step each stage registered in the reverse of that
order. There is no `defer` stack and no second teardown path: `App.Run` closes
on every return — a failed start, a serve error and a clean shutdown alike.

| #   | Stage (`App.stages()`) | Close step, and what it does                                                      |
| --- | ---------------------- | --------------------------------------------------------------------------------- |
| 1   | (in `Run`) `bgCtx`     | `background-context` — cancels bgCtx; registered first, so it runs **last**       |
| 2   | `data-dir`             | —                                                                                 |
| 3   | `tls`                  | —                                                                                 |
| 4   | `database`             | `database` — `database.Close()`, registered before the migration runs             |
| 5   | `migrate`              | —                                                                                 |
| 6   | `telemetry`            | `telemetry` — bounded OTel shutdown                                               |
| 7   | `plugins`              | `plugins` — `registry.Close`                                                      |
| 8   | `hub`                  | `hub` — `GracefulStopContext`, the only caller of `LiveKitProcess.Stop`           |
| 9   | `router`               | `router` — the rate-limiter cleanup goroutine                                     |
| 10  | `event-persistence`    | `event-persistence` — drains the persister, cancels bgCtx, joins the pruner       |
| 11  | `audit-writer`         | `audit-writer` — drains the audit queue                                           |
| 12  | `maintenance`          | `maintenance` — joins the maintenance loop                                        |
| 13  | `acme`                 | — (shut down by the `http` step, in the order the drain requires)                 |
| 14  | `http`                 | `http` — ACME shutdown, then in-flight handlers, then the hub, on one 30s budget  |
| 15  | `signals`              | `signals` — unregisters the signal handler; registered last, so it runs **first** |

Close order is therefore `signals`, `http`, `maintenance`, `audit-writer`,
`event-persistence`, `router`, `hub`, `plugins`, `telemetry`, `database`,
`background-context`. All three facts hold, and now hold **because of the
ordering rule** rather than because of where a `defer` happened to sit:

- the audit writer and event persistence both start after the database opens,
  so both stop before `database.Close`;
- the `http` step runs first, so in-flight handlers drain while the hub and
  the event persister are still live — which is why ACME and the HTTP server
  start one stage after the maintenance loop rather than before it;
- the `hub` step is reached on every return from `Run`, so a supervised
  livekit-server process is never orphaned (OC-0027).

`App.Close` reports the **first** error and still runs every later step: the
steps below a failing one are the ones that release the database handle, the
LiveKit process and the audit queue. `internal/app/close_test.go` pins the
order, the first-error rule and idempotence;
`internal/app/lifecycle_failure_test.go` fails each stage in turn — the table
is generated from `App.stages()`, so a new stage is covered the day it is
added — and asserts on every row that the error names the stage, no goroutine
is left running, the database handle is closed and the listener is not left
bound.

## Auth slice — before-state dependency graph

The three files B3-2 moves, and what they depend on at `ad4defc2`. The
after-state table follows it.

| File                   | Imports (module-internal)                                              | `db` symbols used                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api/auth_handler.go`  | `auth`, `db`, `permissions`, `service`                                 | types `DB`, `Session`, `User`; funcs `WriteAudit`, `IsUniqueConstraintError`; sentinels `ErrLastAdmin`, `ErrNotFound`; methods `CreateSession`, `CreateUserWithInvite`, `DeleteAccount`, `DeleteSession`, `GetSetting`, `GetUserByID`, `GetUserByUsername`, `UpdateUserCustomStatus` |
| `api/totp_handler.go`  | `auth`, `db`                                                           | types `DB`, `Session`, `User`; func `WriteAudit`; methods `DeleteOtherSessions`, `GetUserByID`, `UpdateUserTOTPSecret`                                                                                                                                                               |
| `auth/*.go` (10 files) | `db` (types only, in `helpers.go`, `resolve.go`), `config`, `syncutil` | types `User`, `Session`, `APIToken`, `Role` — no method calls; `auth` is a leaf that computes and does not persist                                                                                                                                                                   |

Eleven distinct `*db.DB` methods across the two handlers (ten after
de-duplicating `GetUserByID`). That was the upper bound set for the interface
`api/auth_deps.go` declares in B3-2.

### Auth slice — after-state dependency graph

Measured at `fe1d11b8` (B3-2, pre-squash). The handlers import `db` nowhere;
`api` goes from 12 `db` importers to 10.

| File                     | Imports (module-internal)                    | `db` symbols used                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/auth_deps.go`       | `service`                                    | none — nine-method `AuthService` interface naming `service.Principal`, `RegisterInput`, `LoginInput`, `AuthResult`, `TOTPChangeResult`                                                                                                                                                                                                 |
| `api/auth_handler.go`    | `auth`, `service`                            | none — `auth` for `ValidateUsername`/`ValidatePasswordStrength`; `service` for the interface's types, the `Err*` categories `writeAuthError` switches on, and `SanitizeText` (imported before B3-2 too)                                                                                                                                |
| `api/totp_handler.go`    | `auth`, `service`                            | none — `auth` for `ExtractBearerToken`; `service` for `TOTPChangeResult` and the `Err*` categories                                                                                                                                                                                                                                     |
| `api/middleware.go`      | `auth`, `db`, `permissions`, `service` (new) | unchanged row (`move`, auth): gained `principal(r)`, which reads the `*db.User`/`*db.Session` it already stores on the context and hands them to the handlers as `service.Principal`                                                                                                                                                   |
| `api/profile_handler.go` | unchanged                                    | unchanged row (`move`, upload): now hosts `userResponse`/`toUserResponse`, the one converter that names `db.User`, which `/me` and the auth responses share with `PATCH /users/me`                                                                                                                                                     |
| `service/auth.go`        | `auth`, `db`, `permissions`                  | funcs `WriteAudit`, `IsUniqueConstraintError`; sentinels `ErrLastAdmin`, `ErrNotFound`; the ten methods, through `service.Store`: `CreateSession`, `CreateUserWithInvite`, `DeleteAccount`, `DeleteOtherSessions`, `DeleteSession`, `GetSetting`, `GetUserByID`, `GetUserByUsername`, `UpdateUserCustomStatus`, `UpdateUserTOTPSecret` |
| `auth/ratescale.go`      | —                                            | none — the auth rate multiplier, moved from `api/constants.go` so the route mounts and the service's login accounting read one value                                                                                                                                                                                                   |

Honest reading of the plan's target ("handlers importing neither `db` nor
`service` directly"): met for `db`, not for `service`. Both handlers import
`service` because the consumer-owned interface is expressed in the service's
input and result types and its `Err*` values — the alternative, an `api`-side
copy of every type, would have been a second definition of the same shapes.
The dependency direction is still `api → service → db`; what the handlers no
longer see is the database.

## Client baselines are not here

The supplement's Phase 1 item 5 (client native-import, Rust-command,
import-cycle, timer/listener, bundle, coverage and mutation baselines) is B7's
entry work, recorded there. Nothing under `Client/` was measured for this
document.
