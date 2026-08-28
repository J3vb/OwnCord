# Changelog

All notable changes to OwnCord are listed here. The repository's release
tooling (`npm run changelog`) auto-generates entries from commit messages
on each release; this file is the curated counterpart that calls out
behavioural changes operators must know about.

## How to write an entry

**Scannable lists, never walls of text.** A reader should be able to find what
affects them in about ten seconds, without reading a paragraph they do not care
about. Entries below `v1.2.0-alpha.3` do not follow this and are left as
shipped history; everything from the next release forward does.

The rules:

1. **Open with what is user-visible and what is not.** Most releases carry a
   mixture. Say which is which up front, so nobody reads twenty lines of
   repository plumbing looking for a fix.
2. **Group by the area a user recognises** — Login & connection, Voice,
   Mentions, Messages & files, Accounts & admin, Desktop UI. Not by subsystem,
   package, or which PR it came from.
3. **One line per fix.** If it needs two lines, it needs two entries or it does
   not belong here.
4. **Say what was broken, then what it does now.** "Banned users could still
   connect — ban is re-checked on connect." A reader must be able to tell
   whether it bit them, without opening the PR.
5. **Plain language.** Name the thing a user sees, not the function that owned
   the bug. `voiceJoinLeaveCurrent` means nothing to an operator; "moderator
   mute survives a channel move" does.
6. **No `OC-*` ids, no file paths, no PR-body prose.** The ledger and the pull
   request already carry those, and this file is the one place that does not
   need them. A PR number is fine where it genuinely helps someone dig.
7. **Counts belong in a summary line, not per item.** "62 fixes" once at the
   top beats a number attached to every bullet.

Anything a user cannot observe — repository layout, CI gates, generated-code
ownership, dependency automation — gets **at most a short block at the end**,
and only when it changes something a contributor or fork holder must do
(a moved directory, a renamed module, a new required command).

## v1.2.0-alpha.4

**62 bug fixes**, all user-visible, plus repository work that changes nothing an
operator can see. Fixes first; the repository half is the short block at the end.

### Login & connection

- Connecting with a failed role lookup silently made you a plain **member** — it
  now fails closed instead of guessing.
- **Banned users could still connect.** Ban status is re-checked on connect.
- Reconnecting left a **phantom voice E2EE key holder** and a stale voice-channel
  marker behind.
- Typing indicators in DMs could **disconnect you** under load.

### Voice

- Moderator mute and deafen are **preserved across a channel move** — they were
  silently dropped.
- Voice E2EE keys **re-sync on reconnect**, and a departed peer's key is always
  retired so a replayed announce cannot overwrite a fresh one.
- A kicked client no longer receives frames.
- A rolled-back join now reaches everyone present, including people without
  permission to read the channel.
- A **failed microphone unmute now shows as failed** instead of quietly
  reporting you as unmuted.
- Noise suppression rebuilds correctly after a microphone restart.

### Mentions

- **`@here` no longer behaves like `@everyone`** — the two are distinguished.
- Mention badges are reversed on delete, purge and account deletion, and can no
  longer be reversed twice.

### Messages & files

- Deleting a message now **actually deletes its attachment files**.
- A failed avatar upload no longer deletes a committed file's reference.

### Accounts & admin

- The `require_2fa` enrollment gate misfired after a temporary ban lapsed, and
  applied its precondition to unrelated settings.
- A DM partner with no live connection now shows **offline everywhere** — it was
  inconsistent between views.
- Plugin installation rolls back properly when it fails.
- The diagnostics endpoint honours trusted proxies.

### Desktop app

- Fixed event-listener leaks in the message list, member list, emoji picker,
  quick switcher, sidebar popovers and drag-reorder.
- Recent emoji, channel mutes and custom status are now **per-server** instead of
  bleeding between servers.
- The DM sidebar filter survives updates, the call button cannot redial, the
  incoming-call banner uses nicknames, and Ctrl+I unwraps correctly on bold text.

### Repository — no runtime effect

Phases B0 and B1 of the
[repository-health roadmap](docs/plans/repo-health-roadmap-2026-08-23.md).
Desktop behaviour, release asset names and the update contract are unchanged by
design. Three items affect anyone holding a working copy or a fork:

