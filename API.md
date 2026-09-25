# API

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the source documents win.

OwnCord exposes two surfaces: a REST API for CRUD/admin operations and a single WebSocket connection for real-time chat, presence and voice signaling. This file is a map of both, condensed for an AI coding agent; the full generated route table and every request/response shape live in [`docs/api.md`](docs/api.md) and [`docs/protocol.md`](docs/protocol.md).

## Base URL and versioning

- REST base URL: `https://{server}:{port}/api/v1`.
- The admin panel and its API live under `/admin` (static files + `/admin/api/*`), outside the `/api/v1` prefix, and are IP-restricted (`server.admin_allowed_cidrs`, default private networks only).
- There is no per-route API version negotiation — `v1` is the only REST version, and it is a fixed path segment, not a header.
- The WebSocket protocol has its own, separate version number: the **epoch** (`protocol_epoch` in `protocol/schema.json`). See [Protocol epoch and compatibility](#protocol-epoch-and-compatibility).
- A handful of routes are unauthenticated and unversioned or partially versioned: `GET /health`, `GET /api/v1/info`, `GET /api/v1/server-info`, and the client auto-update route.

## Authentication

Two credential kinds resolve through the same code path (`auth.ResolveTokenHash`), sessions checked first:

| Kind          | How obtained                                                                                        | Lifetime                                                                                      | Sent as                         |
| ------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------- |
| Session token | `POST /api/v1/auth/login`, `/register`, or `/verify-totp` after a 2FA challenge                     | Expires; revoked on logout, password change, or bulk logout                                   | `Authorization: Bearer {token}` |
| API token     | `server token create` CLI (writes directly to the DB) or `POST /admin/api/tokens` (owner role only) | Long-lived; `expires_at IS NULL` = never expires; revocable, independent of the session table | `Authorization: Bearer {token}` |

- Session tokens are stored as a SHA-256 hash alongside client IP, User-Agent and an expiry; every authenticated request updates `last_active`. Every 10 WebSocket messages the server re-validates the session against the database.
- API tokens are a separate credential added for headless/automation use (e.g. `tools/mcp-introspect`, see [MCP introspection](#mcp-introspection)); they inherit the role of the user they are bound to (the owner by default), which is why an owner-bound token can reach `/admin/api/*`.
- Banned users are rejected at the middleware level with `403 FORBIDDEN` on REST, and disconnected on the next WebSocket session revalidation.
- Login can require a second factor: a `login` response with TOTP enabled returns a `partial_token` and `requires_2fa: true`; complete it with `POST /api/v1/auth/verify-totp` (6-digit code or a one-time recovery code).
- Account recovery (`POST /api/v1/auth/recover`) uses a recovery kit or an owner-issued credential in place of a password, revokes every existing session, and issues a fresh session without the second factor.

## Errors and rate limits

Standard REST error envelope (one exception: plugin admin endpoints return plain-text errors):

```json
{ "error": "ERROR_CODE", "message": "Human-readable detail" }
```

Representative codes (full table: [`docs/api.md` § Standard Error Response](docs/api.md#standard-error-response)):

| Code                             | HTTP | Meaning                                                                                                                      |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                   | 401  | missing/invalid/expired session token                                                                                        |
| `INVALID_CREDENTIALS`            | 401  | bad login/register credentials (generic, anti-enumeration)                                                                   |
| `FORBIDDEN`                      | 403  | insufficient permission, banned, or admin IP restriction                                                                     |
| `NOT_FOUND`                      | 404  | resource not found                                                                                                           |
| `RATE_LIMITED`                   | 429  | too many requests; response carries a `Retry-After` header (seconds)                                                         |
| `INVALID_INPUT` / `BAD_REQUEST`  | 400  | malformed body/params, or an oversize upload (uploads over the limit are 400, not 413)                                       |
| `CONFLICT`                       | 409  | duplicate username, or a stale/duplicate action (`DUPLICATE_REPORT`, `ALREADY_DELETED`, `ALREADY_APPEALED` are 409 variants) |
| `INTERNAL_ERROR`                 | 500  | server error                                                                                                                 |
| `STORAGE_ERROR`                  | 507  | upload could not be persisted                                                                                                |
| `BAD_GATEWAY`                    | 502  | upstream failure (GitHub, LiveKit, GIF provider)                                                                             |
| `GIF_DISABLED` / `PUSH_DISABLED` | 503  | optional feature not configured on this server                                                                               |

Rate limiting is per-route, backed by one shared `auth.RateLimiter` instance (also used by the WS hub, so auth lockouts are consistent across both surfaces). Selected budgets:

| Route family                       | Budget                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/login`          | 5/min per IP; 10 failed attempts/15min locks the IP, 10 failed attempts locks the username — both persisted, survive restarts |
| `POST /api/v1/auth/register`       | 3/min per IP; `approval`/`open` modes additionally cap at 5 registrations per address per day                                 |
| `POST /api/v1/auth/verify-totp`    | 10/min per IP, plus a 5-attempt budget per partial challenge                                                                  |
| `POST /api/v1/auth/recover`        | 5/min per IP; 5 failures locks recovery for 15 min                                                                            |
| `/api/v1/diagnostics/connectivity` | 5/min, admin-only                                                                                                             |
| Client auto-update poll            | dedicated bucket so it can't 429 a user's own 2FA/password-change calls                                                       |

WebSocket-side rate limits (per connection, not HTTP): `reaction_add`/`remove` 5/sec, `typing_start` 1 per 3s per channel, `presence_update` 1 per 10s, `voice_mute`/`voice_deafen` 2/sec, `voice_camera`/`voice_screenshare` 2/sec, `voice_token_refresh` 1 per 60s, voice moderation commands 5/sec. Exceeding most of these silently drops the message rather than erroring (see [`docs/protocol.md`](docs/protocol.md) per-message-type sections).

## REST endpoint groups

Route groups below are mounted in `Server/api/router.go` (`NewRouter`); paths verified against that file and the generated route index in [`docs/api.md`](docs/api.md) (175 routes total, `otel,wazero` build). This is a representative sample per group, not the full list — see the linked doc for every route.

| Group                      | Representative routes                                                                                                                      | Required auth / permission                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Public/unauthenticated     | `GET /health`, `GET /api/v1/info`, `GET /api/v1/server-info`                                                                               | None                                                                                                            |
| Auth                       | `POST /api/v1/auth/{register,login,recover,verify-totp}`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`, `DELETE /api/v1/auth/account` | None (register/login/recover) or session                                                                        |
| Profile & sessions         | `PATCH /api/v1/users/me`, `POST /api/v1/users/me/avatar`, `GET /api/v1/users/me/moderation`                                                | Session (own account)                                                                                           |
| Channels & messages        | `GET /api/v1/channels/`, `GET /api/v1/channels/{id}/messages`, `POST /api/v1/channels/{id}/messages/purge`                                 | Session + `READ_MESSAGES`; purge additionally needs `MANAGE_MESSAGES`                                           |
| Reactions/pins             | `GET .../pins`, `POST/DELETE .../pins/{messageId}`, `GET .../reactions/{emoji}/users`                                                      | Session + channel read/manage permission                                                                        |
| NSFW acknowledgement       | `PUT`/`DELETE /api/v1/channels/{id}/nsfw-acknowledgement/`                                                                                 | Session (per-user consent row)                                                                                  |
| DMs & DM requests          | `GET/POST /api/v1/dms/`, `POST /api/v1/dms/group`, `GET /api/v1/dm-requests/`, `POST /api/v1/dm-requests/{id}/accept`                      | Session, DM participant                                                                                         |
| Blocks                     | `GET /api/v1/blocks/`, `PUT/DELETE /api/v1/blocks/{userId}`                                                                                | Session (own blocklist)                                                                                         |
| Emoji                      | `GET/POST /api/v1/emoji/`, `DELETE /api/v1/emoji/{id}`                                                                                     | Session; create/delete needs `MANAGE_SERVER`                                                                    |
| Uploads/files              | `POST /api/v1/uploads`, `GET /api/v1/files/{id}`                                                                                           | Session; send requires `ATTACH_FILES`                                                                           |
| GIF proxy                  | `GET /api/v1/gif/search`, `GET /api/v1/gif/trending`                                                                                       | Session (503 `GIF_DISABLED` if unconfigured)                                                                    |
| Web Push                   | (subscription storage routes)                                                                                                              | Session (503 `PUSH_DISABLED` if `push.enabled` is false)                                                        |
| Invites                    | `/api/v1/invites/*`                                                                                                                        | Session + `MANAGE_INVITES`                                                                                      |
| Appeals                    | `POST /api/v1/appeals/`, `GET /api/v1/appeals/mine`, `POST /api/v1/appeals/{id}/withdraw`                                                  | Session (own appeals)                                                                                           |
| Reports / moderation queue | `/api/v1/reports/*`, moderation queue routes                                                                                               | Session (file); `MODERATE_MEMBERS` or `ADMINISTRATOR` (queue)                                                   |
| Diagnostics                | `GET /api/v1/diagnostics/connectivity`                                                                                                     | Session + `ADMINISTRATOR`                                                                                       |
| Client update              | `GET /api/v1/client-update/{target}/{current_version}`                                                                                     | None (rate-limited)                                                                                             |
| Metrics                    | `GET /api/v1/metrics`, `GET /metrics` (Prometheus, otel build only)                                                                        | IP-restricted (`metrics_allowed_cidrs`, falls back to admin CIDRs)                                              |
| LiveKit                    | `POST /api/v1/livekit/webhook`, `GET /api/v1/livekit/health`, `/livekit/*` proxy                                                           | Webhook/health IP-restricted; proxy relies on a LiveKit JWT obtained via authenticated `voice_join`             |
| WebSocket upgrade          | `GET /api/v1/ws`                                                                                                                           | In-band (first WS frame must be `auth`)                                                                         |
| Admin panel & API          | `GET /admin/`, `/admin/api/{stats,users,roles,channels,settings,backups,updates,audit-log,tokens,registrations}`                           | IP-restricted (`admin_allowed_cidrs`) + session with sufficient role; most mutating routes need `ADMINISTRATOR` |
| Plugin admin               | `GET /api/v1/admin/plugins/`, `POST .../install`, `POST .../{id}/{enable,disable}`                                                         | Admin IP gate **and** `admin.RequireAdminAuth` bearer session                                                   |
| API tokens (admin)         | `GET/POST/DELETE /admin/api/tokens[/{id}]`                                                                                                 | Owner role only                                                                                                 |

Middleware applied to every route (in mount order): request-ID binding, panic recovery, structured request logging, OpenTelemetry tracing (no-op without `-tags otel`), security headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP, etc.), a body-size cap (1 MiB default, larger for uploads/plugin-install/avatar), and an optional Coraza WAF. `middleware.RealIP` is deliberately not used — client IPs come from `X-Forwarded-For` only when the peer is in `server.trusted_proxies`.

## WebSocket

### Connect and handshake

- Connect: `wss://{host}/api/v1/ws`. The desktop client connects through the Tauri Rust backend's WS proxy (with TOFU certificate pinning) rather than the native WebView2 WebSocket, because WebView2 rejects the server's self-signed cert.
- No HTTP `AuthMiddleware` — auth is in-band. The client's first frame, within a 10-second deadline, must be:

```json
{
  "type": "auth",
  "payload": { "token": "...", "last_seq": 0, "active_channel_id": null, "epoch": 1 }
}
```

- Success: `auth_ok` (`{user, server_name, motd, replay_source}`), followed by `ready` (full initial state) unless replaying. Failure: `auth_error` with a fixed set of `message` values (`missing token`, `invalid token`, `session expired`, `user not found`, etc.), then the socket closes with code **1008**.
- Heartbeat: client sends `{"type":"ping"}` every 30s, server replies `{"type":"pong"}`. Server sweeps idle clients (no activity 90s) every 30s, and re-validates the session every 10 messages.

### Message envelope

```json
{ "type": "message_type", "id": "client-uuid", "payload": {}, "seq": 42 }
```

`type` and `payload` are always present; `id` is client-generated for request/response correlation (client→server only); `seq` is a monotonically increasing server counter present only on broadcast (server→client) messages that participate in replay.

### Message-type families (from `protocol/schema.json`)

The schema declares wire names only (payload shapes live in `docs/protocol.md`). Grouped by domain:

| Domain                           | Client → Server                                                                                                       | Server → Client                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth/liveness                    | `auth`, `ping`                                                                                                        | `auth_ok`, `auth_error`, `ready`, `pong`, `error`, `server_restart`                                                                                           |
| Chat                             | `chat_send`, `chat_edit`, `chat_delete`                                                                               | `chat_message`, `chat_send_ok`, `chat_edited`, `chat_deleted`, `chat_bulk_deleted`                                                                            |
| Reactions                        | `reaction_add`, `reaction_remove`                                                                                     | `reaction_update`                                                                                                                                             |
| Typing/presence/read-state       | `typing_start`, `presence_update`, `channel_focus`, `mark_read`                                                       | `typing`, `presence`                                                                                                                                          |
| Channels/members/roles/emoji     | —                                                                                                                     | `channel_create`, `channel_update`, `channel_delete`, `member_join`, `member_update`, `user_update`, `member_ban`, `roles_update`, `emoji_update`, `nsfw_ack` |
| Voice signaling                  | `voice_join`, `voice_leave`, `voice_mute`, `voice_deafen`, `voice_camera`, `voice_screenshare`, `voice_token_refresh` | `voice_state`, `voice_config`, `voice_token`, `voice_leave`, `voice_moved`, `voice_disconnected`                                                              |
| Voice moderation                 | `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`, `voice_mod_kick`                                              | (broadcasts `voice_state`)                                                                                                                                    |
| Voice E2EE                       | `voice_e2ee_announce`, `voice_e2ee_offer`                                                                             | `voice_e2ee_announce` (broadcast), `voice_e2ee_offer` (relay)                                                                                                 |
| Calls                            | `call_ring`, `call_decline`                                                                                           | `call_incoming`, `call_declined`                                                                                                                              |
| DMs                              | —                                                                                                                     | `dm_channel_open`, `dm_channel_close`, `dm_request`                                                                                                           |
| Moderation queue/actions/appeals | —                                                                                                                     | `mod_queue`, `mod_action`, `appeal_status`                                                                                                                    |
| Plugins                          | `chat_command`                                                                                                        | `command_reply`, `plugin_broadcast` — declared by hand in `Server/ws/handlers_command.go`, outside the schema                                                 |

Full per-type payloads, permission gates, and rate limits are in [`docs/protocol.md`](docs/protocol.md).

### Sequencing, reconnect and replay

- Every broadcast gets the next value from an atomic `uint64` counter and is stored in an in-memory ring buffer (`event_persistence.replay_ring_size`, default 1000).
- On reconnect, the client sends `last_seq`; the server picks the cheapest of a 3-tier replay pipeline:

| Tier | Condition                                                                                      | Behavior                                                                | `replay_source` |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| 0    | `last_seq == 0`                                                                                | full flow: `auth_ok` + `ready` + `member_join` + `presence`             | `none`          |
| 1    | seq within the ring buffer                                                                     | `auth_ok` + missed events + `presence`, permission-filtered fail-closed | `buffer`        |
| 2    | seq within the persistent `events` table (`event_persistence.replay_cold_limit`, default 5000) | same replay flow, served from the cold tier                             | `db`            |
| 3    | too far behind, or channel visibility changed while disconnected                               | full flow fallback                                                      | `none`          |

- Ephemeral message types (`typing`, `presence_update`-triggered `presence`, `mod_queue`, `mod_action`, `appeal_status`, `nsfw_ack`, `dm_channel_open/close`, `dm_request`, `call_incoming/declined`) carry no `seq` and are never replayed; clients recover their state from the next `ready` or a targeted REST GET.
- `active_channel_id` in the `auth` frame lets a resuming client re-declare its focused channel without waiting for a post-`auth_ok` `channel_focus` round trip; clients should still send `channel_focus` for backward compatibility.

### Backpressure

Per `docs/architecture/websocket.md`: broadcasts fan out through per-topic pub/sub (global / `channel:N` / `voice:N` / `user:N`, each capped at 100 msg/s) into three per-client queues — `sendHigh` (64, DMs/mentions), `send` (256, chat/reactions), `sendLow` (64, typing/presence) — drained high-first by a `writePump`. A full high/normal queue **disconnects the client**, forcing it through the replay pipeline to restore consistency; a full low-priority queue **silently drops** the message, since typing/presence are lossy by design. The global broadcast channel (capacity 1024) drops with a counted metric when saturated.

## Protocol epoch and compatibility

- The wire protocol has one version number, the **epoch**: `protocol_epoch` in `protocol/schema.json`, generated into `ws.ProtocolEpoch` (server) and `PROTOCOL_EPOCH` (client).
- The client sends its `epoch` in the `auth` frame; the server accepts anything in `[min_epoch, server_epoch]` and refuses the rest with a structured `auth_error`:

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
- **A breaking change bumps the epoch** and sets `minClientEpoch` (`Server/ws/messages.go`) — the server accepts exactly one epoch by policy. Epoch 1 additionally accepts an absent `epoch` (read as 0) for pre-epoch clients.
- The server always upgrades first: a release's signed update manifest carries its `protocol_epoch`, and `GET /api/v1/client-update` never advertises a release whose epoch is newer than the running server's. A client refused with `protocol_epoch_unsupported` sees the regular update banner.

## MCP introspection

`tools/mcp-introspect/` is a development-only [MCP](https://modelcontextprotocol.io) server (not shipped in the product) that lets an agent inspect a locally running OwnCord instance over the same REST API:

- **`api_request`** — a generic passthrough: any HTTP method against any path on the local instance, authenticated with a bearer API token, returning `{status, headers, body}`. It has no write allowlist, so it can call destructive admin routes.
- **`server_logs`** — reads the server's in-memory log ring buffer (last 2000 records) via a ticketed Server-Sent-Events stream (`POST /admin/api/logs/ticket` then `GET /admin/api/logs/stream?ticket=...`), with optional `level`/`source` filters and a `follow_ms` live-tail window.

Setup: mint a token with `server token create --label mcp-introspect` (defaults to the owner account), set `OWNCORD_API_TOKEN`, and the server is registered in `.mcp.json`. TLS is handled by pinning the server's self-signed cert (`Server/data/cert.pem`) rather than trusting a CA, since the cert has no SAN. Full detail, troubleshooting and the underlying API-token schema: [`docs/mcp-introspect.md`](docs/mcp-introspect.md).

## Changing the API

**REST:** edit `Server/api/router.go` (routes/handlers), then regenerate the documentation:

```bash
cd Server && go run -tags otel,wazero ./cmd/gendocs
```

This rewrites the `<!-- gendocs:... -->` blocks in `docs/api.md`, `docs/schema.md` and `docs/server-configuration.md`. Never hand-edit inside a `gendocs:*` block — `make docs-verify` fails on drift.

**WebSocket:** most payload changes never touch the schema — see the `protocol-change` skill's routing table:

| Change                                                   | What to edit                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| New message type                                         | `protocol/schema.json`, then regenerate (below)                                                                |
| New/changed payload field on an existing type            | `Server/ws/command.go`/`messages.go`, `Client/src/lib/protocolTypes.ts`, `docs/protocol.md` — no schema change |
| Content inside an opaque blob the server relays verbatim | `docs/protocol.md` only                                                                                        |

For a new message type: edit `protocol/schema.json`, run `make protocol-generate` from `Server/`, and commit **both** generated outputs — `Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts` — together; committing only one is the usual mistake, and CI's `make protocol-verify` fails on either being stale. Neither generated file is ever hand-edited. A new message type also needs a handler registered in the `ws` dispatch table and a `ws.on(...)` subscription in `Client/src/lib/dispatcher.ts` — adding the schema entry alone does not make it work. Document the semantics in `docs/protocol.md`, since the schema carries names and shapes, not behavior.

## Sources

- [docs/api.md](docs/api.md)
- [docs/protocol.md](docs/protocol.md)
- [protocol/schema.json](protocol/schema.json)
- [Server/api/router.go](Server/api/router.go)
- [docs/architecture/websocket.md](docs/architecture/websocket.md)
- [docs/mcp-introspect.md](docs/mcp-introspect.md)
- [.claude/skills/protocol-change/SKILL.md](.claude/skills/protocol-change/SKILL.md)
- [Server/CLAUDE.md](Server/CLAUDE.md)
