# Server boundaries — database-call and lifecycle inventory

**Written:** 2026-08-29 (B3-0), measured at `dev` `ad4defc2`.
**Re-measured:** 2026-08-30 (B3-2) — the first table and the auth slice's
after-state at `fe1d11b8` (pre-squash; the squash SHA is in the plan's B3-2
evidence block); 2026-08-30 (B3-3) — the first table again, and the hub
lifecycle section's after-state rows, on `feat/b3-3-lifecycle`.
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
| `move`      | persistence or a domain decision that belongs behind a service; **Family** names the service B3-8 (or B3-2) builds    |   26 |
| `adapter`   | a transport adapter that uses `db` types or pure helpers only — response shapes, status helpers — no persistence call |   17 |
| `boundary`  | an explicit composition or transaction boundary that legitimately owns a handle (process entry, CLIs, health probe)   |   12 |
| `remove`    | the import is unnecessary and goes                                                                                    |    0 |

The rows live in code, not only here: `Server/invariants/db_import_boundary.go`
holds them as `DBImportAllow`, the `db-import-boundary` rule fails any new
importer that has no row, and `TestDBImportAllowIsLive` fails any row whose
file stopped importing `db`. The list only shrinks — B3-2 deleted the two auth
handler rows (28 → 26 `move`), B3-8 deletes a family's rows as it moves.

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

A shape the walker cannot see (a `*db.DB` reaching a file through an untyped
interface, say) would show up as a row with an import and nothing recorded —
which is a row worth reading, and none exists today.

## Database-call inventory

<!-- dbinventory:start -->

