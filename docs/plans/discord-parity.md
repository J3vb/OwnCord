# Discord feature parity — gap analysis and plan

Status: quick wins in progress (2026-07-31)

This is a depth audit of features OwnCord already has, compared against what
Discord's version of the same feature can do (free tier, with Nitro notes where
relevant). Wholly absent features (threads, forums, polls, soundboard, …) are
listed at the end for reference but are out of scope here — the focus is
finishing the features we have.

## Where OwnCord already meets or beats Nitro

- Uploads: 100 MB default (free Discord: 10 MB, Nitro Basic: 50 MB, Nitro: 500 MB) — and `max_upload_bytes` is operator-configurable.
- Message length: 4000 runes, equal to Nitro's limit (free Discord: 2000).
- Streaming: source-quality preset and up to 120 fps, above Nitro's 1080p60/4K60.
- Client themes: full custom CSS-var theming with import/export — a paid perk on Discord.
- E2EE voice with TOFU identity verification — Discord has no equivalent at any tier.

## Phase 1 — quick wins (this branch)

Features where one side is already built and the other was never finished.

| # | Item | What exists | What's missing |
|---|------|-------------|----------------|
| 1 | Block/unblock UI | Full server enforcement (`user_blocks`, DM create + send checks), `GET /blocks` client call | Client never calls `PUT/DELETE /api/v1/blocks/{userId}`; no menu items |
| 2 | Channel topics in client | `channels.topic` column, admin-panel editing | Not in WS `ready` payload; chat header never renders it; client edit modal is name-only |
| 3 | Role colors | `roles.color` stored and shipped in `ready` | Client hardcodes a switch on 4 role names (`formatting.ts`) |
| 4 | Profile popup | `UserProfilePopup.ts` built and unit-tested | Never mounted; member click opens only the admin context menu |
| 5 | Temp bans | `users.ban_expires`, `BanUser(..., expires)`, `IsEffectivelyBanned` all honor expiry | Every caller passes `nil`; no API field, no UI |
| 6 | Archived channels | `channels.archived` stored, settable in admin panel | No read path filters on it — archived channels appear everywhere |

## Phase 2 — moderation depth

- **DONE (2026-07-31)** — Honest kick semantics. There is no membership model, so `DELETE /admin/api/users/{id}/sessions` cannot remove anyone; it revokes the target's sessions and they can sign straight back in. Rather than invent a membership table, the user-facing action is renamed to what it does: the desktop member-list menu item is now **Force Logout** (confirm "Log them out?", pending "Logging out...", toast "Forced {name} to log out"), and the admin panel's row button, modal and toast say Force Logout too, with the modal spelling out that the user can sign back in. The endpoint, the `KICK_MEMBERS` bit and the `onKick`/`adminKickMember` call sites are unchanged.
- **DONE (2026-07-31)** — Enforce the decorative permission bits. The `/admin/api` perimeter now admits any role holding a bit of `permissions.AdminPerimeter` instead of requiring `ADMINISTRATOR`, and each route group re-checks its own bit: channels + channel overrides → `MANAGE_CHANNELS`, audit log → `VIEW_AUDIT_LOG`, settings → `MANAGE_SERVER`, force-logout → `KICK_MEMBERS`; ban/unban (`BAN_MEMBERS`) and role assignment (`MANAGE_ROLES`) are authorized inside `ModerationService`. Stats/users/`GET /me` stay perimeter-level; backups, updates, API tokens, plugins and the log stream are unchanged. `GET /admin/api/me` reports the caller's mask so the admin panel hides tabs and row actions it cannot use, and the desktop member-list context menu gates Kick/Ban/Change Role on the bits from the `ready` role list instead of on the role *name*. `MUTE_MEMBERS` admits to the perimeter but still has no route behind it (see voice moderation below).
- **DONE (2026-07-31)** — Hierarchy checks beyond ban/unban: `ModerationService.ChangeUserRole` requires the actor to strictly outrank the target *and* refuses to assign a role positioned at or above the actor's own, closing the "any admin can promote anyone to Owner" hole. `ModerationService.ForceLogout` enforces the same outranks rule.
- **DONE (2026-07-31)** — Voice moderation on `MUTE_MEMBERS` (the bit is now live): `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move` and `voice_mod_kick`, each requiring the bit plus a strict role-position outrank of the target, rate limited 5/sec and audit-logged. `voice_states` gained `server_muted` / `server_deafened`, which the `voice_state` broadcast now carries; a server mute is also applied to the target's published audio track via the LiveKit RoomService, and the target's own `voice_mute` / `voice_deafen` unmute attempts are refused with `SERVER_MUTED` / `SERVER_DEAFENED`. Move and disconnect run the hub's voice-leave routine for the target and then send them `voice_moved` (client re-joins the destination through the ordinary join path) or `voice_disconnected`. The desktop client's voice-user context menu grows a moderation section gated on the bit, renders a distinct server-muted icon, and disables the widget's mute/deafen buttons with a reason while server muted.
- **DONE (2026-07-31)** — Bulk message delete. `POST /api/v1/channels/{id}/messages/purge` takes `{limit: 1-100, before?}` and soft-deletes the newest matching messages, gated on `READ_MESSAGES|MANAGE_MESSAGES` for that channel (per-channel overrides apply, DMs rejected — a DM has no MANAGE_MESSAGES gate to answer to). Deletion is the same soft delete a single delete performs, so tombstones and `reply_to` targets survive; already-deleted rows are skipped and the select+update run in one writer transaction. One `message_purge` audit entry per call carries the count, and the fan-out is a single new `chat_bulk_deleted {channel_id, ids}` server->client message instead of N `chat_deleted` events. The desktop channel context menu grows a "Purge Messages…" item — gated on the actor's `MANAGE_MESSAGES` bit and hidden on voice channels — opening an inline 1-100 count prompt with a confirm step; the dispatcher marks every id in the broadcast as deleted.

