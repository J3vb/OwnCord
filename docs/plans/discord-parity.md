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

- Real kick semantics or remove the fake "Kick" (today it's a force-logout via session revocation; the user can log straight back in).
- Enforce the six decorative permission bits: `MANAGE_CHANNELS`, `KICK_MEMBERS`, `MUTE_MEMBERS`, `MANAGE_ROLES`, `MANAGE_SERVER`, `VIEW_AUDIT_LOG` currently all collapse to an `ADMINISTRATOR` check, so Moderators can't moderate.
- Voice moderation: server mute/deafen, move member, disconnect member (no message types exist today; `MuteMembers` bit is dead).
- Hierarchy checks beyond ban/unban (an Admin can currently promote anyone to Owner).
- Bulk message delete.

## Phase 3 — mentions done right

The largest single messaging gap. `@word` is regex-highlighted with no
resolution, no notification, no badge; `read_states.mention_count` is a dead
column.

- Server-side mention parsing to user IDs at send time; store per-message mentions.
- Write `mention_count` on message insert, clear on `channel_focus`.
- Red mention badges on channels + app badge; mention-aware desktop notifications.
- `@everyone`/`@here` real semantics behind a permission; composer autocomplete.
- Clickable `#channel` links; role mentions once role management exists.

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

- `read_states.mention_count` (phase 3), `emoji`/`sounds` tables (phase 6),
  `voice_speakers` reserved WS type, `voice_config.bitrate` (sent, never
  applied client-side), client `getEmoji`/`deleteEmoji`/`getSounds`/
  `deleteSound` calling unregistered routes, "Friends" nav item, PTT stub on
  macOS.