| File                              | `db.*` types                                                                                                                 | `db.*` funcs and sentinels                                | `*db.DB` method calls                                                                                                                                                                                                                                                                  | Shape     | Disposition | Family       | Why                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------- | ------------ | ------------------------------------------------------------------ |
| `admin/admin.go`                  | `DB`                                                                                                                         | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | holds the handle for the admin mux; no calls                       |
| `admin/api.go`                    | `DB`                                                                                                                         | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | passes the handle to handlers; no calls                            |
| `admin/backup_maintenance.go`     | `DB×3`                                                                                                                       | `CheckBackupIntegrity()` `ErrNotFound×2` `WriteAudit()×2` | `BackupToSafe` `GetSetting×2`                                                                                                                                                                                                                                                          | calls     | move        | settings-ops | BackupToSafe, integrity check, settings reads                      |
| `admin/handlers_backup.go`        | `DB×5`                                                                                                                       | `CheckBackupIntegrity()×2` `WriteAudit()×2`               | `BackupToSafe×2` `Close` `LogAudit` `SQLDb`                                                                                                                                                                                                                                            | calls     | move        | settings-ops | backup trigger and download; raw SQLDb for VACUUM INTO             |
| `admin/handlers_channel_perms.go` | `Channel` `ChannelRoleOverride×2` `ChannelUserOverride×2` `DB×8` `Role×2` `User×2`                                           | `WriteAudit()×4`                                          | `DeleteChannelOverride` `DeleteChannelUserOverride` `GetChannel` `GetChannelPermissions×2` `GetRoleByID×3` `GetUserByID` `GetUserChannelPermissions×2` `ListChannelRoleOverrides` `ListChannelUserOverrides` `ListUserIDsByRole×2` `UpsertChannelOverride` `UpsertChannelUserOverride` | calls     | move        | channel      | override CRUD decides permission policy in the handler             |
| `admin/handlers_channels.go`      | `Channel×2` `ChannelUpdate×2` `DB×6`                                                                                         | `WriteAudit()×3`                                          | `AdminCreateChannel` `AdminDeleteChannel` `AdminUpdateChannel×2` `GetAuditLog` `GetChannel×4` `ListChannels`                                                                                                                                                                           | calls     | move        | channel      | channel CRUD + audit                                               |
| `admin/handlers_roles.go`         | `DB×4`                                                                                                                       | —                                                         | `GetRoleByID` `ListRoles`                                                                                                                                                                                                                                                              | calls     | move        | role         | two reads; service/role.go already owns the writes                 |
| `admin/handlers_settings.go`      | `DB×4`                                                                                                                       | `ErrNotFound` `WriteAudit()`                              | `BeginTx` `CountUsersWithoutTOTP` `GetAllSettings×2` `GetSetting`                                                                                                                                                                                                                      | calls     | move        | settings-ops | BeginTx in a handler; TOTP census                                  |
| `admin/handlers_tokens.go`        | `DB×3` `User`                                                                                                                | `WriteAudit()×2`                                          | `CreateAPIToken` `GetOwnerUser` `GetUserByUsername` `ListAPITokens` `RevokeAPIToken`                                                                                                                                                                                                   | calls     | move        | auth         | API-token CRUD duplicated in token_cli.go                          |
| `admin/handlers_users.go`         | `DB×4` `Role` `User`                                                                                                         | —                                                         | `GetServerStats` `GetUserByID×2` `ListAllUsers`                                                                                                                                                                                                                                        | calls     | move        | user         | user list, stats, lookups                                          |
| `admin/helpers.go`                | `Role×2` `User`                                                                                                              | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | Role/User types in response helpers                                |
| `admin/logstream.go`              | `DB×3`                                                                                                                       | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | handle threaded to the SSE stream's auth check; no calls           |
| `admin/middleware.go`             | `DB×3` `Role` `User`                                                                                                         | —                                                         | `GetRoleByID`                                                                                                                                                                                                                                                                          | calls     | move        | auth         | owner gate re-reads the role — OC-0345                             |
| `admin/setup_handler.go`          | `DB×4`                                                                                                                       | `ErrConflict` `WriteAudit()×2`                            | `CreateChannel×2` `CreateInvite` `CreateOwnerIfEmpty` `CreateSession` `GetSetting×3` `UserCount`                                                                                                                                                                                       | calls     | move        | auth         | first-run owner creation (setup sub-family)                        |
| `admin/setup_wizard.go`           | `DB`                                                                                                                         | —                                                         | `BeginTx`                                                                                                                                                                                                                                                                              | calls     | move        | auth         | BeginTx for the wizard; setup sub-family                           |
| `admin/types.go`                  | `Channel×3` `DB` `Role` `User` `UserWithRole`                                                                                | —                                                         | `GetRoleByID`                                                                                                                                                                                                                                                                          | calls     | adapter     | —            | response DTOs; the one GetRoleByID moves with handlers_users       |
| `api/channel_handler.go`          | `DB` `MessageAPIResponse×2` `MessageSearchResult×2` `ReactionUser` `User×8`                                                  | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | response types only; service owns the calls                        |
| `api/dm_handler.go`               | `DB` `DMChannelInfo` `DMUser×2` `User×8`                                                                                     | `NewDMChannelInfo()` `StatusForViewer()`                  | —                                                                                                                                                                                                                                                                                      | calls     | adapter     | —            | DM response types + pure status helpers                            |
| `api/emoji_handler.go`            | `DB` `Emoji×3` `User×2`                                                                                                      | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | Emoji/User types only                                              |
| `api/gif_handler.go`              | `DB`                                                                                                                         | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | handle in the signature, unused for calls                          |
| `api/invite_handler.go`           | `DB` `Invite` `User×2`                                                                                                       | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | Invite/User types only                                             |
| `api/middleware.go`               | `DB` `Role` `Session` `User`                                                                                                 | —                                                         | `DeleteSession` `TouchAPIToken` `TouchSession`                                                                                                                                                                                                                                         | calls     | move        | auth         | session/API-token touch and revoke                                 |
| `api/plugins_handler.go`          | `Auditor×2`                                                                                                                  | `WriteAudit()`                                            | —                                                                                                                                                                                                                                                                                      | calls     | adapter     | —            | db.Auditor is the seam; WriteAudit only                            |
| `api/profile_handler.go`          | `DB×2` `Session×2` `User×7`                                                                                                  | —                                                         | `CreateAttachment`                                                                                                                                                                                                                                                                     | calls     | move        | upload       | avatar upload creates the attachment row                           |
| `api/router.go`                   | `DB×4`                                                                                                                       | —                                                         | `PingRead` `SQLDb`                                                                                                                                                                                                                                                                     | calls     | boundary    | —            | health probe (PingRead, SQLDb); hub construction left in B3-3      |
| `api/upload_handler.go`           | `AttachmentAccess×2` `DB×5` `Role` `User×3`                                                                                  | —                                                         | `CreateAttachment` `GetAttachmentWithChannel` `IsAvatarFileURL` `IsDMParticipant` `QueryRowContext`                                                                                                                                                                                    | calls     | move        | upload       | attachment access + a raw QueryRowContext                          |
| `auth/helpers.go`                 | `User`                                                                                                                       | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | db.User type in a helper signature                                 |
| `auth/resolve.go`                 | `APIToken` `Role×2` `Session×2` `User×2`                                                                                     | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | Session/APIToken/Role/User types; resolution is injected           |
| `cmd/gendocs/main.go`             | `DB×3`                                                                                                                       | `Migrate()` `Open()`                                      | `Close×2` `QueryContext×2`                                                                                                                                                                                                                                                             | calls     | boundary    | —            | docs generator migrates its own in-memory catalog                  |
| `cmd/seed/main.go`                | `DB×6`                                                                                                                       | `Migrate()` `Open()`                                      | `Close` `CreateChannel` `CreateMessage×2` `CreateUser` `GetOrCreateDMChannel` `GetUserByUsername` `ListChannels` `QueryRowContext`                                                                                                                                                     | calls     | boundary    | —            | developer seeding tool owns its handle                             |
| `cmd/seed/profile_alpha.go`       | `DB×3`                                                                                                                       | `Migrate()`                                               | `BeginTx` `ExecContext×2` `QueryRowContext`                                                                                                                                                                                                                                            | calls     | boundary    | —            | the alpha profile writes through the handle main.go owns           |
| `internal/app/app.go`             | `AuditWriter` `DB`                                                                                                           | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | the App holds the handle for its lifetime; no calls                |
| `internal/app/database.go`        | `DB×2`                                                                                                                       | `Migrate()` `OpenWithMaxReaders()`                        | `ClearAllVoiceStates` `ResetAllUserStatuses`                                                                                                                                                                                                                                           | calls     | boundary    | —            | opens the handle, migrates, clears stale state at boot             |
| `internal/app/hub.go`             | `DB`                                                                                                                         | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | hands the handle to the hub and the service layer it builds        |
| `internal/app/maintenance.go`     | `DB×3`                                                                                                                       | —                                                         | `DeleteExpiredSessions` `DeleteOrphanedAttachments`                                                                                                                                                                                                                                    | calls     | boundary    | —            | periodic worker: expired sessions, backups, orphan attachments     |
| `internal/app/persistence.go`     | `AuditWriter×2` `DB×4`                                                                                                       | `ErrNotFound` `NewAuditWriter()`                          | `GetMaxEventSeq` `GetSetting` `SetAuditWriter` `SetSetting`                                                                                                                                                                                                                            | calls     | boundary    | —            | event persister, audit writer and the boot seq seed own the handle |
| `internal/app/plugins.go`         | `DB`                                                                                                                         | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | boundary    | —            | passes the handle to the plugin registry as its store; no calls    |
| `plugin/pluginstore.go`           | `PluginRow×3`                                                                                                                | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | PluginRow type only; the store is injected                         |
| `token_cli.go`                    | `DB×3` `User`                                                                                                                | `Migrate()` `OpenShared()` `WriteAudit()×3`               | `Close` `CreateAPIToken` `GetOwnerUser` `GetUserByUsername` `ListAPITokens` `RevokeAPIToken` `RevokeAPITokenByLabel`                                                                                                                                                                   | calls     | move        | auth         | API-token CLI duplicates admin/handlers_tokens.go                  |
| `ws/client.go`                    | `User×2`                                                                                                                     | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | db.User type on the connection                                     |
| `ws/deps.go`                      | `Channel` `DB×5`                                                                                                             | —                                                         | `GetRoleForUser×3` `IsDMParticipant`                                                                                                                                                                                                                                                   | calls     | move        | channel      | role and DM-membership reads behind the hub's deps                 |
| `ws/event.go`                     | —                                                                                                                            | `BroadcastStatus()`                                       | —                                                                                                                                                                                                                                                                                      | calls     | adapter     | —            | pure BroadcastStatus helper                                        |
| `ws/event_persister.go`           | `PersistedEvent×2`                                                                                                           | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | PersistedEvent type; store is an interface                         |
| `ws/eventstore.go`                | `PersistedEvent×3`                                                                                                           | —                                                         | —                                                                                                                                                                                                                                                                                      | type-only | adapter     | —            | PersistedEvent type; store is an interface                         |
| `ws/handlers.go`                  | `User`                                                                                                                       | —                                                         | `GetChannel` `GetRoleForUser` `GetSessionWithBanStatus` `IsDMParticipant`                                                                                                                                                                                                              | calls     | move        | channel      | channel, role, session-ban and DM reads in command handlers        |
| `ws/handlers_chat.go`             | —                                                                                                                            | `NewDMChannelInfo()`                                      | —                                                                                                                                                                                                                                                                                      | calls     | adapter     | —            | pure NewDMChannelInfo helper                                       |
| `ws/hub.go`                       | `DB×2`                                                                                                                       | —                                                         | `GetSetting×2`                                                                                                                                                                                                                                                                         | calls     | move        | settings-ops | GetSetting at construction                                         |
| `ws/hub_broadcast.go`             | `Channel×4` `Emoji` `Role`                                                                                                   | `BroadcastStatus()`                                       | `GetChannel×2` `GetDMParticipantIDs` `GetRoleForUser` `GetUserByID×2` `ListChannels`                                                                                                                                                                                                   | calls     | move        | channel      | visibility refresh reads channels, roles, users                    |
| `ws/hub_sweep.go`                 | `User`                                                                                                                       | —                                                         | `GetAllVoiceStates` `GetChannel` `GetChannelVoiceStates` `GetSessionsWithBanStatusBatch` `LeaveVoiceChannelIfMatch×2`                                                                                                                                                                  | calls     | move        | voice        | stale-voice sweep reads and leaves                                 |
| `ws/messages.go`                  | `Channel×4` `DMChannelInfo×2` `DMUser×2` `Emoji` `Role×3` `User×2` `VoiceState`                                              | `BroadcastStatus()` `StatusForViewer()`                   | —                                                                                                                                                                                                                                                                                      | calls     | adapter     | —            | wire types + pure status helpers                                   |
| `ws/serve.go`                     | `ChannelOverride` `DB×9` `PersistedEvent` `User` `VoiceState`                                                                | `ConnectStatus()` `StatusOffline` `WriteAudit()`          | `GetChannelOverridesFor` `GetRoleByID×4` `GetUserByID×2` `GetUserDMChannelIDs` `GetVoiceState` `LeaveVoiceChannelIfMatch` `ListChannels` `MarkUserDisconnected` `UpdateUserStatus`                                                                                                     | calls     | move        | connection   | connect/disconnect lifecycle; B3-5 splits it by family first       |
| `ws/serve_auth.go`                | `DB` `User`                                                                                                                  | —                                                         | `GetSessionByTokenHash` `GetUserByID`                                                                                                                                                                                                                                                  | calls     | move        | auth         | session lookup on the WebSocket handshake                          |
| `ws/serve_pumps.go`               | —                                                                                                                            | `StatusOffline`                                           | `MarkUserDisconnected`                                                                                                                                                                                                                                                                 | calls     | move        | user         | MarkUserDisconnected on pump exit                                  |
| `ws/serve_ready.go`               | `Channel×10` `ChannelOverride×6` `ChannelUnread×2` `DB×5` `DMChannelInfo×4` `MemberSummary×3` `Role×4` `User` `VoiceState×4` | `StatusOffline×3`                                         | `GetAllVoiceStates` `GetChannelOverridesFor` `GetChannelUnreadCounts` `GetUserDMChannels` `ListChannels` `ListMembers` `ListRoles`                                                                                                                                                     | calls     | move        | channel      | ready snapshot: channels, overrides, unreads, DMs, members         |
| `ws/voice_join.go`                | `Channel×3` `ChannelOverride` `VoiceState×5`                                                                                 | `ErrChannelFull`                                          | `GetChannel×2` `GetChannelOverridesFor` `GetChannelVoiceStates` `GetRoleForUser` `GetVoiceState×6` `JoinVoiceChannel` `JoinVoiceChannelIfCapacity` `LeaveVoiceChannelIfMatch` `SetVoiceServerDeafen` `SetVoiceServerMute`                                                              | calls     | move        | voice        | voice state reads and writes                                       |
| `ws/voice_moderation.go`          | `Role` `VoiceState×3`                                                                                                        | `WriteAudit()`                                            | `CountChannelVoiceUsers` `GetChannel×2` `GetRoleForUser` `GetVoiceState×2` `SetVoiceServerDeafen×2` `SetVoiceServerMute×2`                                                                                                                                                             | calls     | move        | voice        | mute/deafen/move persist voice state                               |

