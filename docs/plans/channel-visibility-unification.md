# Channel-Visibility Unification (backlog item 3) — Design

**Status:** greenlit 2026-07-20 (D9), not yet implemented
**Decision:** D9 in [audit-2026-07-19-decisions.md](audit-2026-07-19-decisions.md)
**Closes:** audit finding A-2026-07-07 (backlog §6 item 3)

## Problem

Per the audit, the "does this role see this channel" rule is implemented ~4× with
comments telling each copy it "must mirror" the others:

- `service.ChannelService.ListVisibleChannels` (REST `GET /channels`),
- `ws.buildReady` (the ready payload's channel list),
- `ws.computeAllowedChannels` (replay-buffer filtering on reconnect),
- `ws.Hub.RefreshChannelVisibility` (targeted channel_create/delete after an
  override change).

All four inline the same predicate — `HasAdmin(perms) || EffectivePerms(perms,
allow, deny)&ReadMessages == ReadMessages` — plus the same "skip `dm` channels,
fail closed on nil role" scaffolding. The recent private-channel fixes show this
churns; a drift between copies is an information-disclosure bug.

## Approach — funnel all four through the checker that already exists

The unified predicate is **already written**: `permissions.Checker.HasChannelPermBatch`
(pre-fetched overrides map) and `.HasChannelPerm` (single-channel). Three of the
four sites bypass it by re-inlining the bit math; `RefreshChannelVisibility` does
its own `GetChannelPermissions` + `EffectivePerms`. The fix is to route every
site through the checker, not to invent a new abstraction:

1. Add one thin helper to `permissions.Checker`:
   `VisibleChannelIDs(rolePerms int64, channels []ChannelRef, overrides map[int64]ChannelOverride) map[int64]bool`
   — iterates, skips `dm`, and calls the existing `HasChannelPermBatch` per
   channel. `ChannelRef{ID int64; Type string}` is declared in `permissions`
   (the package deliberately avoids importing `db`, so callers map their
   `[]db.Channel` down to `[]ChannelRef`).
2. `ListVisibleChannels`, `buildReady`, and `computeAllowedChannels` call it.
   `buildReady` still fetches the overrides map once (it reuses it for `can_send`
   and unread), then hands the same map to `VisibleChannelIDs`.
   `computeAllowedChannels` unions the result with the user's open DM channels
   (unchanged). Nil role → empty set, which the helper yields naturally.
3. `RefreshChannelVisibility`'s per-role check calls the existing
   `HasChannelPerm(rolePerms, roleID, ch.ID, ReadMessages)` instead of its inline
   copy. Its targeted-send + `visibilityChangeSeq` watermark mechanics are
   untouched.

## Files touched

- `Server/permissions/checker.go` — add `ChannelRef` + `VisibleChannelIDs`.
- `Server/permissions/checker_test.go` — cover the helper (admin bypass, deny
  override hides, no-override inherits base, dm skipped).
- `Server/service/channel.go` — `ListVisibleChannels` delegates.
- `Server/ws/serve.go` — `buildReady`, `computeAllowedChannels` delegate; drop
  the "mirrors …" comments.
- `Server/ws/hub.go` — `RefreshChannelVisibility` uses `HasChannelPerm`.
- Docs: `docs/audit-2026-07-19.md` (A-2026-07-07 → RESOLVED),
  `docs/architecture/server.md`/`websocket.md` if a visibility callout names the
  duplication.

## Test plan

- Unit tests for `VisibleChannelIDs` in `permissions`.
- **REST/WS agreement test** (the audit's explicit ask): seed a real in-memory
  `db` with roles, per-channel overrides, and text/announcement/voice/dm
  channels; assert `ListVisibleChannels`, the channel set inside `buildReady`,
  and the non-DM subset of `computeAllowedChannels` are byte-for-byte the same
  set for the same user across admin / member-with-deny / nil-role cases.
- Existing `serve_test.go`, `hub_test.go`, `channel_handler` tests stay green
  unchanged (behavior is identical; only the code path is shared).

## Non-goals

- No change to permission bits, override storage, or the `EffectivePerms`
  algebra — only where the existing predicate is called from.
- DM visibility stays membership-based (added on top of the server-channel set,
  not routed through the checker).
- `can_send`, unread counts, and voice-state filtering in `buildReady` are
  unchanged.
- Not touching `RefreshChannelVisibility`'s targeted-send / watermark design
  (backlog 11/12 territory) — only its read predicate.
