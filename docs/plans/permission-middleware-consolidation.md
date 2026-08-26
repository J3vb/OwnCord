# Permission-Middleware Consolidation (audit finding A-2026-07-16) — Design

**Status:** implemented 2026-07-23 (D13) — re-verified 2026-08-04. The one
deliberately-unfixed copy disclosed at the end of this document,
`ws.channelCanSend`, still exists as a hand-rolled resolution (now at
`Server/ws/serve_ready.go:119`, feeding the ready payload's `can_send` flag) —
the disclosed follow-up remains open.
**Decision:** D13 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md)
**Closes:** audit finding A-2026-07-16 (new, HIGH). Closes **none** of backlog §6
item 12's findings — A-2026-07-06, A-2026-07-10 and A-2026-07-11 all remain
exactly as recorded; row 12 stays unstruck and unannotated.

## Problem

Two separate defects in the same rule, found by pulling on the same thread.

**1. The server-wide rule has no home.** `api.RequirePermission` (`middleware.go:112`)
does an admin bypass and then a raw `role.Permissions&perm == 0` bit test.
`service.ModerationService` (`moderation.go:38`) writes the same rule as
`!HasAdmin(p) && !HasPerm(p, BanMembers)`. The `permissions` package exposes
`HasPerm`, `HasAdmin`, `EffectivePerms` and four **channel-scoped** `Checker`
methods — nothing combining the admin bypass with a channel-less bit, so both
sites hand-rolled it. The raw test is also any-of (`&perm != 0`) where `HasPerm`
is all-of: identical for the single-bit constants both call sites pass today,
silently divergent for any future multi-bit mask.

**2. A channel-level `deny` is genuinely not honoured — one layer down.**
`PermissionService.getOrPopulate` (`permission.go:145-149`) and
`ChannelService.ListVisibleChannels` (`channel.go:58-61`) substitute an _empty
override map_ when `GetAllChannelPermissionsForRole` errors. Every `deny` bit for
that role evaporates, and `PermissionService` then **caches** the degraded
snapshot for `permCacheTTL` (30s), across `HasChannelPerm`'s ~25 callers: message
reads, pins, attachment serving, WS. Meanwhile `permissions.Checker`
(`checker.go:60-63`), `MessageService.GetAccessibleChannelIDs`
(`message.go:643-646`) and `ws.buildReady` (`serve.go:622-624`) all fail _closed_
on the identical error. Two of five sites dissent, and they are the cached ones.

D9 also declared `VisibleChannelIDs` the single visibility predicate; it missed a
fifth site — `GetAccessibleChannelIDs` still re-inlines admin bypass + dm-skip +
`EffectivePerms` + a raw READ mask (`message.go:639-666`).

## Approach — one server-scoped predicate, and fail closed on override load

1. Add `permissions.HasServerPerm(rolePerms, perm int64) bool` — four lines,
   `HasAdmin(rolePerms) || HasPerm(rolePerms, perm)`, no DB, no interface.
   `RequirePermission` and `ModerationService.BanUser` both collapse onto it.
   `RequirePermission`'s signature is unchanged, so nothing needs replumbing.
2. Fail closed at both override-fetch sites. `getOrPopulate` first **skips the
   fetch entirely for admins** (mirroring `channel.go:57` and `serve.go:619` —
   they bypass every channel check anyway), then `return nil` on error, caching
   nothing so the next request retries. `ListVisibleChannels` returns
   `ErrInternal`. Both log `slog.Error` at the fail point.
3. Delete the two remaining copies of the channel rule.
   `PermissionService.HasChannelPerm` delegates to the `Checker` it already holds
   (`HasChannelPermBatch`) once `cachedPerms.overrides` carries
   `permissions.ChannelOverride` — converted once at populate time by the
   existing `permOverrides` helper (`channel.go:86`, same package, no adapter
   needed). `GetAccessibleChannelIDs` calls `VisibleChannelIDs`, making D9's
   closure true rather than aspirational.

Routing `RequirePermission` through the `Checker` is explicitly **not** the fix —
see Non-goals.

## Files touched

- `Server/permissions/permissions.go` — add `HasServerPerm`.
- `Server/api/middleware.go` — `RequirePermission` uses it; `AuthMiddleware`
  gains the missing `|| role == nil` (`GetRoleByID` returns `(nil, nil)` for a
  missing row, so a dangling `role_id` puts a typed-nil `*db.Role` in ctx today;
  `admin/middleware.go:52` already checks).