56 files import `db` outside `db/` and `service/` (. 1, admin 16, api 10, auth 2, cmd/gendocs 1, cmd/seed 2, internal/app 6, plugin 1, ws 17); 17 are type-only; 0 unlisted.
Dispositions: adapter 17, boundary 13, move 26. Move targets: auth 7, channel 6, connection 1, role 1, settings-ops 4, upload 2, user 2, voice 3.

<!-- dbinventory:end -->

Reading the table:

- **Type-only files (14)** need no service; they stay `adapter`. The `db`
  types they use are the wire and response shapes. Whether those types should
  live outside `db` is a B3-8 question per family, not a boundary violation.
- **`ws/serve_ready.go`** (45 references, 7 distinct queries) is the single
  heaviest reader: the ready snapshot reads channels, overrides, unreads, DM
  channels, members, roles and voice states in one place. B3-5 keeps it as
  the "fresh-connect initialisation" file and B3-8's channel family gives it
  a snapshot service.
- **Two raw SQL escapes** exist above the domain layer:
  `api/upload_handler.go` (`QueryRowContext`) and `admin/handlers_backup.go`
  (`SQLDb` for `VACUUM INTO`). Both are `move`; the backup one may end as an
  explicit `boundary` once `settings-ops` owns backups — the row is decided
  when that family moves, not now.
- **Duplicated persistence** is visible in the families: API-token CRUD in
  `admin/handlers_tokens.go` and `token_cli.go`; owner-role reads in
  `admin/middleware.go` (OC-0345) and `api/middleware.go`; voice state in
  `ws/hub_sweep.go`, `voice_join.go`, `voice_moderation.go`. One service per
  family removes each duplicate.
- **`ws/serve.go`** is the one `connection` row: it is not a domain family but
  the connect/disconnect lifecycle that touches four of them. B3-5 splits it
  by responsibility first; the pieces then join their families' rows.

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