## Phase 3 — mentions done right

The largest single messaging gap: `@word` was regex-highlighted with no
resolution, no notification and no badge, and `read_states.mention_count` was a
dead column. The server is now the authority on what a mention is — the client
highlights and badges from the resolved fields rather than re-parsing content.

- **DONE (2026-07-31)** — Server-side mention resolution and storage. `MessageService.resolveMentions` parses `@token`s out of sanitized content with a word-boundary rule (`mentionTokenRe`) that refuses address-shaped text: `mail@example` and `@@name` never match, and `@bob@example.com` is rejected whole rather than half-matched. Tokens are lowercased, deduplicated, ordered by first appearance and resolved case-insensitively against `users.username` (`UNIQUE COLLATE NOCASE`), with a second spelling that drops trailing `.`/`-` so "@bob." resolves to bob when nobody is literally named "bob.". A token matching no username resolves to nothing and stays plain text. Two caps bound the work one send can cause: at most 60 distinct tokens are looked up (`maxMentionCandidates`) and at most 20 resolve (`maxMentionsPerMessage`). Resolved IDs land in the new `message_mentions` table (migration `022`, PK `(message_id, mentioned_user_id)` plus `idx_message_mentions_user` for the per-user direction), written in the same writer transaction as the message row and rewritten wholesale on edit. Resolution failures are logged and degrade to "no mentions" — a message is never rejected because its mention lookup failed. `mentions` and `mentions_everyone` now ride on the `chat_message` and `chat_edited` broadcasts, on `GET /channels/{id}/messages`, on pinned-message responses and on FTS search results; `mentions` is always present and empty rather than null. `buildChatMessage` took a `chatMessageArgs` struct in the process — the positional list had outgrown a readable call site.
- **DONE (2026-07-31)** — `read_states.mention_count` is live. `applyMentionCounts` raises it on message insert for every mentioned user who can actually read the channel — the role walk applies channel overrides, and DMs skip it entirely since participation is membership, not permissions. The author is always excluded, and users who have blocked the author are dropped (fail-closed: a `ListBlockersOf` error skips the whole increment, because a badge from a blocked user is worse than no badge). Edits deliberately never increment: only the original send can raise a badge, which is the simplest rule that makes double-counting a re-added mention impossible. `channel_focus` resets the count to 0 via the `UpdateReadState` upsert, and the `ready` payload ships `mention_count` per channel. Because `GetChannelUnreadCounts` covers `text`/`announcement` channels, a DM mention badge is raised live by the dispatcher but starts at 0 on reconnect — DM unreads are surfaced separately in the DM sidebar.
- **DONE (2026-07-31)** — Client rendering, badges and notifications. `@lib/mentions` is the single source of truth shared by the renderer, the badge path and the notification gate, so all three agree on what counts as a mention; its regex mirrors the server's, and the server's `mentions`/`mentions_everyone` decide the outcome whenever present (the local token parse only stands in for servers predating the fields). Resolved mentions render as a highlighted `.mention` span, with `.mention-self` when the mention is the current user; an unresolvable token renders as plain text. In the channel sidebar a red `.mention-badge` outranks the plain unread badge — only one shows, and it counts mentions rather than messages. Desktop notifications retitle to "{user} mentioned you in #{channel}", and "Suppress @everyone" now means exactly that: it drops only a notification the `@everyone`/`@here` alone caused, so a message that also names you still notifies, and an `@everyone` the sender lacked the bit for was never a mention to suppress. No OS dock/taskbar count badge was added — the existing taskbar *flash* is the only OS-level signal; a real badge count needs a Tauri-side API and is left for a later pass.
- **DONE (2026-07-31)** — `@everyone`/`@here` behind a permission, plus composer autocomplete. New `MENTION_EVERYONE` bit (21, `0x200000`); migration `022` grants it to the seeded Owner/Admin/Moderator roles, moving the Moderator mask from `0x000FFFFF` to `0x002FFFFF`. Without the bit the token carries no mention semantics at all — no highlight, no badge, no notification — and DM channels have no `@everyone` semantics since there is no permission surface to answer to. `@here` narrows the fan-out to readers whose status is not `offline`; `@everyone` reaches every reader. The composer opens an inline member picker on `@` (`MentionAutocomplete`, max 10 rows) whose active-token rule mirrors the server's, so it never offers a completion for text a send would not resolve; `@everyone`/`@here` appear as rows only for users who hold the bit.
- **DONE (2026-07-31)** — Clickable `#channel` links. `#name` tokens in message content resolve case-insensitively against the channel store (DM channels excluded — they have no user-visible `#name`) and render as links; unresolvable tokens stay plain text. Navigation funnels through the new `@lib/channel-navigation.navigateToChannel`, now the single entry point shared by the sidebar item and `#channel` links, so every affordance clears the same unread and mention badges. Role mentions remain out of scope by design — they need role management, which is phase 5.

