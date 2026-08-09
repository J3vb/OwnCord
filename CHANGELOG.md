# Changelog

All notable changes to OwnCord are listed here. The repository's release
tooling (`npm run changelog`) auto-generates entries from commit messages
on each release; this file is the curated counterpart that calls out
behavioural changes operators must know about.

## v1.2.0-alpha.2

- **feat(client):** the login form has an **Auto connect** checkbox under
  Remember password. Ticking it makes that server connect automatically on
  launch — the same setting as the auto-login button on a server card, so
  the two stay in sync, and as before only one server can be auto-connect
  at a time.
  Ticking it also forces Remember password on and locks it: auto-connect
  replays the stored token, which is only written when the password is
  remembered, so the two cannot be set independently without producing a
  setting that silently does nothing.
- **fix(client):** Remember password works again. The password was saved to
  the OS keyring but never returned to the client over IPC, so the login
  form could not prefill it — the box appeared to work and did nothing.
- **fix:** three bug-hunt sweeps closed **233 verified defects** since
  `v1.2.0-alpha.1` — 26 in #1328, 107 in #1331, 100 in #1332 — each fixed
  test-first, with the failing assertion watched red against the unpatched
  code before the patch landed. The behavioural consequences worth knowing
  about are listed in the nine entries below.
- **server:** WS hub reconnect and replay hardening (#1328, #1331).
  Cold-tier replay used to truncate silently instead of forcing a full
  ready, and a retention-pruned event log was accepted outright as a
  complete resume — the highest-impact fix in #1331, since any client whose
  reconnect gap crossed the 24h retention default was permanently desynced.
  Resume also silently dropped the focused channel's topic subscription,
  stopping message delivery until the user manually switched channels; it
  is now restored during the handshake. `visibilityChangeSeq` can now only
  move forward across its three writers — it previously could regress and
  skip a required resync.
- **server:** voice/E2EE key-holder election and audience gating (#1328,
  #1331) — three key-holder desync bugs (no client demotion path, peer keys
  cleared on reconnect, missing re-election on the webhook and
  fresh-reconnect paths), plus re-election wired into the sweep and
  channel-cleanup paths. Voice events were READ-filtered while membership
  is CONNECT-only, so participants in that gap silently missed
  `voice_leave`, stalling key-holder election and forward-secrecy rotation.
  Deleting a channel now evicts its voice participants first — the cleanup
  function existed but had zero production callers, so the FK cascade used
  to strand them silently. Moderator mute/deafen now survives a
  voice-channel switch; joins to non-voice channels are rejected; archived
  channels are read-only and unjoinable.
- **security(server):** roles/permissions (#1328, #1331) — `UpdateRole`
  allowed position collisions that `CreateRole` already rejected, so tied
  positions could read as equal rank in every hierarchy comparison; it now
  matches `CreateRole`'s validation. `can_send` is now recomputed per client
  on every role/override change, so a permission change takes effect for
  connected clients immediately rather than waiting on a reconnect.
- **server:** attachments and admin data-safety (#1331) — migration **030**
  unlinks attachments on message delete instead of cascading, so a cascaded
  channel/DM delete no longer strands uploaded files on disk with no
  reclamation path. The 15-minute orphan-attachment sweep was deleting every
  avatar in the instance (avatars are, by design, attachments with no
  message link) on its first tick past the grace period, permanently 404ing
  every profile picture; a second bug in the same sweep collapsed the
  one-hour grace period to effectively zero, from a TEXT-comparison mismatch
  between an RFC3339 cutoff and SQLite's own timestamp format. A failed
  backup restore used to truncate the live database to zero bytes with no
  rollback, while the server kept answering requests against the now-closed
  DB and falsely claimed a restart was underway — it now restores the
  pre-restore safety copy on failure and requests the restart honestly.
  Also fixed: personal data is cleared on account deletion, banned users are
  excluded from owner lookup, the silent 1000-member roster cap is gone, and
  a sender's own read state now advances on send. Migration applies
  automatically on first start; no operator action needed.
- **protocol:** a new READ-gated `active_channel_id` auth field (#1331)
  restores the focused-channel subscription during the reconnect handshake
  itself, closing the window before the post-`auth_ok` `channel_focus` round
  trip lands. `protocol.md` also corrects the presence table, which had
  incorrectly documented all presence events as sequenced. Older
  clients/servers are unaffected — it is a new, ignorable field.
- **security(client):** identity/TOFU and transport (#1332) — an in-flight
  change to scope the identity keypair by host *and* user id would have
  re-minted a fresh key on every existing install, firing the TOFU "verify
  out-of-band" re-pin warning at the entire alpha population simultaneously,
  exactly the pattern that teaches users to click through the one warning
  meant to matter. The legacy host-only key is now adopted into the scoped
  name instead, saving before deleting so a partial failure cannot strand a
  user with neither key. Switching hosts carried the previous server's
  bearer token forward into the next login request; `api.setConfig` now
  drops it when the host changes without a replacement. A hand-copied,
  un-lowercased host normalizer in `main.ts` meant an uppercase hostname's
  cert-mismatch *reject* path skipped `disconnect()`/`clearAuth()`, leaving
  a user who refused a changed certificate still connected to that server —
  the single lowercased implementation in `ws.ts` is now shared everywhere.
- **fix(client):** voice mic/camera reliability (#1331, #1332) — six
  separate paths could republish the microphone without checking the user's
  mute state (the audio-device fallback, selecting "Default" input,
  un-deafening, `retryMicPermission`, a stale PTT ownership latch, and
  auto-reconnect's `restoreLocalVoiceState`), each producing a hot mic while
  every remote UI still showed the user muted; all now route through
  `isMicPolicyGated()`. Camera and screenshare kept publishing to the SFU
  after the user turned them off during the OS device picker. Enhanced Noise
  Suppression silently disabled the input-volume slider and VAD gate because
  `livekit-client`'s own `replaceTrack` call landed after ours. A key-holder
  promotion arriving mid voice-setup was clobbered, ejecting the joiner
  after a timeout only it could have resolved.
- **fix(client):** messaging and store reliability (#1328, #1331, #1332) —
  sequenced DMs could jump the FIFO ahead of `sendHigh`, permanently losing
  an event dropped before flush. A full-ready resync left every loaded
  channel with a permanent hole in its history, because that tier never
  replays `chat_message` frames; loaded windows are now invalidated and the
  active channel refetched. The WS error handler only bannered
  `RATE_LIMITED` and `FORBIDDEN`, so every other server error code — for
  example a rejected `chat_edit` — was dropped in silence while the
  optimistic "Message edited" toast still fired. A message whose
  `chat_send_ok` was lost to the same disconnect that forced a resync could
  render twice; the optimistic row's id-based dedup now shares the
  content-based match predicate `addMessage` already used. Replay detection
  compared the server's `created_at` against the client's own clock, so a
  self-hosted server without NTP made every live message after a reconnect
  look like a replay and silently killed its notification; both sides now
  use an estimated server-time skew.
- **fix(client):** UI defects (#1331, #1332) — the quick-switcher could
  mount a second overlay, orphaning a body-mounted backdrop that blocked all
  input until reload. The status-picker stylesheet targeted a root element
  the component never toggles; a same-branch repair then left the status dot
  itself 0×0 and unclickable, now fixed together with a test pinning the
  stylesheet to the classes the component actually emits. The attachment
  remove button and the failed-send Retry/Discard buttons did nothing;
  drag-reorder's phantom-drag latch and permission gate are fixed; keyboard
  Tab could escape every modal because hidden (`display: none`) controls
  were still counted as focusable.
- **fix(client):** the user profile popup is styled correctly again
  (`a308f81`).
- **fix(client):** Vite no longer watches `src-tauri/`, so a running dev
  server does not rebuild the frontend when Rust sources or build artifacts
  change (`cdcfc03`).
- **fix(release):** the stripped Linux AppImage is signed from the
  environment-provided key instead of a temporary key file (`9d75890`) —
  release-pipeline only, no operator action needed.
- **docs:** full documentation audit against `5630aa1` — reference docs,
  architecture pages, and UX specs corrected; plans and prior audits given
  verified statuses; see `docs/audit-2026-08-04-docs-and-coverage.md`.
- **security(server):** closed the three 2026-08-04 review findings — the
  channel role-override **DELETE** now enforces the same hierarchy guard as
  PUT (A-2026-08-01); the admin channel list/edit/delete surface no longer
  sees DM channels, answering 404 for their ids (A-2026-08-02); DM call
  rings respect blocks like every other DM interaction (A-2026-08-03).
  Behavioural note: deleting a channel override for a *nonexistent* role now
  returns 404 (was 204), matching PUT.
- **server:** migration **029** drops the never-used `sounds` table (dead
  since the initial schema; A-2026-07-13). Applies automatically on first
  start; no operator action.
- **protocol:** the plugin command family (`chat_command`, `command_reply`,
  `plugin_broadcast`) is now part of `protocol-schema.json` and the
  generated constants (27 client→server / 39 server→client). Wire strings
  are unchanged — no client or plugin impact.
- **chore(client):** dead modules deleted (`ServerStrip`, `FileUpload`,
  `reconcile`, a stray worklet copy, orphan sounds API methods) and the
  unused tauri-typegen pipeline retired (`src/generated/**`, its CI steps,
  config block, and build-dependency).
- **ci:** knip is now blocking; Playwright specs are typechecked
  (`typecheck:e2e`); three orphaned native e2e specs run again;
  `claude.yml` actions are SHA-pinned; the PR template asks for docs
  updates per the architecture maintenance rule.
- **tests(client):** the TOFU certificate ceremony has e2e coverage
  (first-use + mismatch journeys), and `modalFactory` is fully covered.
- **security(client):** the voice-E2EE identity pin lookup fails **closed**
  on keyring errors (DC-08): a transient store failure used to read as
  "never pinned", silently sending a pinned peer down the first-sight path
  and re-pinning whatever key the server delivered. An unreadable pin store
  now rejects the peer's announce, writes nothing, and shows a distinct
  amber "could not check" badge until the store recovers.
- **feat(client):** accessibility pass over the modal/overlay stack
  (DC-13): every modal is a labelled `role="dialog"` with a focus trap and
  focus restore, Escape maps to each dialog's safe action, the settings
  sidebar is a keyboard-navigable tablist, the quick switcher and composer
  autocompletes are wired as combobox/listbox, the emoji/GIF pickers are
  keyboard-operable, and toasts/typing announce via polite live regions.
- **feat(client):** UX polish (DC-12): deleting the active channel now
  says so in a toast; reactions toggle optimistically with rollback on
  failure; the role-change menu can no longer double-fire; a document-level
  listener leak in channel drag-reorder is fixed.
- **feat(admin):** restoring a backup now writes a `backup_restore`
  audit-log row (DC-09). The row is written before the pre-restore safety
  copy, so it lives inside the `pre_restore_*.db` backup — the restored
  database itself cannot carry it (the restore replaces the file).
- **ci:** the `-tags wazero` / `-tags otel` Go tests now actually run in CI
  (DC-06) — previously those variants were only compiled, leaving ~600
  lines of plugin/telemetry tests permanently dark.
- **tests(client):** e2e journeys for voice-E2EE identity verification
  (badge states + mismatch modal, driven through the real crypto path) and
  the updater (banner → progress → auto-relaunch), plus an accessibility
  smoke; full web suite now 291 tests.

- **server/admin:** in-place self-update is refused in container
  deployments (503 `CONTAINER_DEPLOYMENT`; the shipped image sets
  `OWNCORD_CONTAINER=1`, bind-mount operators can set `0` to opt back in).
  Container upgrades are image pulls; `GET /admin/api/updates` now reports
  `can_apply` and the admin panel says so instead of offering the button.
- **ci:** the full client e2e suite now blocks merges (DC-07); a new
  non-blocking `admin-e2e` job drives the admin panel against a real server
  (first-run wizard, channel CRUD, audit log, re-login).
- **docs:** the dependency pinning/review policy is written down in
  `docs/contributing.md`, closing the last 2026-04 audit carryover that was
  still undecided.

## v1.2.0-alpha.1 — Discord feature parity

> **Project reset note:** OwnCord has re-entered alpha. The `v1.0.0` release is
> superseded; versioning continues forward from `v1.1.0-alpha.N` so deployed
> servers and clients keep receiving updates. This release bumps the minor to
> `v1.2.0-alpha.1` to mark a large feature drop. Releases are published to this
> repository's [Releases](https://github.com/J3vb/OwnCord/releases) page,
> including a full source snapshot with every release.

This release closes most of the feature gap against basic Discord (see
[docs/plans/discord-parity.md](docs/plans/discord-parity.md) for the full
gap analysis and per-item detail). The work landed as six phases plus a
pre-release security and performance review.

### Messaging & mentions

- **Real mentions.** `@username` is now resolved server-side against unique
  usernames (address-shaped text like `mail@example` is rejected), stored per
  message, and carried on the wire — so a mention notifies, highlights the
  message, and drives a red per-channel mention badge distinct from the plain
  unread count. `@everyone` / `@here` are gated on a new `MENTION_EVERYONE`
  permission (`@here` skips offline and invisible users). `#channel` names
  render as clickable navigation chips, and the composer gains an `@`
  autocomplete.
- **Markdown rendering.** Messages render Discord-flavoured markdown — bold,
  italic, underline, strikethrough, spoilers, block quotes, headings, lists,
  masked links (`http(s)` only), and fenced code blocks with a language tag
  and lightweight syntax highlighting. Rendering is a strict DOM builder with
  no `innerHTML`. `Ctrl+B/I/U` wrap the selection in the composer.
- **Custom emoji.** Server emoji can be uploaded and managed (admin panel,
  `MANAGE_SERVER`); `:shortcode:` renders inline in messages (jumbo when a
  message is emoji-only), appears in the picker and a `:`-autocomplete, and can
  be used as a reaction.
- **Message navigation.** Search results, pinned messages, reply previews, and
  message permalinks (`owncord://message/…`, copyable from the hover bar) all
  jump to the target — fetching a window around it when it is not loaded, with
  a "Jump to Present" affordance. Reactions show a who-reacted tooltip on
  hover, video and audio attachments get inline players, and a "NEW" divider
  plus explicit Mark as Read / Mark All as Read round out read state.
- **Bulk delete.** `POST /channels/{id}/messages/purge` soft-deletes the newest
  N messages (`MANAGE_MESSAGES`), broadcasting one `chat_bulk_deleted` event.

### Roles, permissions & moderation

- **Role management.** Roles are now first-class: create, edit, delete, reorder,
  and edit permission masks and colours from the admin panel, all gated on
  `MANAGE_ROLES` and bounded by the actor's own position (you cannot touch a
  role at or above your rank, nor grant a permission bit your own role lacks).
- **The permission bits are live.** The six previously-decorative bits
  (`MANAGE_CHANNELS`, `KICK_MEMBERS`, `MUTE_MEMBERS`, `MANAGE_ROLES`,
  `MANAGE_SERVER`, `VIEW_AUDIT_LOG`) are now enforced per admin route group, so
  a Moderator role can actually moderate without being a full Administrator.
- **Per-user channel overrides.** Channel permissions resolve in Discord's
  order — base role → role override → user override — with a tri-state override
  matrix editor (role or user) in the admin panel.
- **Voice moderation.** Holders of `MUTE_MEMBERS` can server-mute, server-deafen,
  move, or disconnect a lower-ranked user; a server mute is enforced at the SFU.
- **Channel management from the desktop client.** Topics render and are editable,
  plus slowmode, an NSFW flag (with a per-session age gate), and voice
  user/video limits. Categories are now free text (any type under any name).

### Social & profiles

- **Profiles.** Avatar uploads (replacing letter-initials everywhere), display
  names (with the `@username` handle preserved for mentions), an about/bio, and
  a custom status line.
- **Presence.** Invisible is now a real status that never leaks to other users
  and survives a reconnect (the previous flash-online-on-connect bug is fixed);
  a 10-minute auto-idle that never overrides a manual status.
- **Group DMs** (2–10 participants, name, leave), **DM calls** with ringing
  (Call button + incoming-call banner over the existing DM voice path), and
  **per-channel notification mutes** (mentions still notify; other noise is
  silenced).
- **Quick wins from phase 1.** Block/unblock from the member menu, temporary
  bans, server-driven role colours, a mounted profile popup, and archived
  channels that actually hide.

### Security & performance review (pre-release)

- Channel-override endpoints now enforce grantability: a `MANAGE_CHANNELS`
  holder cannot grant itself or a user a permission bit its own role lacks,
  closing a privilege-escalation path.
- DM voice events (`voice_state`/`voice_leave`) are delivered only to the DM's
  participants instead of every user with base `READ_MESSAGES`.
- Voice moderation cannot reach a private DM call the actor is not part of.
- Mention-count bookkeeping is batched (one writer exec per 500 readers instead
  of one per reader) and resolved against a set; the markdown parser's
  bracket matching is amortized-linear; video/audio attachment blobs are
  LRU-capped and revoked, and cleared on logout.

### Test hardening (pre-release)

The hostile-input surface is now covered by Go native fuzzers and
client-side property tests (mention/emoji parsing, FTS query sanitizing,
permission resolution, markdown tokenizing, filename/path sanitizing,
content sanitizing, credential validation, avatar URLs, LiveKit webhook
identities), which found and fixed two real bugs:

- **Zero-dimension images are rejected.** A GIF decoding to height 0, and a
  VP8 keyframe with an all-zero size field, both passed the image size guard
  as "small". `imageDimensions` now rejects non-positive dimensions centrally.
- **Upload filenames stay safe basenames.** `/` survived sanitizing verbatim
  (`filepath.Base("/")` is `"/"`), and over-length names were truncated
  mid-rune into invalid UTF-8. Both are fixed at the sanitizer.

Also added: a full migration-chain and pre-parity (019) upgrade round-trip
test, a protocol-schema/generated-constant drift test, a 200-client hub
load/soak test with `goleak` verification, and a blocking `@parity`
Playwright job covering the new parity features. Separately, a test-quality
audit rewired tests that asserted nothing (or a tautology) to assert their
claimed behaviour — no product code changed and no assertion weakened.

### Phase B — Acceleration

- **Event persistence layer (Step 7).** A new `events` table backs the
  WebSocket reconnect path. When a client's `last_seq` is too old for
  the in-memory ring buffer (~1000 events), the server now falls back to
  a SQLite query before forcing a full re-sync. The hub seeds its
  monotonic sequence counter from `MAX(events.seq)` at startup so row
  seqs and wrapped-payload seqs stay aligned across restarts. Configurable
  via the new `event_persistence` block; **enabled by default** (see
  "Behavioural changes" below).
- **Tiered reconnect telemetry.** `auth_ok` now includes a `replay_source`
  field (`"none" | "buffer" | "db"`) so clients can attribute reconnection
  behaviour. The same tier label is exported as the
  `ws_reconnect_tier_total{tier}` counter.
- **OpenTelemetry skeleton (Step 8).** Public API + no-op default
  provider in `Server/telemetry/`. Chi router middleware mounted
  unconditionally. Service-layer spans on `MessageService.SendMessage`,
  `PermissionService.HasChannelPerm`,
  `ChannelService.ListVisibleChannels`, `DMService.CreateDM`,
  `VoiceService.JoinChannel`, `InviteService.CreateInvite`,
  `ModerationService.BanUser`, `BlockService.BlockUser`,
  `UserService.UpdateProfile`. The real OTel SDK is gated behind
  `-tags otel` and is currently a placeholder; completing it is
  deferred until after the beta reset.
- **Solid.js proof of concept (Step 6).** Two leaf components migrated
  (`Badge`, `ChannelListItem`), Vite + JSX configured, store→signal
  adapter landed. The remaining vanilla components remain in place;
  migration is mechanical and tracked in the local TODO.

### Phase C — Differentiation

- **Plugin runtime skeleton (Step 9).** New `Server/plugin/` package
  with manifest parser, on-disk loader, registry, and host capability
  surfaces (`commands`, `events`, `storage`, `http`, `ui`). Manifest
  format is JSON (`plugin.json`); the design's TOML format is gated
  behind the `-tags wazero` build and tracked locally.
- **Plugin admin REST surface.** Lifecycle endpoints under
  `/api/v1/admin/plugins`: list, enable, disable, uninstall, and the
  new install path that accepts a multipart zip upload, validates it
  zip-slip safe with size + symlink rejection, and atomically installs
  it. Mounted under both `AdminIPRestrict` and the
  `admin.RequireAdminAuth` session/permission middleware.
- **Plugin admin client bridge.** `pluginBridge.ts` mounts plugin UI
  tabs in sandboxed iframes with origin-validated postMessage routing.

### Security

- **SSRF defense for `http` capability.** Plugin outbound HTTP requests
  are now validated through `net/url.Parse`, suffix-matched with a dot
  boundary (so `evil-api.example.com` does not match
  `api.example.com`), and rejected for empty allowlist entries. A custom
  `Transport.DialContext` re-resolves DNS on every dial and refuses any
  resolved address in loopback / RFC1918 / RFC4193 / RFC6598 (CGN) /
  link-local / multicast / unspecified ranges. Closes the DNS-rebinding
  TOCTOU window. Response body is capped at 5 MiB.
- **Plugin manifest hardening.** `Manifest.Name` must match
  `^[a-z0-9][a-z0-9_-]{0,63}$`. Entrypoint and UI tab asset paths are
  rejected if absolute, non-canonical, contain `..`, or contain NUL
  bytes / backslashes.
- **Plugin asset handler.** Defends against symlink escapes (rejected
  at install time via `filepath.Walk` + `Lstat`) and prefix-without-
  separator path traversal (via `filepath.Rel` check after join).
- **Plugin postMessage routing.** The host bridge looks up the trusted
  pluginId via `e.source -> contentWindow` instead of trusting the
  `pluginId` field in the message body. Spoofed messages from any
  non-iframe source are dropped.

### Behavioural changes operators must know about

- **Voice now works out of the box for clients that are not on the server
  machine.** The LiveKit proxy's origin gate rejected two legitimate
  client shapes with `/livekit/rtc/v1` 403s — chat worked, voice didn't:
  the desktop client's fixed webview origins
  (`http(s)://tauri.localhost`, `tauri://localhost`) and any UI served
  from the server's own origin, whose WebSocket handshakes always carry
  that origin even though same-origin fetches omit it. Both are now
  recognized: first-party webview origins are always allowed, and an
  `Origin` whose host equals the request's `Host` is treated as
  same-origin — mirroring the default policy the chat WebSocket already
  applied, with no change to the CSRF posture (a foreign origin still
  needs an explicit `allowed_origins` entry). Rejected origins are now
  logged (`livekit proxy: origin rejected`) so the next such failure is
  diagnosable from the server log.
- **API tokens can use the admin log stream.** `POST
  /admin/api/logs/ticket` required a browser login session, so headless
  clients (the `mcp-introspect` dev tool, bots) could reach every other
  `/admin/api/*` route but not `server_logs`. Tickets are now bound to
  whichever credential authenticated the request; revoking a token cuts
  an in-flight stream, exactly as session revocation always has.
- **The desktop client now actually uses the OS credential store.** The
  `keyring` crate declares no `default` feature, so the previous
  `keyring = "3"` dependency compiled its in-memory *mock* store on
  Windows, macOS and Linux alike: saves reported success and the next
  read in the same process returned nothing, and no credential was ever
  written to Credential Manager / Keychain / Secret Service. The visible
  symptom was the voice-E2EE identity keypair being regenerated, so the
  published identity key stopped matching the key that signed the voice
  announce and peers rejected it as a possible MITM. The platform
  backends are now enabled explicitly and every write is read back
  before it is reported as saved. See
  [docs/credential-storage.md](docs/credential-storage.md).
  - **Linux builds need a new system package, `libdbus-1-dev`**, for the
    Secret Service backend. CI and release workflows install it already.
  - Users on an affected machine are logged in again and re-verified by
    their peers once, then persist normally.
- **`event_persistence.enabled` defaults to `true`.** Every broadcast
  WebSocket event is written to the `events` table, retained for
  24 hours by default, and pruned by a background goroutine every hour.
  This is a new on-disk write path that did not exist before. Disable
  it by adding to `config.yaml`:
  ```yaml
  event_persistence:
    enabled: false
  ```
- **DM events are persisted under the same retention.** Operators with
  GDPR or compliance requirements should review the retention window
  and consider setting `event_persistence.enabled: false` until a
  per-channel-type opt-out lands.
- **Plugin admin endpoints require admin session auth in addition to
  the existing IP restriction.** A previous prerelease shipped with only
  the IP gate; that has been corrected.
- **The parity work adds nine database migrations (`020`–`028`) that apply
  automatically on first boot.** They add the `message_mentions`,
  `channel_user_overrides`, and emoji-supporting tables/columns, per-user
  profile fields (`display_name`, `about`, `custom_status`), channel flags
  (`nsfw`, `is_group`), and the `server_muted`/`server_deafened` voice-state
  columns; a migration also seeds the new `MENTION_EVERYONE` permission bit
  into the Owner/Admin/Moderator roles. No manual step is required, but take a
  backup before upgrading as usual. The release also introduces new WebSocket
  message types (`roles_update`, `emoji_update`, `chat_bulk_deleted`,
  `voice_mod_*`, `voice_moved`, `voice_disconnected`, `mark_read`,
  `call_ring`/`call_incoming`/`call_decline`); older clients ignore unknown
  types, and older servers omit the new fields (the client fails safe).

### Deferred work

The project is under a feature freeze until the beta reset completes.
Explicitly deferred (not abandoned unless noted): real OpenTelemetry SDK
wiring, the Postgres backend (scaffolding removed pending real demand),
and the slash-command dispatcher (`docs/plans/slash-commands.md`). The
Solid.js migration was abandoned and its experiment fully removed
(2026-07-19) in favor of the established vanilla component pattern.