- `Server/service/moderation.go` — second server-scoped site collapses.
- `Server/service/permission.go` — admin skip + fail closed in `getOrPopulate`;
  `HasChannelPerm` delegates; `cachedPerms.overrides` retyped.
- `Server/service/channel.go` — `ListVisibleChannels` fails closed.
- `Server/service/message.go` — `GetAccessibleChannelIDs` delegates to
  `VisibleChannelIDs`.
- Docs: `docs/audit-2026-07-19.md` — new §1 + §3 rows for A-2026-07-16
  (RESOLVED 2026-07-23 (D13)); amend the A-2026-07-07 rows to record the missed
  fifth site; row 12 untouched. `docs/plans/audit-2026-07-19-decisions.md` — D13
  row + status clause. `docs/architecture/server.md` — D3 prose (§"enforced
  inconsistently") and the source-of-truth list.

## Test plan

- `TestHasChannelPerm_OverrideFetchErrorDenies` and
  `TestListVisibleChannels_OverrideFetchErrorFailsClosed` — a `Store` double
  embedding `*db.DB` (the `pwStore` pattern, `user_test.go:16`) that fails only
  `GetAllChannelPermissionsForRole`, over a real seeded `deny`. **Both fail on
  today's code**; they are the headline locks.
- `TestHasServerPerm` — table-driven, pins the all-of contract and the admin
  bypass at the layer that owns the rule.
- `TestRequirePermission_MultiBitRequiresAllBits` — the any-of → all-of
  tightening is the only semantic change to the middleware; nothing else fails if
  someone reverts to `&perm != 0`.
- `TestCreateInvite_ChannelAllowOverrideDoesNotGrant` — a channel override
  granting `MANAGE_INVITES` must not open a server-wide route. Reachable state:
  `admin/handlers_channel_perms.go:100` masks with `AllPerms`, which permits it.
- `TestDiagnosticsConnectivity_MemberForbidden` and
  `TestAuthMiddleware_DanglingRoleUnauthorized` — the second `RequirePermission`
  route has no 403 lock at all today, and the nil-role guard is a 403→401 flip
  that must not ship untested.
- Existing deny locks stay green untouched and are the regression net:
  `channel_authz_test.go:94/110`, `channel_handler_test.go:788`,
  `upload_handler_test.go:1222`, `permission_test.go:50`, `can_send_test.go:34`.

## Non-goals

- **Making `RequirePermission` channel-aware.** Neither route has a channel, chi
  cannot hand a `r.Use` middleware a `{id}` declared on its own mux (v5.2.5
  `mux.go:513`), `GET /api/v1/files/{id}` could never use it (its channel id
  comes from the DB row), and ws has no HTTP middleware — so it would be a
  _second_ enforcement point for a rule the `Checker` owns. `channelID=0` would
  issue a query whose right-looking answer is an accident of `ErrNoRows`
  handling (`db/channel_queries.go:140`), not a design.
- **The auth-route DB sweep (item 12 / A-2026-07-06).** `AuthMiddleware` has 20
  call sites and the auth handlers ride on raw db sentinels (`handleLogin`'s
  enumeration defence needs `GetUserByUsername`'s `(nil, nil)`;
  `ErrLastAdmin`→403; `IsUniqueConstraintError`→400). **D14**, first slice: a
  `service.AuthService` behind `AuthMiddleware`, which also deletes the
  `database *db.DB` parameter from the five Mount funcs that feed it nothing
  else. That is when row 12 earns `PARTIAL`, not this PR.
- **A source-scanning guard test** for raw bit patterns — a homegrown regexp
  lint with a known ceiling, catching what the two new tests plus review already
  catch. Revisit as a `golangci-lint` rule if it recurs.
- **`ws.channelCanSend`** (`serve.go:583-590`) — the last hand-rolled copy. It
  holds an override _value_, not a map, so reducing it needs a one-entry map
  allocation on the ready hot path or a new value-taking predicate. Disclosed
  deliberately rather than fixed; separate PR.
- No `(bool, error)` permission signatures (`ws/deps.go:86-90`'s
  INTERNAL-vs-FORBIDDEN precedent is right but is a ~25-site change), no
  rate-limiter reordering, no `IsOwnerRole` deletion, no 403 body change.