## Phase 4 — markdown and message polish

- Formatting: bold/italic/underline/strikethrough, spoilers, block quotes, headings, lists, masked links, code-fence language tags + highlighting.
- Clickable reply previews (jump to message) + "fetch around message id" endpoint so search/pin jumps work outside the loaded window.
- Message permalinks (Copy Message Link + deep-link route).
- Who-reacted list (expose reactor IDs, hover tooltip).
- Inline video/audio players for attachments.
- New-messages divider, explicit mark-as-read, DM unread counts.

## Phase 5 — roles & channels management

- Role CRUD (create/edit/delete/reorder, permission editor, color picker, hoist, mentionable). Single biggest structural hole.
- Categories as real entities (own permissions, ordering).
- Per-user channel overrides; full permission-matrix override UI (API already accepts arbitrary masks — the admin panel writes one fixed mask).
- Surface channel management (topics, slowmode, overrides, audit log) in the desktop client instead of only the `/admin` panel.
- NSFW flag; voice channel user/video-limit UI (`voice_max_users`/`voice_max_video` are enforced but unconfigurable).

## Phase 6 — social & profiles

- Custom emoji end-to-end (schema + client picker support exist; server routes were never registered).
- Avatar upload + rendering (today: https-URL-only API, letter-initial rendering).
- About-me/bio (client already renders an `about` field that is hardcoded null), display names.
- Custom status text/emoji; real invisible (today "offline" relabeled, flashes online on reconnect); auto-idle.
- Group DMs (schema supports N participants; no create path/UI). DM calls (server access checks pass; no call button/ringing).
- Friends list (nav item exists, callback never wired) — or remove the dead nav item.
- Per-channel/per-DM notification mute.

## Absent wholesale (not planned here)

Threads, forum/stage channels, webhooks, bot accounts, stickers, polls,
message forwarding, TTS, soundboard (dead `sounds` table), priority speaker,
streamer mode, video backgrounds, multi-guild, email/account recovery,
slash commands (separate plan: `slash-commands.md`).

## Known dead code to reconcile as phases land

- `emoji`/`sounds` tables (phase 6), `voice_speakers` reserved WS type,
  `voice_config.bitrate` (sent, never applied client-side), client
  `getEmoji`/`deleteEmoji`/`getSounds`/`deleteSound` calling unregistered
  routes, "Friends" nav item, PTT stub on macOS.
  (`read_states.mention_count` came off this list in phase 3 — it is now
  written, shipped in `ready` and cleared by `channel_focus`.)
