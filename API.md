# API

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the code wins, then the source documents.

OwnCord exposes two surfaces: a REST API for CRUD and admin operations, and a single WebSocket connection for real-time chat, presence and voice signalling. This file is a map of both. The full generated route table and every request/response shape live in [docs/api.md](docs/api.md) and [docs/protocol.md](docs/protocol.md).

## Base URL and versioning

- REST base URL: `https://{server}:{port}/api/v1`. `v1` is the only REST version, a fixed path segment rather than a header; there is no per-route version negotiation.
- The admin panel and its API live under `/admin` (static files plus `/admin/api/*`), outside the `/api/v1` prefix, and are IP-restricted (`server.admin_allowed_cidrs`, default private networks only).
- The WebSocket protocol has its own, separate version number: the **epoch** (`protocol_epoch` in `protocol/schema.json`). See [Protocol epoch and compatibility](#protocol-epoch-and-compatibility).
- Routes reachable without a bearer token are the shrink-only `publicSurface` list in `Server/api/auth_posture_test.go`: `GET /health` and `/api/v1/health`, `GET /api/v1/info`, `GET /api/v1/server-info`, `POST /api/v1/auth/{login,register,verify-totp,recover}`, `GET /api/v1/client-update/{target}/{current_version}`, `GET /api/v1/ws` (in-band auth), the admin panel's static files (`GET /admin/`, `/admin/*`), `POST /admin/api/setup` and `GET /admin/api/setup/status` (all behind the admin IP gate), and the IP-gated `GET /api/v1/metrics`, `POST /api/v1/livekit/webhook` and `GET /api/v1/livekit/health`, plus the `/livekit/*` proxy (LiveKit JWT).

## Authentication

On REST (`api.AuthMiddleware`) and `/admin/api` (`adminAuthMiddleware`), both credential kinds resolve through `auth.ResolveTokenHash`, sessions first. The WebSocket handshake is **session-only** (`SessionService.ResolveSocketPrincipal`): an API token in the `auth` frame is refused with `auth_error` `invalid token`, so API-token clients cannot open a socket.

| Kind          | How obtained                                                                                                                         | Lifetime                                                                                                                                                                                                                                                  | Sent as                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Session token | `POST /api/v1/auth/login`, `/register`, `/verify-totp` (after a 2FA challenge), `/recover`, or the first-run `POST /admin/api/setup` | Expires 30 days after creation; deleted on logout, sign-out-everywhere (`DELETE /api/v1/users/me/sessions`), admin force-logout and account recovery. A password change or 2FA enable/disable revokes the account's other sessions and keeps the caller's | `Authorization: Bearer {token}` |
| API token     | `server token create` CLI (writes directly to the DB) or `POST /admin/api/tokens` (owner role only)                                  | Long-lived; `expires_at IS NULL` = never expires; revocable, independent of the session table                                                                                                                                                             | `Authorization: Bearer {token}` |

- Tokens are stored as SHA-256 hashes. Authenticated requests refresh the session's `last_used` column at most once per session per 60 s (API tokens are touched asynchronously). A live WebSocket is re-checked against the database every 10 inbound messages and by the hub's 30 s revoked-session sweep.
- API tokens are a separate credential for headless and automation use (e.g. `tools/mcp-introspect`, see [MCP introspection](#mcp-introspection)). They inherit the role of the user they are bound to (the owner by default), which is why an owner-bound token can reach `/admin/api/*`.
- Banned users are rejected with `403 FORBIDDEN` by the REST and `/admin/api` auth middleware. A ban broadcasts `member_ban` and disconnects the user's socket immediately (an `error` frame with code `BANNED`, then close); a banned user's handshake is refused the same way.
- Login can require a second factor: a `login` response with TOTP enabled returns a `partial_token` and `requires_2fa: true`. Complete it with `POST /api/v1/auth/verify-totp`, sending the `partial_token` as `Authorization: Bearer {partial_token}` with body `{"code": "…"}` (a 6-digit TOTP or a one-time recovery code). A challenge lives 10 minutes and is revoked after 5 wrong codes.
- Account recovery (`POST /api/v1/auth/recover`) uses a recovery kit or an owner-issued credential in place of a password, revokes every existing session, and issues a fresh session without the second factor.

## Errors and rate limits

Standard REST error envelope:

```json
{ "error": "ERROR_CODE", "message": "Human-readable detail" }
```

Exceptions answer in plain text via `http.Error`: the plugin admin endpoints, `GET /api/v1/client-update/…` (400/502), `POST /api/v1/livekit/webhook` (401/503), and the WebSocket upgrade's 503 at `server.max_ws_connections`. A recovered handler panic is an empty-bodied 500.

Representative codes (full table: [docs/api.md § Standard Error Response](docs/api.md#standard-error-response)):

| Code                             | HTTP | Meaning                                                                                                                                                                                                                                                         |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                   | 401  | Missing, invalid or expired token. A failed login is `401 UNAUTHORIZED` `invalid credentials`; a bad 2FA code is `401 UNAUTHORIZED` `invalid two-factor code`                                                                                                   |
| `INVALID_CREDENTIALS`            | 400  | Registration refused: a bad, used-up or expired invite, or a taken username (deliberately indistinguishable)                                                                                                                                                    |
| `FORBIDDEN`                      | 403  | Insufficient permission, banned, or the admin IP restriction                                                                                                                                                                                                    |
| `NOT_FOUND`                      | 404  | Resource not found                                                                                                                                                                                                                                              |
| `RATE_LIMITED`                   | 429  | Too many requests. Only the per-route middleware limits send `Retry-After` (seconds); service-level 429s (login and recovery lockouts, the per-day registration and approval-queue caps, the per-user upload cap, purge/report/appeal caps) carry none          |
| `INVALID_INPUT` / `BAD_REQUEST`  | 400  | Malformed body or params, or an oversize upload (uploads over the limit are 400, not 413)                                                                                                                                                                       |
| `CONFLICT`                       | 409  | A taken username on profile rename (`PATCH /api/v1/users/me`), or a stale/duplicate action (`DUPLICATE_REPORT`, `ALREADY_DELETED`, `ALREADY_APPEALED` are 409 variants)                                                                                         |
| `INTERNAL_ERROR`                 | 500  | Server error                                                                                                                                                                                                                                                    |
| `SERVICE_UNAVAILABLE`            | 503  | The bearer could not be resolved because the database failed, not because the token is bad: retry, and do not clear the stored credential (the WebSocket equivalent is an `error` frame with code `INTERNAL`)                                                   |
| `STORAGE_ERROR`                  | 507  | Upload could not be persisted                                                                                                                                                                                                                                   |
| `BAD_GATEWAY`                    | 502  | The LiveKit signalling-proxy backend or the GIF provider is unavailable. GitHub failures use their own codes: the admin update routes answer 502 `UPDATE_CHECK_FAILED` / `MISSING_ASSETS` / `DOWNLOAD_FAILED`, and `GET /api/v1/client-update` a plain-text 502 |
| `GIF_DISABLED` / `PUSH_DISABLED` | 503  | Optional feature not configured on this server                                                                                                                                                                                                                  |

Rate limiting is per route, backed by one shared `auth.RateLimiter` instance (also used by the WebSocket hub, so auth lockouts are consistent across both surfaces). Selected budgets, as compiled defaults; `security.auth_rate_limit_multiplier` (default 1.0, clamped to 0.1–100) scales the per-IP auth budgets and the per-IP login-lockout threshold, never the per-username or per-user caps:

| Route family                       | Budget                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/login`          | 5/min per IP; 10 failed attempts in 15 min lock the IP, and 10 failed attempts lock the username; both persisted, survive restarts |
| `POST /api/v1/auth/register`       | 3/min per IP; `approval`/`open` modes additionally cap at 5 registrations per address per day                                      |
| `POST /api/v1/auth/verify-totp`    | 10/min per IP, plus a 5-attempt budget per partial challenge                                                                       |
| `POST /api/v1/auth/recover`        | 5/min per IP; 5 failures lock recovery for 15 min                                                                                  |
| `/api/v1/diagnostics/connectivity` | 5/min, admin-only                                                                                                                  |
| Client auto-update poll            | A dedicated bucket, so it cannot 429 a user's own 2FA or password-change calls                                                     |

WebSocket-side limits are keyed by user id, on a sliding window over the shared limiter: `chat_send`/`chat_edit`/`chat_delete` 10/sec each (plus channel slow mode → `SLOW_MODE`), `reaction_add`/`remove` 5/sec combined, `typing_start` 1 per 3 s per channel, `presence_update` 1 per 10 s, `voice_join`/`voice_leave` 5/sec, `voice_mute`/`voice_deafen` 2/sec, `voice_camera`/`voice_screenshare` 2/sec, `voice_token_refresh` 1 per 60 s, voice moderation 5/sec, `call_ring`/`call_decline` 1 per 3 s, `chat_command` 5/sec, `voice_e2ee_announce` 5/sec, `voice_e2ee_offer` 64/sec. Exceeding one returns an `error` frame with code `RATE_LIMITED` (no `Retry-After`); only `typing_start`, `channel_focus`/`mark_read` (5/sec each) and `ping` (2/sec) are silently dropped (see the Rate Limits section of [docs/protocol.md](docs/protocol.md)).

## REST endpoint groups

Routes are registered in the `Mount*Routes` function of the owning `Server/api/*_handler.go` (admin routes in `Server/admin/api.go`); `NewRouter` in `Server/api/router.go` composes them and holds the global middleware. At this commit there are 175 routes (`otel,wazero` build); this table is a representative sample per group, and [docs/api.md](docs/api.md) has every route.

| Group                      | Representative routes                                                                                                                      | Required auth / permission                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public                     | `GET /health`, `GET /api/v1/info`, `GET /api/v1/server-info`                                                                               | None                                                                                                                                                                                                                                                                                              |
| Auth                       | `POST /api/v1/auth/{register,login,recover,verify-totp}`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `DELETE /api/v1/auth/account` | None for register/login/recover; `verify-totp` takes the login's `partial_token` as the bearer; logout/me/account need a session                                                                                                                                                                  |
| Profile & sessions         | `PATCH /api/v1/users/me`, `POST /api/v1/users/me/avatar`, `GET /api/v1/users/me/moderation`                                                | Session (own account)                                                                                                                                                                                                                                                                             |
| Channels & messages        | `GET /api/v1/channels/`, `GET /api/v1/channels/{id}/messages`, `POST /api/v1/channels/{id}/messages/purge`                                 | Session + `READ_MESSAGES`; purge also needs `MANAGE_MESSAGES`                                                                                                                                                                                                                                     |
| Reactions & pins           | `GET .../pins`, `POST/DELETE .../pins/{messageId}`, `GET .../reactions/{emoji}/users`                                                      | Session + `READ_MESSAGES` for reads; pin/unpin needs `READ_MESSAGES` + `MANAGE_MESSAGES` in the channel (in a DM: any unblocked participant)                                                                                                                                                      |
| NSFW acknowledgement       | `PUT`/`DELETE /api/v1/channels/{id}/nsfw-acknowledgement/`                                                                                 | Session (per-user consent row)                                                                                                                                                                                                                                                                    |
| DMs & DM requests          | `GET/POST /api/v1/dms/`, `POST /api/v1/dms/group`, `GET /api/v1/dm-requests/`, `POST /api/v1/dm-requests/{id}/accept`                      | Session, DM participant                                                                                                                                                                                                                                                                           |
| Blocks                     | `GET /api/v1/blocks/`, `PUT/DELETE /api/v1/blocks/{userId}`                                                                                | Session (own blocklist)                                                                                                                                                                                                                                                                           |
| Emoji                      | `GET/POST /api/v1/emoji/`, `DELETE /api/v1/emoji/{id}`                                                                                     | Session; create/delete needs `MANAGE_SERVER`                                                                                                                                                                                                                                                      |
| Uploads & files            | `POST /api/v1/uploads`, `GET /api/v1/files/{id}`                                                                                           | Session. The upload checks no permission (10/min per user; 507 on quota or low disk); `ATTACH_FILES` is enforced when a `chat_send` links the upload. `GET /files/{id}` needs `READ_MESSAGES` in the linked channel (DM: participant; unlinked file: uploader only) plus any NSFW acknowledgement |
| GIF proxy                  | `GET /api/v1/gif/search`, `GET /api/v1/gif/trending`                                                                                       | Session (503 `GIF_DISABLED` if unconfigured)                                                                                                                                                                                                                                                      |
| Web Push                   | `GET /api/v1/push/vapid`, `GET/POST /api/v1/push/subscriptions`, `DELETE /api/v1/push/subscriptions/{id}`                                  | Session (503 `PUSH_DISABLED` if `push.enabled` is false)                                                                                                                                                                                                                                          |
| Invites                    | `/api/v1/invites/*`                                                                                                                        | Session + `MANAGE_INVITES`                                                                                                                                                                                                                                                                        |
| Appeals                    | `POST /api/v1/appeals/`, `GET /api/v1/appeals/mine`, `POST /api/v1/appeals/{id}/withdraw`                                                  | Session (own appeals)                                                                                                                                                                                                                                                                             |
| Reports & moderation queue | `/api/v1/reports/*`, moderation queue routes                                                                                               | Session (file a report); `MODERATE_MEMBERS` or `ADMINISTRATOR` (queue)                                                                                                                                                                                                                            |
| Diagnostics                | `GET /api/v1/diagnostics/connectivity`                                                                                                     | Session + `ADMINISTRATOR`                                                                                                                                                                                                                                                                         |
| Client update              | `GET /api/v1/client-update/{target}/{current_version}`                                                                                     | None (rate-limited)                                                                                                                                                                                                                                                                               |
| Metrics                    | `GET /api/v1/metrics` (JSON, every build), `GET /metrics` (Prometheus, `otel` build only)                                                  | IP-restricted (`metrics_allowed_cidrs`, falling back to the admin CIDRs)                                                                                                                                                                                                                          |
| LiveKit                    | `POST /api/v1/livekit/webhook`, `GET /api/v1/livekit/health`, `/livekit/*` proxy                                                           | Webhook and health IP-restricted; the proxy relies on a LiveKit JWT obtained via an authenticated `voice_join`                                                                                                                                                                                    |
| WebSocket upgrade          | `GET /api/v1/ws`                                                                                                                           | In-band (the first WS frame must be `auth`)                                                                                                                                                                                                                                                       |
| Admin panel & API          | `GET /admin/`, `/admin/api/{stats,users,roles,channels,settings,backup(s),updates,audit-log,tokens,registrations}`                         | See [Admin API permissions](#admin-api-permissions)                                                                                                                                                                                                                                               |
| Plugin admin               | `GET /api/v1/admin/plugins/`, `POST .../install`, `POST .../{id}/{enable,disable}`                                                         | The admin IP gate **and** `admin.RequireAdminAuth`: a bearer (session or API token) whose role has `ADMINISTRATOR`; errors are plain text                                                                                                                                                         |

### Admin API permissions

`/admin/api/*` is IP-restricted (`admin_allowed_cidrs`) and needs a bearer (session or API token) whose role holds any `permissions.AdminPerimeter` bit (`ADMINISTRATOR`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_SERVER`, `VIEW_AUDIT_LOG`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`). Each group then re-checks its own bit:

- channels, overrides, access preview → `MANAGE_CHANNELS`; roles → `MANAGE_ROLES`; settings, registrations, retention → `MANAGE_SERVER`; audit log → `VIEW_AUDIT_LOG`; force-logout → `KICK_MEMBERS`.
- `PATCH /users/{id}` → the perimeter only, with a ban or role change re-checked in `ModerationService` (`BAN_MEMBERS`/`MANAGE_ROLES` plus role hierarchy).
- logs ticket, support bundles, attention, account erasure → `ADMINISTRATOR`, which bypasses every bit check.
- tokens, backups, updates, recovery credentials → **Owner role only**; `ADMINISTRATOR` does not bypass this.
- `POST /admin/api/setup` and `GET /admin/api/setup/status` are unauthenticated; `/logs/stream` takes a single-use ticket.

### Global middleware

In mount order: request-ID binding (`boundRequestID`, chi `RequestID`, `X-Request-Id` echo); OpenTelemetry tracing (a no-op without `-tags otel` or with telemetry disabled; mounted before recovery so a panic log carries the trace id); panic recovery; structured request logging; security headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP, etc.); a body-size cap (1 MiB by default, larger for uploads, plugin install and avatars); and an optional Coraza WAF. `middleware.RealIP` is deliberately not used: only when the peer is in `server.trusted_proxies` is the client IP taken from `X-Forwarded-For` (walked right to left past trusted hops), falling back to `X-Real-IP` when XFF is absent or unusable; otherwise `RemoteAddr`.

## WebSocket

### Connect and handshake

- Connect: `wss://{host}/api/v1/ws`. The desktop client connects through the Tauri Rust backend's WebSocket proxy (with TOFU certificate pinning) rather than the webview's own WebSocket, because the webview rejects the server's self-signed certificate.
- There is no HTTP `AuthMiddleware`: auth is in-band. The client's first frame, within a 10-second deadline, must be:

```json
{
  "type": "auth",
  "payload": { "token": "...", "last_seq": 0, "active_channel_id": null, "epoch": 1 }
}
```

- **Success:** `auth_ok` (`{user, server_name, motd, replay_source}`), followed by `ready` (full initial state) unless replaying.
- **Failure:** `auth_error` is terminal (the client stops reconnecting and clears its credential), with `message` one of `invalid message`, `first message must be auth`, `missing token`, `invalid token`, `session expired`, `user not found`, or the structured epoch refusal below. A banned user instead gets an `error` frame with code `BANNED`; a database fault gets an `error` frame with code `INTERNAL` (retry with backoff and keep the credential). Every failure then closes with code **1008**.
- **One live socket per account:** a newly authenticated connection displaces the user's previous one, which gets an `error` frame with code `SESSION_REPLACED` before the close and must not auto-reconnect.
- **Heartbeat:** the client sends `{"type":"ping","payload":{}}` every 30 s (server cap 2/sec, excess silently dropped), and the server replies `{"type":"pong"}`. Every 30 s the hub disconnects clients idle for 90 s and re-checks every connected session (revoked, expired or banned → kicked); each connection is also re-checked every 10 inbound messages.

### Message envelope

```json
{ "type": "message_type", "id": "client-uuid", "payload": {}, "seq": 42 }
```

`type` is always present. `payload` is required on client→server frames that carry fields, but may be absent on server frames (`pong` is `{"type":"pong"}`). `id` is a client-generated correlation id that the server echoes on its direct responses to that request (`chat_send_ok`, and the `error` frame for a failed command); `command_reply` echoes the command's `req_id` instead. `seq` is a monotonically increasing server counter, present only on broadcasts that participate in replay.

### Message-type families (from `protocol/schema.json`)

The schema declares wire names only; payload shapes live in `docs/protocol.md`, `Server/ws/command.go`/`messages.go` and `Client/src/lib/types.ts`. Grouped by domain:

| Domain                           | Client → Server                                                                                                       | Server → Client                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth/liveness                    | `auth`, `ping`                                                                                                        | `auth_ok`, `auth_error`, `ready`, `pong`, `error`, `server_restart`                                                                                           |
| Chat                             | `chat_send`, `chat_edit`, `chat_delete`                                                                               | `chat_message`, `chat_send_ok`, `chat_edited`, `chat_deleted`, `chat_bulk_deleted`                                                                            |
| Reactions                        | `reaction_add`, `reaction_remove`                                                                                     | `reaction_update`                                                                                                                                             |
| Typing/presence/read-state       | `typing_start`, `presence_update`, `channel_focus`, `mark_read`                                                       | `typing`, `presence`                                                                                                                                          |
| Channels/members/roles/emoji     | —                                                                                                                     | `channel_create`, `channel_update`, `channel_delete`, `member_join`, `member_update`, `user_update`, `member_ban`, `roles_update`, `emoji_update`, `nsfw_ack` |
| Voice signalling                 | `voice_join`, `voice_leave`, `voice_mute`, `voice_deafen`, `voice_camera`, `voice_screenshare`, `voice_token_refresh` | `voice_state`, `voice_config`, `voice_token`, `voice_leave`, `voice_moved`, `voice_disconnected`                                                              |
| Voice moderation                 | `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`, `voice_mod_kick`                                              | Mute/deafen broadcast `voice_state`; move and kick broadcast `voice_leave` and send the target `voice_moved` / `voice_disconnected`                           |
| Voice E2EE                       | `voice_e2ee_announce`, `voice_e2ee_offer`                                                                             | `voice_e2ee_announce` (broadcast), `voice_e2ee_offer` (relay)                                                                                                 |
| Calls                            | `call_ring`, `call_decline`                                                                                           | `call_incoming`, `call_declined`                                                                                                                              |
| DMs                              | —                                                                                                                     | `dm_channel_open`, `dm_channel_close`, `dm_request`                                                                                                           |
| Moderation queue/actions/appeals | —                                                                                                                     | `mod_queue`, `mod_action`, `appeal_status`                                                                                                                    |
| Plugins                          | `chat_command`                                                                                                        | `command_reply`, `plugin_broadcast` (built in `Server/ws/handlers_command.go`)                                                                                |

Full per-type payloads, permission gates and rate limits are in [docs/protocol.md](docs/protocol.md).

### Sequencing, reconnect and replay

- Every sequenced broadcast gets the next value from an atomic `uint64` counter and is stored in an in-memory ring buffer (`event_persistence.replay_ring_size`, default 1000).
- On reconnect the client sends `last_seq`, and the server picks the cheapest tier of a replay pipeline:

| Tier | Condition                                                                                      | Behaviour                                                               | `replay_source` |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| 0    | `last_seq == 0`                                                                                | Full flow: `auth_ok` + `ready` + `member_join` + `presence`             | `none`          |
| 1    | seq within the ring buffer                                                                     | `auth_ok` + missed events + `presence`, permission-filtered fail-closed | `buffer`        |
| 2    | seq within the persistent `events` table (`event_persistence.replay_cold_limit`, default 5000) | The same replay flow, served from the cold tier                         | `db`            |
| 3    | Too far behind, or channel visibility changed while disconnected                               | Full-flow fallback                                                      | `none`          |

- Unsequenced (ephemeral) frames are never replayed: `typing`, `mod_queue`, `mod_action`, `appeal_status`, targeted `channel_create`, `nsfw_ack`, `dm_channel_open`/`close`, `dm_request`, `call_incoming`/`declined`, and the owner's own copy of an invisible-status `presence`. Every broadcast `presence`, from connect/disconnect or a `presence_update`, is sequenced and replayed (OC-0214). Clients recover unsequenced state from the next `ready` or a targeted REST GET.
- `active_channel_id` in the `auth` frame lets a resuming client re-declare its focused channel without waiting for a post-`auth_ok` `channel_focus` round trip; clients should still send `channel_focus` for backward compatibility.

### Backpressure

Broadcasts fan out through per-topic pub/sub (global, `channel:N`, `voice:N`, `user:N`). Only channel-scoped broadcasts pass a 100 msg/s per-channel limiter, which sheds a frame before it gets a seq. Each client has three queues, drained high-first by `writePump`:

- `send` (256): every sequenced frame (chat including DMs, reactions, channel events, every broadcast `presence`) plus unsequenced direct replies, so the client's max(`seq`) ack never passes an undelivered frame.
- `sendHigh` (64): unsequenced user-targeted frames only (DM-channel opens, DM requests, call signals); when full it spills into `send`.
- `sendLow` (64): typing indicators and targeted moderation/appeal notices, unsequenced and never replayed.

A full `send` queue **disconnects the client**, forcing it through the replay pipeline to restore consistency; a full `sendLow` **silently drops**. The global broadcast channel (capacity 1024) drops with a counted metric when saturated. Details: [docs/architecture/websocket.md](docs/architecture/websocket.md).

## Protocol epoch and compatibility

- The wire protocol has one version number, the **epoch**: `protocol_epoch` in `protocol/schema.json`, generated into `ws.ProtocolEpoch` (server) and `PROTOCOL_EPOCH` (client). Today `ProtocolEpoch` is 1 and `minClientEpoch` is 0.
- `GET /api/v1/server-info` (unauthenticated) returns the server's `protocol_epoch`, so a client can detect an incompatible server before opening the WebSocket; the desktop client derives its compatibility state from it.
- The client sends its `epoch` in the `auth` frame; the server accepts anything in `[min_epoch, server_epoch]` and refuses the rest with a structured `auth_error`. Today the only refusal is a client claiming epoch ≥ 2, answered with `…but the server only speaks 1; update the server`. An illustrative refusal from a future epoch-2 server that raised `minClientEpoch` to 2:

```json
{
  "type": "auth_error",
  "payload": {
    "message": "this client speaks protocol epoch 0 but the server needs 2; update the client",
    "code": "protocol_epoch_unsupported",
    "client_epoch": 0,
    "server_epoch": 2,
    "min_epoch": 2
  }
}
```

- **Within an epoch**, changes are additive only: new optional fields, new message types the other side may ignore. An unknown server→client type is ignored by the client; an unknown client→server type gets an `error` frame.
- **A breaking change bumps the epoch** and sets `minClientEpoch` (`Server/ws/messages.go`); the server accepts exactly one epoch by policy. Epoch 1 additionally accepts an absent `epoch` (read as 0) for pre-epoch clients.
- The server always upgrades first: a release's signed update manifest carries its `protocol_epoch`, and `GET /api/v1/client-update` never advertises a release whose epoch is newer than the running server's. A client refused with `protocol_epoch_unsupported` sees the regular update banner when the server's epoch is the newer one.

## MCP introspection

`tools/mcp-introspect/` is a development-only [MCP](https://modelcontextprotocol.io) server (not shipped in the product) that lets an agent inspect a locally running OwnCord instance over the same REST API:

- **`api_request`**: a generic passthrough, any HTTP method against any path on the local instance, authenticated with a bearer API token, returning `{status, headers, body}`. It has no write allowlist, so it can call destructive admin routes.
- **`server_logs`**: reads the server's in-memory log ring buffer (last 2000 records) via a ticketed Server-Sent-Events stream (`POST /admin/api/logs/ticket`, then `GET /admin/api/logs/stream?ticket=...`), with optional `level`/`source` filters and a `follow_ms` live-tail window.

Setup: mint a token with `server token create --label mcp-introspect` (defaults to the owner account), set `OWNCORD_API_TOKEN`, and the server is registered in `.mcp.json`. TLS is handled by pinning the server's self-signed certificate (`Server/data/cert.pem`) rather than trusting a CA, since the certificate has no SAN. Full detail, troubleshooting and the API-token schema: [docs/mcp-introspect.md](docs/mcp-introspect.md).

## Changing the API

**REST.** Register the route in the `Mount*Routes` function of the owning `Server/api/*_handler.go` (admin routes in `Server/admin/api.go`); `NewRouter` in `router.go` only composes them. A route reachable without a bearer must also be added to `publicSurface` in `Server/api/auth_posture_test.go`, or the route walk fails. Then regenerate the documentation from `Server/`:

```bash
go run -tags otel,wazero ./cmd/gendocs
```

This rewrites the generated blocks in `docs/api.md`, `docs/schema.md` and `docs/server-configuration.md`; never hand-edit inside one. CI fails on drift (`make docs-verify`, i.e. the command above followed by `git diff --exit-code ../docs/api.md ../docs/schema.md ../docs/server-configuration.md`).

**WebSocket.** Most payload changes never touch the schema:

| Change                                                   | What to edit                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| New message type                                         | `protocol/schema.json`, then regenerate (below)                                                                                |
| New or changed payload field on an existing type         | `Server/ws/command.go`/`messages.go`, `Client/src/lib/types.ts` (the payload interfaces), `docs/protocol.md`: no schema change |
| Content inside an opaque blob the server relays verbatim | `docs/protocol.md` only                                                                                                        |

For a new message type: edit `protocol/schema.json`, then from `Server/` run `go run ./cmd/genprotocol` (what `make protocol-generate` runs; `npm run generate` from the repo root also works). Commit **both** generated outputs, `Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts`, together; committing only one is the usual mistake, and CI fails on either being stale (`go run ./cmd/genprotocol && git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts`). Neither generated file is ever hand-edited.

The schema entry alone does not make a type work. A new client→server type also needs a constructor in `commandConstructors` (`Server/ws/command.go`) plus a `RegisterV2` handler; without the constructor the server answers `UNKNOWN_TYPE`. A new server→client type needs a builder in `Server/ws/messages.go` and a `ws.on(...)` subscription in `Client/src/lib/dispatcher.ts`. Document the semantics in `docs/protocol.md`, since the schema carries names only.

## Sources

- [docs/api.md](docs/api.md), [docs/protocol.md](docs/protocol.md), [docs/architecture/websocket.md](docs/architecture/websocket.md), [docs/mcp-introspect.md](docs/mcp-introspect.md)
- [protocol/schema.json](protocol/schema.json), [Server/api/router.go](Server/api/router.go), [Server/api/auth_posture_test.go](Server/api/auth_posture_test.go), [Server/api/middleware.go](Server/api/middleware.go), [Server/api/auth_handler.go](Server/api/auth_handler.go), [Server/api/constants.go](Server/api/constants.go)
- [Server/admin/api.go](Server/admin/api.go), [Server/admin/middleware.go](Server/admin/middleware.go), [Server/permissions/permissions.go](Server/permissions/permissions.go)
- [Server/ws/serve_auth.go](Server/ws/serve_auth.go), [Server/ws/hub.go](Server/ws/hub.go), [Server/ws/hub_broadcast.go](Server/ws/hub_broadcast.go), [Server/ws/emit.go](Server/ws/emit.go), [Server/ws/client.go](Server/ws/client.go), [Server/ws/messages.go](Server/ws/messages.go), [Server/ws/command.go](Server/ws/command.go)
- [Client/src/lib/types.ts](Client/src/lib/types.ts), [Client/src/lib/dispatcher.ts](Client/src/lib/dispatcher.ts), [.claude/skills/protocol-change/SKILL.md](.claude/skills/protocol-change/SKILL.md), [Server/CLAUDE.md](Server/CLAUDE.md)