- **`Client/tauri-client/` is now `Client/`** (#1411). Rebase an in-flight
  branch rather than merging across the move.
- **The Go module is now `github.com/J3vb/OwnCord/Server`** (#1417), was
  `github.com/owncord/server`.
- **The protocol schema is now `protocol/schema.json`** (#1417), was
  `docs/protocol-schema.json`.

One command runs what CI gates on, Windows and Linux, no `make` needed:
`npm run bootstrap`, then `npm run check`. Go-only contributors still do not
need Node.

## v1.2.0-alpha.3

- **fix:** eight bug-hunt batches closed **199 verified defects** since
  `v1.2.0-alpha.2` — 30 in #1366/#1367, 110 in #1369–#1372, 34 in #1374 and
  25 in #1375 — each fixed test-first with the failing assertion watched red
  against the unpatched code. The behavioural consequences worth knowing
  about are listed below; the rest are one-line correctness fixes with no
  operator-visible change.
- **security(client): voice E2EE was never actually enabled** (#1370). The
  full ECDH/HKDF/AES-GCM key exchange completed, the room key was set, and
  the UI showed 🔒 Secured — but `createRoom` never called
  `room.setE2EEEnabled(true)`, so every audio and video frame reached the
  SFU in plaintext. It is enabled now, and a dead E2EE worker is no longer
  invisible to the Secured badge. Related voice-crypto fixes: a joining key
  holder sent its room-key offers _before_ its own announce, so existing
  participants dropped them as "unknown peer" (#1370, #1374); rotation
  offers exceeded the server rate limit in large channels and permanently
  starved the same peers; both rotation paths and the reconnect-to-Secured
  path now carry session-generation guards; a departing peer's ephemeral
  key is retired on leave so a replayed pre-leave announce cannot overwrite
  the fresh key they rejoined with (#1372, #1374). The client also refreshed
  its LiveKit token every 23 hours while the server mints it with a 5-minute
  TTL, so auto-reconnect failed for any voice session older than five
  minutes (#1370).
- **security(server):** access-control holes (#1369–#1372, #1374, #1375) —
  `voice_join` into a 1:1 DM had no block gate, so a blocked user could
  enter the blocker's DM voice room; the attachment-serve admin bypass let
  an ADMINISTRATOR download files from private DMs they were not in; the
  archived-channel read-only gate covered `SendMessage` only, so edit,
  reaction, pin, purge, delete and `channel_focus` still mutated or
  subscribed to archived channels (every write sink now routes through one
  `requireChannelWritable` gate); `EditMessage` and `handleReaction` DM
  detection failed _open_ on a `GetChannel` error, skipping the block gate;
  group-DM creation only block-checked the creator, letting a third party
  force two users who blocked each other into a shared room; an invisible
  user's real custom status leaked on both presence emitters; `PATCH
/users/{id}` with `banned` + `role_id` committed and broadcast the ban
  before authorizing the role change; admin API-token creation accepted a
  negative `expires_hours` and minted a token that never expires; upload
  rejections echoed raw storage errors (absolute server paths) to any
  authenticated user; the GIF proxy's log redaction missed the
  percent-encoded API key; `chat_command` was the only client message type
  without a rate limiter while each frame ran a WASM plugin invocation; and
  the login and typing rate limiters built their keys from _unvalidated_
  input, letting an unauthenticated caller pin unbounded heap for six hours.
- **fix(auth):** accounts whose username contains `'`, `"` or `&` were
  permanently unloggable — registration HTML-escaped the name but login did
  not — and a profile rename to such a name locked the user out (#1370). If
  you had users hit this, they can log in again with no action on your side.
  Also: message search returned 500 for any query containing a hyphen (the
  one FTS5 operator the sanitizer allowlisted); usernames with an uppercase
  non-ASCII letter could never be @mentioned; registration recorded the
  reverse-proxy address as the session IP.
- **server:** WS hub, reconnect and replay (#1369, #1371, #1372, #1374,
  #1375) — REST DM events never bumped the visibility watermark, while
  _every_ ordinary DM message re-emitted `dm_channel_open` and bumped the
  global watermark, forcing every other client's next reconnect into a full
  resync; the client's `lastSeq` was never reset by a full-ready resync and
  desynced permanently; cold-tier replay had no interior-gap detection, so
  events the persister dropped were skipped and presented as a complete
  resume; `buildReady` swallowed three DB errors and shipped an
  authoritative-looking empty snapshot (the client wiped its DM list, member
  list and unread badges) and dropped the user's own live voice room when
  not READ-visible; `channel_focus` could re-subscribe after a concurrent
  visibility revoke, and role demotion's live-subscription revocation was
  gated on a cosmetic role re-read; a failed reconnect handshake ran the
  full disconnect teardown twice; presence events from every source now
  share one ordered per-client FIFO.
- **server:** voice lifecycle (#1369, #1371, #1374) — a stale join's
  rollback deleted `voice_states` by user id alone, destroying a concurrent
  newer membership; deleting a voice channel raced a concurrent `voice_join`
  into a permanent hub/SFU ghost no sweep could heal; the stale-state sweep
  could delete a just-committed join's row, leaving the client in voice with
  no DB row; `handleVoiceJoin` handed out a live 5-minute LiveKit credential
  _after_ a concurrent kick/move/revocation had already torn the membership
  down (the token is now withheld); the `participant_left` webhook never
  told the leaver, and a transient DB read error on `participant_joined`
  ejected a legitimate participant mid-call; `voice_mod_move` lacked the
  archived-channel gate; `CleanupVoiceForChannel` resolved an empty
  `voice_leave` audience because both callers archive first. Camera and
  screenshare now draw from the same per-channel `voice_max_video` budget —
  screenshare had no cap check at all, and the camera gate did not count
  screensharing occupants.
- **server:** DM and message fan-out (#1369, #1371, #1372, #1375) — a DM
  send, edit, delete or reaction survived a transient participant lookup
  failure by silently dropping live fan-out to everyone including the
  sender; emoji create/delete and group-DM creation tied their broadcasts to
  the request context, so an aborted request committed the mutation and
  skipped the event; slow mode consumed its cooldown token before content
  validation, so a rejected send locked the composer for the full window; an
  attachment-metadata read failure broadcast the message with no
  attachments; `GET /channels/{id}/pins` had no LIMIT and failed permanently
  past ~32k pins; pinning a soft-deleted message returned 500;
  `LinkAttachmentsToMessage` no longer claims a user's live avatar as a
  message attachment; `PATCH /channels/{id}` now rejects a blank name.
- **server:** admin and plugins (#1369, #1370, #1372, #1375) — "Restore
  backup" wrote to a hardcoded `data/chatserver.db`, so it silently no-oped
  on any server with a configured `database.path`; the WAF inline engine
  rejected every request body ≥ 1 MiB, breaking plugin install and large
  avatar uploads when `waf_enabled` was on; self-account-deletion emitted no
  `member_ban`, so every other client kept the deleted user; the admin live
  log stream blanked every error attribute to `{}`; `CheckForUpdate` had no
  in-flight dedupe and stampeded GitHub on cache expiry; a failed self-update
  swap left every client counting down to a restart that never came (a
  corrective `update_aborted` is now broadcast, and deferred cleanup runs
  before the restart exits — on Windows that file-handle release is the
  reason the restart exists). Plugin enable/re-install left
  `plugins.enabled = 1` while the runtime instance was deactivated, and
  uninstall reported success while the on-disk directory survived and
  resurrected the plugin on the next start.
- **fix(client):** voice reliability (#1366, #1367, #1370–#1372, #1374,
  #1375) — a failed voice channel-switch left the user live in the call
  (mic hot, audio flowing) with the voice UI hidden and no way to leave;
  selecting the "Default" microphone (or losing the pinned one to a hot
  unplug) never changed the capture device; a camera or screenshare disable
  that completed while the enable's `publishTrack` was in flight left the
  server and every peer believing it was on (`leaveVoice` and reconnect
  teardown now bump the same generation guard); a `VIDEO_LIMIT` rollback
  assumed the camera and tore down a working camera while leaving refused
  screen tracks published — it now correlates by envelope id; auto-idle's
  return-to-online `presence_update` was always swallowed by the 1-per-10s
  limiter, so every user showed Idle to everyone else after their first idle
  period; connection-quality degradation was never reported; a group-DM
  decline silenced every other participant's ring and never reached the
  caller.
- **fix(client):** messaging and stores (#1366, #1367, #1369, #1372) —
  re-opening a channel visited earlier in the session rendered a permanently
  stale window (live broadcasts only cover the focused channel; the tail is
  now refetched); the virtual scroll window never followed the scroll
  position, so rows past the initial overscan rendered as blank space; a
  scroll-up page past the 500-row cap deleted the user's pending/failed
  rows, the only copy of their composed text; the scroll-to-bottom button
  and "Jump to Present" pill scrolled out of view exactly when they became
  visible; a user named exactly "System" had every message rendered as a
  server notice with no moderation controls; DM permalinks failed until the
  DM had been opened once; the reaction picker dropped the server's custom
  emoji; Ctrl+K was dead with CapsLock on; the composer's slow-mode cooldown
  was applied to whichever channel was mounted, not the one that sent.
- **fix(client):** settings, session and platform (#1367, #1370–#1372,
  #1375) — the built-in light theme overrode only 4 of ~45 tokens (composer
  and inputs near-invisible), the Font Size slider and High Contrast toggle
  were no-ops, and the tray Status menu bypassed the client's own status
  state so a tray-set Do Not Disturb silenced nothing; a failed TOTP verify
  tore down the overlay so the code could not be re-entered; channel
  create/edit/delete modals locked up permanently on an API failure; login
  to an IPv6-literal host was impossible; a host stored with an explicit
  `:443` lost its bearer token and cert-pinned proxy on attachment fetches;
  one malformed stored server profile discarded _all_ saved profiles; a
  banned/revoked token reconnected forever if the session ended before
  MainPage mounted; a previous server's block list, collapsed categories and
  DM notes bled into the next server; the Rust HTTP proxy tunnel's data
  phase had no deadline, so a remote that completed TLS then went silent
  parked the connection forever (bounded at 600s — loose on purpose, this
  path carries uploads); the autostart toggle raced its own write.
- **infra:** observability, backups, guardrails and deployment hardening
  (#1376). **`/health` now returns a real verdict** — hub dispatch-loop
  liveness, a bounded DB ping and a free-disk check, answering **503 with a
  subsystem reason** (`hub`, `database`, `disk`) when degraded; results are
  cached so the unauthenticated endpoint cannot amplify load. Point uptime
  monitors at it and treat any 503 as actionable. **The hub's panic breaker
  now exits the process** so a supervisor can restart it, instead of leaving
  broadcast delivery silently dead while clients still appear online — if
  you run the bare binary without a supervisor, use the new hardened
  `deploy/owncord.service` systemd unit (see "Running as a Linux Service").
  **Backups now actually run:** `backup_schedule` and `backup_retention`
  had existed in the admin panel since the initial schema but were never
  read by any code; the 15-minute maintenance loop now enforces them,
  verifies each backup with `PRAGMA integrity_check` (and again before a
  restore may overwrite the live DB), and prunes by age keeping the newest.
  Expect backup files to start appearing and pruning for the first time.
  `/api/v1/metrics` gains reconnect-tier, backpressure, DB-writer-wait,
  permission-cache, `ws_conn_rejects` and `disk_free_mb` signals, and the
  declared-but-never-recorded OTel instruments are wired. Upload storage
  failures return **507** instead of blaming the client with a 400. A
  single-process lock beside the SQLite file makes a second server process
  fail fast instead of silently fighting the first. **Unknown config keys
  now warn at startup** (a typo previously kept the default silently), and
  startup warns when `admin_allowed_cidrs` is customized while
  `trusted_proxies` is empty. Shutdown now joins the pruner and maintenance
  loop before the DB closes, drains HTTP handlers into a live hub, and skips
  the 5s client-notice window when nobody is connected. Write-path work:
  no-op read-state UPSERTs are skipped, boot-time `ANALYZE` runs only when a
  migration applied, role-scoped override changes evict only that role's
  members from the permission cache, and connect/disconnect presence passes
  through a 300ms latest-wins coalescer (wire format and seq ordering
  unchanged).
- **config:** new keys, all defaulting to current behaviour (#1376) —
  `server.max_ws_connections` (0 = unlimited; over the cap answers 503 +
  Retry-After), `server.metrics_allowed_cidrs` and
  `server.livekit_webhook_allowed_cidrs` (both fall back to
  `admin_allowed_cidrs`, so a central Prometheus scraper or an
  externally-hosted LiveKit no longer requires widening the admin
  perimeter), `database.max_readers` (0 = auto), `backup.dir`
  (`data/backups`), `security.auth_rate_limit_multiplier` (1.0; raise for
  shared-NAT communities), `event_persistence.replay_ring_size` (1000) and
  `event_persistence.replay_cold_limit` (5000 — watch `reconnect_tier_full`
  before raising). Three stored-but-inert admin settings (`server_icon`,
  `max_upload_bytes`, `voice_quality`) are now shown read-only with a
  pointer at the real `config.yaml` keys instead of pretending to apply.
  Documented in `docs/server-configuration.md`.
- **deploy:** new `chatserver healthcheck` subcommand probes `/health`
  pinning the server's own certificate from disk (WebPKI when none exists,
  i.e. ACME) and is now the docker-compose healthcheck — the distroless
  image has no shell; plain `docker compose` only _surfaces_ unhealthy, pair
  it with a watchdog for auto-restart. Compose gains json-file log rotation
  (`10m` × 3) on both services. `release.yml` now cold-boots the freshly
  built server binaries and Docker image and probes them healthy **before
  anything is signed or pushed** — the release feed drives signed
  self-updates, so a binary that compiled but died on boot would previously
  have shipped itself to every auto-updating instance. New "Reverse Proxy
  Topology" docs section (nginx snippet; only WebRTC media ports need to be
  directly reachable, `/livekit/*` is already proxied). Release binaries
  are built with Go 1.26.6 (stdlib CVE fixes flagged by govulncheck).
- **migrations:** **031** normalizes legacy `sessions.expires_at` values to
  RFC3339-UTC and adds `idx_sessions_expires_at`, so the 15-minute expired-
  session sweep is an index lookup instead of a full-table scan on the
  writer. Applies automatically on first start; no operator action needed.
- **protocol:** no wire changes — `docs/protocol-schema.json`,
  `message_types.go` and `protocolTypes.ts` are byte-identical to
  `v1.2.0-alpha.2`. Older clients and servers interoperate unchanged.
- **fix(ws):** the LiveKit health check shared the process-wide
  `http.DefaultTransport` pool with every other user in the server; it now
  owns a private transport (#1356).
- **chore:** bug-hunt tooling under `.claude/` (fix pipeline, findings
  ledger, circuit breaker, single-finder hunt with graph-fed targeting —
  #1361–#1365, #1373); dependency bumps (OTel 1.45.0, koanf, sqlite,
  eslint/oxlint/knip/typescript-eslint, tauri-plugin-updater, GitHub
  Actions; #1353–#1360). No runtime impact.

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
  change to scope the identity keypair by host _and_ user id would have
  re-minted a fresh key on every existing install, firing the TOFU "verify
  out-of-band" re-pin warning at the entire alpha population simultaneously,
  exactly the pattern that teaches users to click through the one warning
  meant to matter. The legacy host-only key is now adopted into the scoped
  name instead, saving before deleting so a partial failure cannot strand a
  user with neither key. Switching hosts carried the previous server's
  bearer token forward into the next login request; `api.setConfig` now
  drops it when the host changes without a replacement. A hand-copied,
  un-lowercased host normalizer in `main.ts` meant an uppercase hostname's
  cert-mismatch _reject_ path skipped `disconnect()`/`clearAuth()`, leaving
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
  Behavioural note: deleting a channel override for a _nonexistent_ role now
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
  `keyring = "3"` dependency compiled its in-memory _mock_ store on
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
