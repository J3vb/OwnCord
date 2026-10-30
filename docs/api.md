# REST API Reference

OwnCord server REST API reference. All endpoints use the base URL `https://{server}:{port}/api/v1`.

---

## Authentication

All authenticated endpoints require a session token delivered via the `Authorization: Bearer {token}` header. Tokens are obtained from `POST /api/v1/auth/login`, `POST /api/v1/auth/register`, or `POST /api/v1/auth/verify-totp` after a partial 2FA challenge.

### Session Lifecycle

- Sessions are created on login/register and stored with a SHA-256 hash of the raw token, the client IP, User-Agent, and an expiry timestamp.
- Each authenticated request updates the session's `last_active` timestamp.
- Banned users are rejected at the middleware level with `403 FORBIDDEN`.

### Middleware Stack (all routes)

In mount order (`Server/api/router.go`):

1. **boundRequestID** -- drops an oversized (>128 bytes) or non-printable client-supplied `X-Request-Id` before chi adopts it.
2. **RequestID** (chi) -- assigns the request ID used in logs.
3. **setRequestIDHeader** -- echoes the request ID into the `X-Request-Id` response header.
4. **Recoverer** -- catches panics, logs them through `slog` with a stack capture, returns 500. On Windows a nil-dereference or invalid-address fault exits the process for a supervisor restart instead (SRE-08, [server-boundaries.md](architecture/server-boundaries.md)).
5. **Request Logger** -- structured logging of method, path, status, duration.
6. **Telemetry HTTP middleware** -- OpenTelemetry tracing; a no-op unless the server was built with `-tags otel` and telemetry is enabled.
7. **SecurityHeadersWithTLS** -- (adds `Strict-Transport-Security` when TLS is on) sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'self'`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cache-Control: no-store`.
8. **MaxBodySize** -- 1 MiB default for all routes except `/api/v1/uploads` (100 MiB, or `upload.max_size_mb` plus 1 MiB when larger), `/api/v1/admin/plugins/install` (16 MiB envelope), `/api/v1/users/me/avatar` and `/api/v1/dms/{id}/icon` (3 MiB envelope), `/api/v1/users/me/banner` (5 MiB envelope), and `/admin/api/discord-imports/upload` (`upload.import_max_mb`, 500 MiB by default).
9. **Coraza WAF** (optional) -- OWASP Core Rule Set request filtering, mounted only when `server.waf_enabled: true` (see `docs/server-configuration.md`).

Note: chi's `middleware.RealIP` is deliberately **not** used -- client IPs are resolved from `X-Forwarded-For` only when the peer is listed in `server.trusted_proxies`.

---

## Route index (generated)

<!-- gendocs:routes:start -->

Generated from the mounted router by `cd Server && go run -tags otel,wazero ./cmd/gendocs` — do not edit by hand; `make docs-verify` fails when it drifts. 248 routes, from the `otel,wazero` build with every optional family enabled (uploads, voice, the GIF proxy, the browser client portal, and telemetry with the Prometheus exporter, which is what mounts `/metrics`).

| Method  | Path                                                                 |
| ------- | -------------------------------------------------------------------- |
| GET     | `/`                                                                  |
| GET     | `/admin/`                                                            |
| GET     | `/admin/*`                                                           |
| PUT     | `/admin/api/afk-channel`                                             |
| GET     | `/admin/api/archive`                                                 |
| GET     | `/admin/api/archive/download`                                        |
| POST    | `/admin/api/archive/link`                                            |
| GET     | `/admin/api/attention`                                               |
| GET     | `/admin/api/audit-log`                                               |
| POST    | `/admin/api/backup`                                                  |
| GET     | `/admin/api/backups`                                                 |
| DELETE  | `/admin/api/backups/{name}`                                          |
| GET     | `/admin/api/backups/{name}/download`                                 |
| POST    | `/admin/api/backups/{name}/link`                                     |
| POST    | `/admin/api/backups/{name}/restore`                                  |
| GET     | `/admin/api/channels`                                                |
| POST    | `/admin/api/channels`                                                |
| GET     | `/admin/api/channels/categories`                                     |
| POST    | `/admin/api/channels/categories`                                     |
| PUT     | `/admin/api/channels/categories/order`                               |
| DELETE  | `/admin/api/channels/categories/{id}`                                |
| PATCH   | `/admin/api/channels/categories/{id}`                                |
| GET     | `/admin/api/channels/categories/{id}/permissions`                    |
| DELETE  | `/admin/api/channels/categories/{id}/permissions/{roleId}`           |
| PUT     | `/admin/api/channels/categories/{id}/permissions/{roleId}`           |
| DELETE  | `/admin/api/channels/categories/{id}/user-permissions/{userId}`      |
| PUT     | `/admin/api/channels/categories/{id}/user-permissions/{userId}`      |
| DELETE  | `/admin/api/channels/{id}`                                           |
| PATCH   | `/admin/api/channels/{id}`                                           |
| GET     | `/admin/api/channels/{id}/access/explain`                            |
| POST    | `/admin/api/channels/{id}/access/preview`                            |
| PUT     | `/admin/api/channels/{id}/forum`                                     |
| GET     | `/admin/api/channels/{id}/permissions`                               |
| POST    | `/admin/api/channels/{id}/permissions/sync`                          |
| DELETE  | `/admin/api/channels/{id}/permissions/{roleId}`                      |
| PUT     | `/admin/api/channels/{id}/permissions/{roleId}`                      |
| DELETE  | `/admin/api/channels/{id}/retention`                                 |
| PUT     | `/admin/api/channels/{id}/retention`                                 |
| DELETE  | `/admin/api/channels/{id}/user-permissions/{userId}`                 |
| PUT     | `/admin/api/channels/{id}/user-permissions/{userId}`                 |
| GET     | `/admin/api/config`                                                  |
| GET     | `/admin/api/config/settings`                                         |
| PATCH   | `/admin/api/config/settings`                                         |
| GET     | `/admin/api/discord-imports/latest`                                  |
| POST    | `/admin/api/discord-imports/upload`                                  |
| GET     | `/admin/api/discord-imports/{id}`                                    |
| POST    | `/admin/api/discord-imports/{id}/cancel`                             |
| DELETE  | `/admin/api/logs/level`                                              |
| GET     | `/admin/api/logs/level`                                              |
| PATCH   | `/admin/api/logs/level`                                              |
| GET     | `/admin/api/logs/stream`                                             |
| POST    | `/admin/api/logs/ticket`                                             |
| GET     | `/admin/api/me`                                                      |
| GET     | `/admin/api/registrations`                                           |
| POST    | `/admin/api/registrations/{id}/approve`                              |
| POST    | `/admin/api/registrations/{id}/deny`                                 |
| POST    | `/admin/api/restart`                                                 |
| GET     | `/admin/api/retention`                                               |
| GET     | `/admin/api/retention/channels`                                      |
| GET     | `/admin/api/retention/preview`                                       |
| POST    | `/admin/api/retention/preview`                                       |
| GET     | `/admin/api/roles`                                                   |
| POST    | `/admin/api/roles`                                                   |
| PATCH   | `/admin/api/roles/reorder`                                           |
| DELETE  | `/admin/api/roles/{id}`                                              |
| PATCH   | `/admin/api/roles/{id}`                                              |
| GET     | `/admin/api/settings`                                                |
| PATCH   | `/admin/api/settings`                                                |
| POST    | `/admin/api/setup`                                                   |
| GET     | `/admin/api/setup/status`                                            |
| GET     | `/admin/api/stats`                                                   |
| POST    | `/admin/api/support-bundles/download`                                |
| POST    | `/admin/api/support-bundles/preview`                                 |
| GET     | `/admin/api/tokens`                                                  |
| POST    | `/admin/api/tokens`                                                  |
| DELETE  | `/admin/api/tokens/{id}`                                             |
| GET     | `/admin/api/updates`                                                 |
| POST    | `/admin/api/updates/apply`                                           |
| GET     | `/admin/api/users`                                                   |
| DELETE  | `/admin/api/users/{id}`                                              |
| PATCH   | `/admin/api/users/{id}`                                              |
| POST    | `/admin/api/users/{id}/recovery-credential`                          |
| DELETE  | `/admin/api/users/{id}/roles/{roleId}`                               |
| PUT     | `/admin/api/users/{id}/roles/{roleId}`                               |
| DELETE  | `/admin/api/users/{id}/sessions`                                     |
| GET     | `/api/v1/admin/plugins/`                                             |
| POST    | `/api/v1/admin/plugins/install`                                      |
| DELETE  | `/api/v1/admin/plugins/{id}`                                         |
| POST    | `/api/v1/admin/plugins/{id}/disable`                                 |
| POST    | `/api/v1/admin/plugins/{id}/enable`                                  |
| POST    | `/api/v1/appeals/`                                                   |
| GET     | `/api/v1/appeals/mine`                                               |
| POST    | `/api/v1/appeals/{id}/withdraw`                                      |
| DELETE  | `/api/v1/auth/account`                                               |
| POST    | `/api/v1/auth/login`                                                 |
| POST    | `/api/v1/auth/logout`                                                |
| GET     | `/api/v1/auth/me`                                                    |
| POST    | `/api/v1/auth/recover`                                               |
| POST    | `/api/v1/auth/register`                                              |
| POST    | `/api/v1/auth/verify-totp`                                           |
| GET     | `/api/v1/blocks/`                                                    |
| DELETE  | `/api/v1/blocks/{userId}`                                            |
| PUT     | `/api/v1/blocks/{userId}`                                            |
| GET     | `/api/v1/channels/`                                                  |
| GET     | `/api/v1/channels/{id}/media`                                        |
| GET     | `/api/v1/channels/{id}/media/months`                                 |
| GET     | `/api/v1/channels/{id}/messages`                                     |
| GET     | `/api/v1/channels/{id}/messages/around/{messageId}`                  |
| POST    | `/api/v1/channels/{id}/messages/purge`                               |
| GET     | `/api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users` |
| DELETE  | `/api/v1/channels/{id}/nsfw-acknowledgement/`                        |
| PUT     | `/api/v1/channels/{id}/nsfw-acknowledgement/`                        |
| GET     | `/api/v1/channels/{id}/pins`                                         |
| DELETE  | `/api/v1/channels/{id}/pins/{messageId}`                             |
| POST    | `/api/v1/channels/{id}/pins/{messageId}`                             |
| GET     | `/api/v1/channels/{id}/threads`                                      |
| GET     | `/api/v1/client-update/{target}/{current_version}`                   |
| GET     | `/api/v1/diagnostics/connectivity`                                   |
| GET     | `/api/v1/dm-requests/`                                               |
| POST    | `/api/v1/dm-requests/{id}/accept`                                    |
| POST    | `/api/v1/dm-requests/{id}/block`                                     |
| POST    | `/api/v1/dm-requests/{id}/delete`                                    |
| POST    | `/api/v1/dm-requests/{id}/ignore`                                    |
| GET     | `/api/v1/dms/`                                                       |
| POST    | `/api/v1/dms/`                                                       |
| POST    | `/api/v1/dms/group`                                                  |
| DELETE  | `/api/v1/dms/{channelId}`                                            |
| PATCH   | `/api/v1/dms/{channelId}`                                            |
| DELETE  | `/api/v1/dms/{channelId}/icon`                                       |
| POST    | `/api/v1/dms/{channelId}/icon`                                       |
| POST    | `/api/v1/dms/{channelId}/members`                                    |
| DELETE  | `/api/v1/dms/{channelId}/members/{userId}`                           |
| PUT     | `/api/v1/dms/{channelId}/owner`                                      |
| GET     | `/api/v1/emoji/`                                                     |
| POST    | `/api/v1/emoji/`                                                     |
| DELETE  | `/api/v1/emoji/{id}`                                                 |
| GET     | `/api/v1/emoji/{id}/image`                                           |
| GET     | `/api/v1/external/image`                                             |
| GET     | `/api/v1/external/preview`                                           |
| GET     | `/api/v1/files/{id}`                                                 |
| POST    | `/api/v1/files/{id}/link`                                            |
| GET     | `/api/v1/files/{id}/thumb`                                           |
| DELETE  | `/api/v1/gif/favorites`                                              |
| GET     | `/api/v1/gif/favorites`                                              |
| PUT     | `/api/v1/gif/favorites`                                              |
| GET     | `/api/v1/gif/search`                                                 |
| GET     | `/api/v1/gif/trending`                                               |
| GET     | `/api/v1/health`                                                     |
| GET     | `/api/v1/info`                                                       |
| GET     | `/api/v1/invites/`                                                   |
| POST    | `/api/v1/invites/`                                                   |
| DELETE  | `/api/v1/invites/{code}`                                             |
| GET     | `/api/v1/invites/{code}/redemptions`                                 |
| GET     | `/api/v1/livekit/health`                                             |
| POST    | `/api/v1/livekit/webhook`                                            |
| GET     | `/api/v1/metrics`                                                    |
| GET     | `/api/v1/metrics/prometheus`                                         |
| GET     | `/api/v1/moderation/appeals/`                                        |
| GET     | `/api/v1/moderation/appeals/{id}`                                    |
| POST    | `/api/v1/moderation/appeals/{id}/assign`                             |
| POST    | `/api/v1/moderation/appeals/{id}/decide`                             |
| POST    | `/api/v1/moderation/channels/`                                       |
| GET     | `/api/v1/moderation/channels/categories`                             |
| POST    | `/api/v1/moderation/channels/categories`                             |
| PUT     | `/api/v1/moderation/channels/categories/order`                       |
| DELETE  | `/api/v1/moderation/channels/categories/{id}`                        |
| PATCH   | `/api/v1/moderation/channels/categories/{id}`                        |
| DELETE  | `/api/v1/moderation/channels/{id}`                                   |
| PATCH   | `/api/v1/moderation/channels/{id}`                                   |
| PUT     | `/api/v1/moderation/channels/{id}/forum`                             |
| GET     | `/api/v1/moderation/members/`                                        |
| PATCH   | `/api/v1/moderation/members/{id}`                                    |
| DELETE  | `/api/v1/moderation/members/{id}/roles/{roleId}`                     |
| PUT     | `/api/v1/moderation/members/{id}/roles/{roleId}`                     |
| DELETE  | `/api/v1/moderation/members/{id}/sessions`                           |
| GET     | `/api/v1/moderation/queue/`                                          |
| GET     | `/api/v1/moderation/queue/{id}`                                      |
| POST    | `/api/v1/moderation/queue/{id}/act`                                  |
| POST    | `/api/v1/moderation/queue/{id}/assign`                               |
| POST    | `/api/v1/moderation/queue/{id}/close`                                |
| POST    | `/api/v1/moderation/queue/{id}/notes`                                |
| GET     | `/api/v1/moderation/users/{id}/actions`                              |
| PUT     | `/api/v1/moderation/users/{id}/nickname`                             |
| POST    | `/api/v1/moderation/users/{id}/timeout`                              |
| POST    | `/api/v1/moderation/users/{id}/untimeout`                            |
| POST    | `/api/v1/moderation/users/{id}/warn`                                 |
| GET     | `/api/v1/push/subscriptions`                                         |
| POST    | `/api/v1/push/subscriptions`                                         |
| DELETE  | `/api/v1/push/subscriptions/{id}`                                    |
| GET     | `/api/v1/push/vapid`                                                 |
| POST    | `/api/v1/reports/`                                                   |
| GET     | `/api/v1/reports/mine`                                               |
| GET     | `/api/v1/search`                                                     |
| GET     | `/api/v1/server-info`                                                |
| GET     | `/api/v1/stickers/`                                                  |
| POST    | `/api/v1/stickers/`                                                  |
| DELETE  | `/api/v1/stickers/{id}`                                              |
| PATCH   | `/api/v1/stickers/{id}`                                              |
| GET     | `/api/v1/stickers/{id}/image`                                        |
| POST    | `/api/v1/uploads`                                                    |
| DELETE  | `/api/v1/uploads/{id}`                                               |
| PATCH   | `/api/v1/users/me/`                                                  |
| DELETE  | `/api/v1/users/me/avatar`                                            |
| POST    | `/api/v1/users/me/avatar`                                            |
| DELETE  | `/api/v1/users/me/banner`                                            |
| POST    | `/api/v1/users/me/banner`                                            |
| GET     | `/api/v1/users/me/moderation`                                        |
| GET     | `/api/v1/users/me/notes/{userId}`                                    |
| PUT     | `/api/v1/users/me/notes/{userId}`                                    |
| POST    | `/api/v1/users/me/notices/{id}/ack`                                  |
| PUT     | `/api/v1/users/me/password`                                          |
| GET     | `/api/v1/users/me/privacy`                                           |
| PUT     | `/api/v1/users/me/privacy`                                           |
| GET     | `/api/v1/users/me/recovery-kit`                                      |
| POST    | `/api/v1/users/me/recovery-kit`                                      |
| DELETE  | `/api/v1/users/me/sessions`                                          |
| GET     | `/api/v1/users/me/sessions`                                          |
| DELETE  | `/api/v1/users/me/sessions/{id}`                                     |
| GET     | `/api/v1/users/me/storage`                                           |
| DELETE  | `/api/v1/users/me/totp`                                              |
| POST    | `/api/v1/users/me/totp/confirm`                                      |
| POST    | `/api/v1/users/me/totp/enable`                                       |
| POST    | `/api/v1/users/me/totp/recovery-codes`                               |
| GET     | `/api/v1/users/me/uploads`                                           |
| DELETE  | `/api/v1/users/me/uploads/{id}`                                      |
| GET     | `/api/v1/ws`                                                         |
| GET     | `/assets/*`                                                          |
| GET     | `/health`                                                            |
| CONNECT | `/livekit/*`                                                         |
| DELETE  | `/livekit/*`                                                         |
| GET     | `/livekit/*`                                                         |
| HEAD    | `/livekit/*`                                                         |
| OPTIONS | `/livekit/*`                                                         |
| PATCH   | `/livekit/*`                                                         |
| POST    | `/livekit/*`                                                         |
| PUT     | `/livekit/*`                                                         |
| QUERY   | `/livekit/*`                                                         |
| TRACE   | `/livekit/*`                                                         |
| CONNECT | `/metrics/*`                                                         |
| DELETE  | `/metrics/*`                                                         |
| GET     | `/metrics/*`                                                         |
| HEAD    | `/metrics/*`                                                         |
| OPTIONS | `/metrics/*`                                                         |
| PATCH   | `/metrics/*`                                                         |
| POST    | `/metrics/*`                                                         |
| PUT     | `/metrics/*`                                                         |
| QUERY   | `/metrics/*`                                                         |
| TRACE   | `/metrics/*`                                                         |

<!-- gendocs:routes:end -->

---

## Standard Error Response

Error responses use this JSON envelope:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable detail"
}
```

### Error Codes

Every code a reply can carry is listed in `error_codes.rest` of
`protocol/schema.json`. The server spells each one as its generated constant
(`httperr.Code`, in `Server/httperr/codes.go`) and the client gets the same
list as `RestErrorCode` in `Client/src/lib/protocolTypes.ts`. A code is never
renamed once shipped, because clients compare it. The common ones:

| Code                            | HTTP Status | When It Occurs                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                  | 401         | Missing/invalid/expired session token                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `INVALID_CREDENTIALS`           | 401         | Login/register with bad username/password/invite (generic to prevent enumeration)                                                                                                                                                                                                                                                                                                                                                                                          |
| `FORBIDDEN`                     | 403         | Insufficient permissions, banned account, or admin IP restriction                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TIMED_OUT`                     | 403         | The caller has an active moderator timeout and the action is one it refuses (B5-9) — see `POST /api/v1/moderation/users/{id}/timeout` for the full list                                                                                                                                                                                                                                                                                                                    |
| `NOT_FOUND`                     | 404         | Resource (channel, message, user, invite, file, backup) not found                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RATE_LIMITED`                  | 429         | Too many requests; `Retry-After` header gives the seconds left until a retry is allowed                                                                                                                                                                                                                                                                                                                                                                                    |
| `AUTH_BUSY`                     | 429         | The bounded queue for password checks is full, or the request gave up waiting in it; nothing was checked or counted. Login, register and verify-totp set `Retry-After`                                                                                                                                                                                                                                                                                                     |
| `INVALID_INPUT` / `BAD_REQUEST` | 400         | Missing required fields, invalid query params, a non-positive or non-numeric id in a path (emoji and sticker image routes answer 404 instead), or a file over the upload size limit. A JSON body that does not decode (an empty one included where the body is required) is always `400 INVALID_INPUT` "malformed request body" on the `/api/v1` routes and `400 BAD_REQUEST` "malformed request body" under `/admin/api` and `/api/v1/moderation/members` and `/channels` |
| `PAYLOAD_TOO_LARGE`             | 413         | A JSON body past its route's size cap (every route that reads JSON, `/admin/api` included), or an upload body padded past its cap, the plugin-install upload included                                                                                                                                                                                                                                                                                                      |
| `UNSUPPORTED_MEDIA_TYPE`        | 415         | A plugin upload whose file part is labelled as something other than a `.zip`                                                                                                                                                                                                                                                                                                                                                                                               |
| `CONFLICT`                      | 409         | Duplicate username on register, or server already up-to-date on update                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DUPLICATE_REPORT`              | 409         | The reporter already has an open or assigned report against this exact target (B5-8)                                                                                                                                                                                                                                                                                                                                                                                       |
| `ALREADY_DELETED`               | 409         | The target of a removal was already soft-deleted, e.g. the author deleted the reported message first (B9-14)                                                                                                                                                                                                                                                                                                                                                               |
| `ALREADY_APPEALED`              | 409         | An appeal against this moderation action already exists, in any state — decided appeals can never be re-appealed (B5-10)                                                                                                                                                                                                                                                                                                                                                   |
| `SELF_REVIEW`                   | 403         | A moderator acting on their own filed report, deciding/assigning the appeal of an action they themselves took where another eligible moderator exists, or being that appeal's own appellant (B5-8/B5-10)                                                                                                                                                                                                                                                                   |
| `REVERSAL_FAILED`               | 409         | Overturning an appeal hit a genuine error applying its ledger reversal — nothing committed, including the decision itself (B5-10)                                                                                                                                                                                                                                                                                                                                          |
| `INTERNAL_ERROR`                | 500         | Internal server error                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `STORAGE_ERROR`                 | 507         | Upload could not be persisted (storage backend write failure)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `BAD_GATEWAY`                   | 502         | Upstream failure (GitHub API, LiveKit, GIF provider, asset download)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GIF_DISABLED`                  | 503         | GIF proxy is not configured on this server (no `gif.api_key`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GIF_FAVORITES_FULL`            | 409         | You have reached the favorite GIF limit (250)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUSH_DISABLED`                 | 503         | Web Push is not enabled on this server (`push.enabled` is false)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PLUGINS_DISABLED`              | 503         | A plugin install, enable, disable or uninstall on a server whose plugin runtime is off                                                                                                                                                                                                                                                                                                                                                                                     |
| `SERVICE_UNAVAILABLE`           | 503         | The request ran past the server's 15 s request deadline and failed (`Retry-After: 2`; see Request deadline below), or the auth store was unavailable while resolving a token                                                                                                                                                                                                                                                                                               |
| `UPDATE_CHECK_FAILED`           | 502         | The release lookup or its signature fetch failed (client-update route and admin update check)                                                                                                                                                                                                                                                                                                                                                                              |
| `NSFW_ACKNOWLEDGEMENT_REQUIRED` | 403         | Content from a labelled channel requested before the caller acknowledged it (history, around, pins, reaction users, search, attachment bytes — B5-7)                                                                                                                                                                                                                                                                                                                       |
| `NOT_NSFW`                      | 409         | `PUT /api/v1/channels/{id}/nsfw-acknowledgement` on a channel that is not labelled                                                                                                                                                                                                                                                                                                                                                                                         |
| `CHANNEL_NAME_TAKEN`            | 409         | Admin channel create or rename onto a name the same type already has in that category                                                                                                                                                                                                                                                                                                                                                                                      |
| `CATEGORY_NAME_TAKEN`           | 409         | Category create or rename onto a name another category already has, ignoring case                                                                                                                                                                                                                                                                                                                                                                                          |
| `CATEGORY_LIST_STALE`           | 409         | `PUT .../categories/order` with an id set that is not exactly the current set of categories; nothing is written                                                                                                                                                                                                                                                                                                                                                            |
| `PERMISSIONS_CHANGED`           | 409         | A channel sync found override rows it had not checked (they changed under it); nothing is written, retry                                                                                                                                                                                                                                                                                                                                                                   |

### Request deadline

Every REST route except the streaming and long-running ones carries a 15 s
deadline on its request context. A handler that answers 500 or 503 after that
deadline passed (a database call cancelled behind a stalled writer, say) is
answered `503 {"error":"SERVICE_UNAVAILABLE","message":"the server is busy; try again"}` with `Retry-After: 2` in place
of its own error body; a retry is safe, as the server finishes or undoes any partial step.
The clock starts when the request arrives, so it includes reading the request
body. Any other status, including a 2xx written after the deadline and a
specific 5xx such as 502 or 507, is never rewritten. Exempt, with no deadline of their own beyond the transfer and
archive progress deadlines: the WebSocket upgrade, the LiveKit proxy, file
uploads and downloads, avatar, banner, emoji and group-icon uploads, client-update, the admin
log stream, archive, backup, restore, update-apply and restart routes, the Discord import upload, plugin
install, enable and disable, and account erasure.

---

## Auth Endpoints

### POST /api/v1/auth/register

Create a new account. What it takes depends on the server's `registration_mode`
setting (B4-1; the admin panel's Settings page, or the setup wizard):

| Mode       | Behaviour                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`   | Every request is refused with `403` before the body is read.                                                                                                                     |
| `invite`   | The default. A valid, unexpired, unrevoked invite with remaining uses is required and consumed. `201` with a session.                                                            |
| `approval` | No invite. The account is created locked and answers `202`; it cannot sign in (`403 account is awaiting approval`) until an admin approves it in the admin panel's Members page. |
| `open`     | No invite. `201` with a session.                                                                                                                                                 |

`approval` and `open` also budget 5 registrations per client address per 24
hours, and `approval` caps the pending queue at 100 applications; both refusals
are `429 RATE_LIMITED`. A fresh install is `invite`; an upgraded server keeps
its former `registration_open` choice as `invite` (1) or `closed` (0), never
`open`. The first user is created via `/admin/api/setup` instead.

**Auth:** None (public)
**Rate limit:** 3 requests/minute per IP

#### Request

```json
{
  "username": "alex",
  "password": "MyStr0ng!Pass",
  "invite_code": "abc123def"
}
```

| Field         | Type   | Required         | Notes                                                                                                                                                                                                                                                                                                                     |
| ------------- | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `username`    | string | Yes              | HTML-stripped, trimmed, 2–32 characters. Letters (any script), digits, `_`, `.` and `-` only; a combining accent may follow a letter (at most 2 in a row). No spaces, must start with a letter or digit; `everyone` and `here` are reserved. Login and recovery do not apply these rules, so older accounts keep working. |
| `password`    | string | Yes              | Validated for strength (min length, complexity).                                                                                                                                                                                                                                                                          |
| `invite_code` | string | In `invite` mode | Must be a valid, non-expired, non-revoked invite with remaining uses. Ignored in `approval` and `open` mode.                                                                                                                                                                                                              |

#### Response 201 Created

```json
{
  "token": "raw-session-token-64-chars",
  "user": {
    "id": 2,
    "username": "alex",
    "avatar": "",
    "display_name": null,
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

#### Response 202 Accepted (`approval` mode)

```json
{ "status": "pending_approval" }
```

No session is issued. The applicant signs in normally once approved; a denied
application is anonymised and locked, and its username is released.

#### Errors

| Status | Code                  | Cause                                                                                                                   |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`       | Missing username or password, or weak password                                                                          |
| 400    | `INVALID_CREDENTIALS` | In `invite` mode: missing or bad invite code, expired/revoked invite; any mode: duplicate username                      |
| 403    | `FORBIDDEN`           | Registration is closed or unavailable while server-wide 2FA is required                                                 |
| 429    | `RATE_LIMITED`        | Exceeded 3 registrations/minute from this IP; in `approval`/`open` mode, 5 per address per day or a full approval queue |
| 429    | `AUTH_BUSY`           | The password-hashing queue is full (`Retry-After` set)                                                                  |
| 500    | `INTERNAL_ERROR`      | Hashing failure, session creation failure, or DB error                                                                  |

---

### POST /api/v1/auth/recover

Recover an account with its recovery kit (B4-5, BPR-044; owner decision 2)
in `kit_secret`, or with an owner-issued credential (B4-6, BPR-045; owner
decision 3) in `credential` — the two are told apart by shape (32 and 24
characters), so one compare per attempt runs against the right verifier and
the paths never interfere. Using either means "I lost my devices": on success
the password is replaced by `new_password`, every existing session and API
token is revoked, the kit is spent (or the credential consumed) and a
`recovery_kit_used` / `recovery_assist_used` audit row is written — all in
one transaction — and a fresh session is issued **without** the second
factor, so an account with 2FA enrolled signs in from this response and can
disable or re-enrol 2FA in Settings. A spent kit is worthless; the holder
issues a new one while signed in. A kit recovery withdraws an outstanding
credential; a credential recovery leaves the kit enrolled.

Every failure — unknown account, no live kit or credential, a wrong secret —
is the same `401` and costs the same argon2id compare. Five failures against an
account or from one address lock recovery for 15 minutes; the per-account
lockout is audited (`recovery_kit_locked`).

**Auth:** None (public)
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{ "username": "alex", "kit_secret": "K7QF-3M2X-…-ZB5A", "new_password": "N3w-Str0ng!Pass" }
```

or, with an owner-issued credential:

```json
{
  "username": "alex",
  "credential": "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y",
  "new_password": "N3w-Str0ng!Pass"
}
```

#### Response 200 OK

The login shape: `token` and `user`, `requires_2fa` false.

#### Errors

| Status | Code                  | Cause                                                       |
| ------ | --------------------- | ----------------------------------------------------------- |
| 400    | `INVALID_INPUT`       | A field missing, or a weak new password                     |
| 401    | `INVALID_CREDENTIALS` | Unknown account, no live kit or credential, or wrong secret |
| 403    | `FORBIDDEN`           | The account is banned                                       |
| 429    | `RATE_LIMITED`        | Recovery lockout                                            |
| 429    | `AUTH_BUSY`           | The admission budget is full                                |

---

### POST /api/v1/auth/login

Authenticate with username and password.

**Auth:** None (public)
**Rate limit:** 5 requests/minute per IP. After 10 failed attempts within 15 minutes from the same IP, the IP is locked out for 15 minutes. Independently, 10 failed attempts against the same username (from any IP) lock that account out for 15 minutes, except for an address that signed in to that account in the last 24 hours. Lockouts are persisted to the database and survive server restarts; the 24-hour exemption is held in memory and does not.

#### Request

```json
{
  "username": "alex",
  "password": "MyStr0ng!Pass"
}
```

#### Response 200 OK

If the account does not have TOTP enabled:

```json
{
  "token": "raw-session-token-64-chars",
  "requires_2fa": false,
  "user": {
    "id": 1,
    "username": "alex",
    "avatar": "/api/v1/files/uuid",
    "display_name": "Alex",
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

If the account has TOTP enabled:

```json
{
  "partial_token": "opaque-partial-token",
  "requires_2fa": true
}
```

#### Errors

| Status | Code             | Cause                                                                                                                  |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`  | Missing username or password                                                                                           |
| 401    | `UNAUTHORIZED`   | Wrong username or password                                                                                             |
| 403    | `FORBIDDEN`      | Account is banned/suspended                                                                                            |
| 429    | `RATE_LIMITED`   | IP locked out after 10 consecutive failures (15 min cooldown)                                                          |
| 429    | `AUTH_BUSY`      | Too many logins in progress: the queue for password checks is full, or the login waited 10 s in it (`Retry-After` set) |
| 500    | `INTERNAL_ERROR` | Session creation failure                                                                                               |

---

### POST /api/v1/auth/verify-totp

Complete a TOTP login challenge started by `POST /api/v1/auth/login`.

**Auth:** Required with the `partial_token` from the login response
**Rate limit:** 10 requests/minute per IP, plus a 5-attempt budget per partial challenge

`code` is a six-digit authenticator code, or one of the account's emergency
recovery codes (`XXXXX-XXXXX`, case-insensitive, separator optional). A
recovery code is accepted once; the success response then carries
`recovery_codes_remaining` so the client can prompt for regeneration. Either
kind counts against the same attempt budget when wrong.

#### Request

```json
{
  "code": "123456"
}
```

#### Response 200 OK

```json
{
  "token": "raw-session-token-64-chars",
  "requires_2fa": false,
  "user": {
    "id": 1,
    "username": "alex",
    "avatar": "/api/v1/files/uuid",
    "display_name": "Alex",
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": true,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

#### Errors

| Status | Code             | Cause                                                                                           |
| ------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`  | Malformed request body                                                                          |
| 401    | `UNAUTHORIZED`   | Missing/expired challenge, invalid TOTP code, or challenge consumed                             |
| 429    | `AUTH_BUSY`      | A recovery code could not be checked: the queue for password checks is full (`Retry-After` set) |
| 500    | `INTERNAL_ERROR` | Session creation failure                                                                        |

---

### GET /api/v1/auth/me

Get the current authenticated user's profile.

**Auth:** Required (Bearer token)

#### Response 200 OK

```json
{
  "id": 1,
  "username": "alex",
  "avatar": "/api/v1/files/uuid",
  "display_name": "Alex",
  "about": "A short bio.",
  "banner": "/api/v1/files/uuid",
  "banner_color": "#5865f2",
  "custom_status": "building things",
  "custom_status_expires_at": "2026-10-15T18:00:00Z",
  "status": "online",
  "role_id": 2,
  "totp_enabled": true,
  "created_at": "2026-03-24T12:00:00Z"
}
```

This is the canonical **user object**, also returned as `user` by register,
login and the TOTP challenge.

| Field                      | Type         | Description                                                                                                                                                                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | int64        | User ID                                                                                                                                                                                                           |
| `username`                 | string       | Unique handle; the name `@mentions` resolve against                                                                                                                                                               |
| `avatar`                   | string       | Avatar URL (`/api/v1/files/{id}` after an upload, or an `https://` URL), or empty string                                                                                                                          |
| `display_name`             | string\|null | Nickname rendered instead of `username`; null when unset                                                                                                                                                          |
| `about`                    | string\|null | Profile bio, max 300 characters; null when unset                                                                                                                                                                  |
| `banner`                   | string\|null | Profile banner image path (`/api/v1/files/{id}`), set with `POST /api/v1/users/me/banner`; null when unset                                                                                                        |
| `banner_color`             | string\|null | Profile banner colour, `#rgb` or `#rrggbb` in lower case; null when unset                                                                                                                                         |
| `custom_status`            | string\|null | Free-text status line, max 128 characters, one line (no control characters, line breaks, invisible characters or stacked combining marks); null when unset. Set over WebSocket (`presence_update`), not over REST |
| `custom_status_expires_at` | string\|null | RFC 3339 UTC instant the custom status clears itself; null when it has no expiry. Set with `presence_update`'s `custom_status_expires_in`; only the owner is told it                                              |
| `status`                   | string       | One of: `online`, `idle`, `dnd`, `invisible`, `offline`. **This is the caller's own true status**, so `invisible` appears here; every payload describing this user to _anyone else_ reports `offline` instead     |
| `role_id`                  | int64        | Numeric role ID (1=Owner, 2=Admin, 3=Moderator, 4=Member)                                                                                                                                                         |
| `totp_enabled`             | bool         | Whether the user has a confirmed TOTP secret                                                                                                                                                                      |
| `created_at`               | string       | ISO 8601 timestamp                                                                                                                                                                                                |

---

### POST /api/v1/auth/logout

Invalidate the current session token.

**Auth:** Required (Bearer token)

#### Response 204 No Content

---

### DELETE /api/v1/auth/account

Erase the authenticated user's account (B4-9, BPR-052). Requires password
confirmation. Every row attributable to the account is hard-deleted in one
transaction — the account itself, its messages (channel history shows
nothing where they were) and their search-index entries, reactions,
mentions, uploads and the avatar, DM membership, invites it created, blocks,
channel overrides, sessions, API tokens, second-factor and recovery
material, and its replay events — with SQLite's `secure_delete` on for the
transaction; custom emoji it uploaded stay, reassigned to the oldest
remaining admin-class account. Its files are removed after the commit from a
journal (`erasure_jobs`) that survives a restart and is resumed until every
file is gone. The last admin-class account cannot be erased. Connected
clients receive `member_ban` and the account's own socket is closed.

**Auth:** Required (Bearer token)
**Rate limit:** 5 requests/minute per IP. After 3 failed password attempts, the endpoint locks out for 15 minutes per user.

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 204 No Content

The account is erased. The response is sent once the database transaction
has committed; if a file could not be removed yet, the journal finishes it on
the next maintenance tick.

#### Errors

| Status | Code             | Cause                                                         |
| ------ | ---------------- | ------------------------------------------------------------- |
| 400    | `INVALID_INPUT`  | Missing or incorrect password                                 |
| 403    | `FORBIDDEN`      | Cannot delete the last admin account                          |
| 429    | `RATE_LIMITED`   | Locked out after 3 failed password attempts (15 min cooldown) |
| 429    | `AUTH_BUSY`      | The admission budget for password checks is full              |
| 500    | `INTERNAL_ERROR` | Database error during deletion                                |

---

### POST /api/v1/users/me/totp/enable

Start TOTP enrollment for the authenticated user. The secret is not persisted until `/api/v1/users/me/totp/confirm` succeeds; the pending enrollment survives a server restart for its ten-minute lifetime.

`backup_codes` are the account's ten emergency recovery codes, shown here and
nowhere else again: the server keeps bcrypt hashes only. They become usable
the moment `confirm` succeeds, each once, in place of a TOTP code at
`POST /api/v1/auth/verify-totp`. Calling `enable` again replaces the set;
disabling 2FA removes it.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 200 OK

```json
{
  "qr_uri": "otpauth://totp/OwnCord:alex?...",
  "backup_codes": ["7KQ3M-RX2WN", "…nine more…"]
}
```

---

### POST /api/v1/users/me/totp/confirm

Confirm a pending TOTP enrollment. On success the account's other sessions are
revoked, and its live WebSocket closes in the same request if it rode one of
them.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass",
  "code": "123456"
}
```

#### Response 204 No Content

---

### DELETE /api/v1/users/me/totp

Disable TOTP for the authenticated user. The account's recovery codes are removed with the secret, and its other sessions are revoked; the account's live WebSocket closes in the same request if it rode one of them.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 204 No Content

---

### POST /api/v1/users/me/totp/recovery-codes

Replace the account's emergency recovery codes with a fresh set. The
previous set is invalid the moment the new one is stored. Requires 2FA to be
enabled (`409 CONFLICT` otherwise) and writes a `recovery_codes_regenerated`
audit row that carries no code.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 200 OK

```json
{
  "backup_codes": ["7KQ3M-RX2WN", "…nine more…"]
}
```

---

### POST /api/v1/users/me/recovery-kit

Issue the account's recovery kit (B4-5, BPR-044), replacing any previous
one. The server stores only an argon2id verifier of the kit secret. With no
`kit_secret` in the body the server generates the secret and returns it
**once**; with one, the client generated it locally (32 base32 characters,
any grouping or case) and the response never echoes it. Writes a
`recovery_kit_issued` audit row that carries no secret.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{ "password": "MyStr0ng!Pass" }
```

#### Response 200 OK

```json
{ "kit_secret": "K7QF-3M2X-…-ZB5A", "created_at": "2026-09-02T18:00:00Z" }
```

`kit_secret` is absent when the client supplied the secret.

#### Errors

| Status | Code            | Cause                                                 |
| ------ | --------------- | ----------------------------------------------------- |
| 400    | `INVALID_INPUT` | Wrong password, or a client secret of the wrong shape |
| 429    | `RATE_LIMITED`  | Password-confirmation lockout                         |
| 429    | `AUTH_BUSY`     | The admission budget is full                          |

---

### GET /api/v1/users/me/recovery-kit

Whether the account holds an unspent kit — what a client needs to decide to
(re-)enrol, never the verifier.

**Auth:** Required

#### Response 200 OK

```json
{ "enrolled": true, "created_at": "2026-09-02T18:00:00Z", "used_at": null }
```

---

## User Profile & Sessions

### PATCH /api/v1/users/me

Update the authenticated user's profile. Broadcasts a `user_update` WebSocket
message to all clients on success, carrying the full profile snapshot (the
event replaces the client's copy rather than patching it).

**Auth:** Required
**Rate limit:** 10 requests/minute

#### Request

```json
{
  "username": "newname",
  "avatar": "https://example.com/pic.png",
  "display_name": "New Name",
  "about": "A short bio.",
  "banner_color": "#5865f2"
}
```

| Field                 | Rules                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `username`            | Required. The unique handle; `@mentions` resolve against it. A changed name must follow the registration rules (2–32 characters; letters, digits, `_`, `.`, `-`; no spaces; starts with a letter or digit; `everyone` and `here` reserved). Resending your current name is not a rename.                                   |
| `avatar`              | Optional. Must be an `https://` URL (max 512 chars) or `""` to clear. An avatar on the server's own host must be `/api/v1/files/<uuid>`; any other same-host path is rejected with 400. Upload a file instead with `POST /api/v1/users/me/avatar`.                                                                         |
| `display_name`        | Optional, 1–32 characters, counted after runs of spaces are collapsed to one. Shown instead of `username` everywhere; `""` clears it and falls back to the username. Rejected if it contains control characters or line breaks, invisible (bidi-override, zero-width) characters, or more than 2 combining marks in a row. |
| `about`               | Optional, max 300 characters. `""` clears it.                                                                                                                                                                                                                                                                              |
| `banner_color`        | Optional, `#rgb` or `#rrggbb` (case-insensitive; stored lower-case). `""` clears it. There is deliberately no banner id or URL field: a banner image can only be set by uploading it with `POST /api/v1/users/me/banner`.                                                                                                  |
| `identity_public_key` | Optional, base64, max 128 characters. Publishes the client's long-term E2EE identity public key for voice TOFU pinning (see [protocol.md](protocol.md), Voice End-to-End Encryption).                                                                                                                                      |

Omitting a field leaves it unchanged; sending `""` clears the nullable ones.
`display_name` and `about` are HTML-sanitized and trimmed server-side, and the
length caps count characters, not bytes.

While a moderator timeout is active on your account, a `display_name` or
`username` that differs from your current one is refused with `403`
`TIMED_OUT`, and the whole request is not applied. Resending the current
values with other changes still works. A `display_name` that equals another
account's username is refused with `400` (ignoring ASCII letter case, the rule
usernames themselves use); your own username is allowed.

#### Response 200 OK

Returns the updated user object (same shape as `GET /api/v1/auth/me`).

---

### POST /api/v1/users/me/avatar

Upload an avatar image and point the authenticated user's avatar at it.
Broadcasts a `user_update` on success, exactly like the PATCH above.

The bytes are stored as an ordinary attachment with no channel, and
`users.avatar` is set to `/api/v1/files/{id}`. That URL is what makes the
picture readable: `GET /api/v1/files/{id}` normally serves an unlinked
attachment only to its uploader (administrators included), and additionally admits one that some user's
avatar currently points at — so an avatar is readable by every authenticated
user for exactly as long as it is in use, and stops being readable the moment
it is replaced. If the profile update fails after the bytes were stored, the
unlinked attachment row and the stored file are removed and the user's storage
counter is recounted, so a failed avatar change does not leave a charge behind.

Not registered when the server has no working storage backend.

**Auth:** Required
**Rate limit:** 5 uploads/minute per user

#### Request

`multipart/form-data` with a single `file` part.

| Rule       | Value                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Type       | `image/png`, `image/jpeg`, `image/webp` or `image/gif`, sniffed from the file's own bytes (the client's `Content-Type` is ignored) |
| Size       | 2 MiB                                                                                                                              |
| Dimensions | 1024x1024, measured from the sniffed image                                                                                         |

An animated GIF, WebP or PNG is accepted as-is (WP 8.7): clients show its first
frame and play it on hover, never under reduced motion. SVG is refused — it is
markup with script and external-fetch capability, and an avatar is rendered
inline by definition. The server does not re-encode or crop; the client is
expected to downscale a still picture before uploading.

#### Response 201 Created

```json
{
  "id": "5f2c...",
  "filename": "me.png",
  "size": 20481,
  "mime": "image/png",
  "url": "/api/v1/files/5f2c...",
  "width": 256,
  "height": 256
}
```

#### Errors

| Status | Code           | Cause                                                          |
| ------ | -------------- | -------------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | Missing `file` part, wrong type, too large, or too many pixels |
| 429    | `RATE_LIMITED` | Too many uploads                                               |

### DELETE /api/v1/users/me/avatar

Remove the authenticated user's avatar. It does what `PATCH /api/v1/users/me`
with `"avatar": ""` does, but sends no username, so a rename made on another
device is never reverted. It works for an uploaded file and for an `https://`
URL alike, shares the `PATCH` rate limit, and is idempotent: with no avatar it
still answers 200. Everyone receives a `user_update` with `avatar: null`. The
old file stays on disk for the operator sweep, but stops being served to other
users. An older server answers 405; fall back to the `PATCH`.

#### Response 200 OK

The same user object `PATCH /api/v1/users/me` returns, with no `avatar` key.

### POST /api/v1/users/me/banner

Upload a profile banner image and point the authenticated user's banner at it.
Broadcasts a `user_update` on success. It is the avatar upload with other
limits: the bytes are stored as an ordinary attachment with no channel
(counted against the uploader's storage quota), and `users.banner_id` names it.
`GET /api/v1/files/{id}` admits the file to every authenticated user for
exactly as long as `banner_id` names it, and refuses it to everyone but the
uploader once the banner is replaced or removed; the orphan sweep then
reclaims it. A banner file can never be attached to a message. If the profile
update fails after the bytes were stored, the unlinked attachment row and the
stored file are removed and the storage charge is released. The upload sends no
username, so a rename or About edit made meanwhile is kept.

Not registered when the server has no working storage backend.

**Auth:** Required
**Rate limit:** 5 uploads/minute per user

#### Request

`multipart/form-data` with a single `file` part.

| Rule       | Value                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Type       | `image/png`, `image/jpeg`, `image/webp` or `image/gif`, sniffed from the file's own bytes (the client's `Content-Type` is ignored) |
| Size       | 4 MiB                                                                                                                              |
| Dimensions | At most 1920x960, measured from the sniffed image                                                                                  |

Animated pictures are accepted and shown as for avatars; SVG is refused. The
server does not re-encode or crop; the client crops and scales a still picture
before uploading and sends an animated one unchanged.

#### Response 201 Created

The same shape as the avatar upload, with `url` set to `/api/v1/files/{id}`.

#### Errors

| Status | Code           | Cause                                                          |
| ------ | -------------- | -------------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | Missing `file` part, wrong type, too large, or too many pixels |
| 429    | `RATE_LIMITED` | Too many uploads                                               |

### DELETE /api/v1/users/me/banner

Remove the authenticated user's banner image. The colour is separate: clear it
with `PATCH /api/v1/users/me` and `"banner_color": ""`. It shares the `PATCH`
rate limit and is idempotent: with no banner it still answers 200. Everyone
receives a `user_update` with `banner: null`. The old file stops being served to
other users.

#### Response 200 OK

The same user object `PATCH /api/v1/users/me` returns, with `banner: null`.

| Status | Code           | Cause             |
| ------ | -------------- | ----------------- |
| 401    | `UNAUTHORIZED` | Not authenticated |
| 429    | `RATE_LIMITED` | Too many requests |

---

### PUT /api/v1/users/me/password

Change the authenticated user's password. Verifies the old password, enforces
password strength, and revokes all _other_ sessions on success. The account's
live WebSocket closes in the same request if it rode one of them.

**Auth:** Required
**Rate limit:** 5 requests/minute, plus a failed-confirmation lockout on
repeated wrong old passwords

#### Request

```json
{
  "old_password": "OldPass!1",
  "new_password": "NewStr0ng!Pass"
}
```

#### Response 204 No Content

Password changed and other sessions revoked. If the password change committed
but revoking other sessions failed, the endpoint returns **200 OK** with a
warning body instead (the new password is in effect — do not retry with the
old one).

#### Errors

| Status | Code            | Cause                                            |
| ------ | --------------- | ------------------------------------------------ |
| 400    | `INVALID_INPUT` | Weak new password, or new password equals old    |
| 403    | `FORBIDDEN`     | Incorrect old password                           |
| 429    | `RATE_LIMITED`  | Too many attempts / lockout                      |
| 429    | `AUTH_BUSY`     | The admission budget for password checks is full |

---

### GET /api/v1/users/me/sessions

List the authenticated user's active sessions.

`unseen` is the new-login signal (B4-7, BG-08): a session created by a login
starts `true` and stays so until the account lists its sessions from
another device. This listing is that acknowledgement — every row's flag
clears except the caller's own, so the device that just signed in never
acknowledges itself, and the response carries the flags as they were before
it. An API-token principal, which holds no session, acknowledges every row.
No push transport exists for the signal; a client that wants it polls this
route.

**Auth:** Required

#### Response 200 OK

```json
{
  "sessions": [
    {
      "id": 12,
      "device": "Mozilla/5.0 ...",
      "ip": "192.168.1.100",
      "created_at": "2026-07-01T10:00:00Z",
      "last_used": "2026-07-19T09:00:00Z",
      "is_current": true,
      "unseen": false
    }
  ]
}
```

---

### DELETE /api/v1/users/me/sessions/{id}

Revoke one of the authenticated user's sessions by ID. The account's live
WebSocket closes in the same request if it rode that session.

**Auth:** Required

#### Response 204 No Content

---

### DELETE /api/v1/users/me/sessions

Sign out everywhere: revoke every session and every API token of the
authenticated account, the current one included, and drop the account's live
WebSocket connections in the same request. The caller's token stops working
with this response, so the client re-authenticates rather than treating the
next 401 as an error. Never touches another account's credentials. Writes a
`session_revoke_all` audit row naming the account and both counts when
anything was revoked. Limited to 5 calls per account per minute
(`429 RATE_LIMITED`).

**Auth:** Required

#### Response 200 OK

```json
{
  "sessions_revoked": 3,
  "current_session_revoked": true
}
```

`current_session_revoked` is `false` only for an API-token principal, which
holds no session of its own.

---

## Channel Endpoints

### GET /api/v1/channels

List all channels the authenticated user has `READ_MESSAGES` permission for. DM channels are NOT included (use `GET /api/v1/dms` instead).

**Auth:** Required

#### Response 200 OK

```json
[
  {
    "id": 1,
    "name": "general",
    "type": "text",
    "topic": "Welcome to the server!",
    "category": "Text Channels",
    "position": 0,
    "slow_mode": 0,
    "archived": false,
    "nsfw": false,
    "voice_max_users": 0,
    "voice_max_video": 0
  }
]
```

| Field                | Type   | Description                                                                                                               |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | int64  | Channel ID                                                                                                                |
| `name`               | string | Channel name                                                                                                              |
| `type`               | string | `text`, `voice`, or `announcement` (announcement channels are read like text but only `MANAGE_MESSAGES` holders can post) |
| `topic`              | string | Channel topic/description                                                                                                 |
| `category`           | string | Name of the channel's category, `""` when none                                                                            |
| `category_id`        | int64  | The category's id, `0` when none (WP 6.5a)                                                                                |
| `category_position`  | int    | The category's position in the category order, `0` when none                                                              |
| `position`           | int    | Sort order within category                                                                                                |
| `slow_mode`          | int    | Slow-mode delay in seconds (0 = disabled)                                                                                 |
| `archived`           | bool   | Whether the channel is archived                                                                                           |
| `nsfw`               | bool   | Age-restriction label, enforced server-side (B5-7): its content needs the caller's own acknowledgement (see below)        |
| `voice_max_users`    | int    | Voice capacity, 0 = unlimited. Enforced on join (`CHANNEL_FULL`)                                                          |
| `voice_max_video`    | int    | Simultaneous cameras/screen shares, 0 = unlimited. Enforced on publish (`VIDEO_LIMIT`)                                    |
| `password_protected` | bool   | `true` for a voice channel that has a password (checked on `voice_join`). The password and its hash are never returned    |

#### The `nsfw` flag

The server stores `nsfw`, ships it in `ready` and in the `channel_create` /
`channel_update` broadcasts, and audits an operator flipping it. Since B5-7 it
also enforces it: a member who has not acknowledged a labelled channel gets
none of its content on any path, whatever their role — see
[NSFW Acknowledgement](#nsfw-acknowledgement) for the paths and the
acknowledge/revoke routes. The server checks no one's age. The desktop client
also shows a one-time-per-session "may contain sensitive content" gate before
rendering a flagged channel's messages (remembered in `sessionStorage`) and
marks the channel in its sidebar; the client consent UI is B9's.

---

### GET /api/v1/channels/{id}/messages

Paginated message history for a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (or DM participant membership)

#### Query Parameters

| Param    | Type  | Default    | Range | Description                                                                                                 |
| -------- | ----- | ---------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `before` | int64 | 0 (latest) | >= 0  | Cursor: return messages with ID less than this value, newest first                                          |
| `after`  | int64 | none       | >= 1  | Cursor: return messages with ID greater than this value, **oldest first**. Cannot be combined with `before` |
| `limit`  | int   | 50         | 1-100 | Number of messages to return                                                                                |

#### Response 200 OK

```json
{
  "messages": [
    {
      "id": 1042,
      "channel_id": 5,
      "user": {
        "id": 1,
        "username": "alex",
        "avatar": "uuid.png"
      },
      "content": "Hello!",
      "reply_to": null,
      "referenced_message": null,
      "attachments": [
        {
          "id": "file-uuid",
          "filename": "photo.jpg",
          "size": 204800,
          "mime_type": "image/jpeg",
          "url": "/api/v1/files/file-uuid",
          "width": 1920,
          "height": 1080
        }
      ],
      "reactions": [
        {
          "emoji": "\ud83d\udc4d",
          "count": 2,
          "me": true
        }
      ],
      "pinned": false,
      "edited_at": null,
      "deleted": false,
      "timestamp": "2026-03-14T10:30:00Z",
      "mentions": [7],
      "mention_roles": [],
      "mentions_everyone": false
    }
  ],
  "has_more": true
}
```

`mentions` is the server-resolved list of mentioned user IDs (always present,
empty when the message mentions nobody), `mention_roles` the role IDs whose
`<@&id>` token cleared the role-mention gate (the role is mentionable, or the
author holds `MENTION_EVERYONE`; always present, empty for none) and
`mentions_everyone` reports an `@everyone`/`@here` that cleared the
`MENTION_EVERYONE` permission. All are resolved at send time and re-resolved on
edit; an `@word` that matches no username, a `<@&id>` the author may not ping,
or an `@everyone` from a user without the bit, carries no mention semantics and
stays plain text. The same fields appear on pinned-message responses and on the
WebSocket `chat_message`/`chat_edited` payloads.

A message imported from a Discord export also carries
`"imported_author": {"name", "color"}` (`color` omitted when the export had none)
on history, pins, `around`, search results and `referenced_message`, and is
omitted for an ordinary message. See [protocol.md](protocol.md).

A DM can also hold a call log row: a message the server writes for a call in
the DM's voice channel. It carries two more fields, both omitted for an ordinary
message: `"kind": "call"` and `"call": {"started_at", "ended_at", "participants"}`.
`started_at` and `ended_at` use the message `timestamp` format (`ended_at` is
`null` while the call is live), and `participants` is the list of user IDs who
were in the call at any point. `content` is fallback text for clients that do not
know the field. A call row is read-only: editing, deleting, pinning, reacting to
or replying to it is refused, and search does not return it. A client treats an
unknown `kind` as an ordinary message and shows `content`.

A forwarded message (`chat_forward`, see `docs/protocol.md`) carries a `forward`
block, omitted for every other message: `{"source_channel_id", "source_message_id",
"source_timestamp"}`. `source_message_id` is `null` when the original is deleted or
purged. The block has no author and no channel name, and a deleted forward carries
none. The forward's `content` and `attachments` are its own snapshot and copies,
and it cannot be edited.

A poll message (`poll_create`, see `docs/protocol.md`) carries a `poll` block,
omitted for every other message and for a deleted one: `{"question", "answers":
[{"answer_id", "text", "emoji"}], "allow_multiselect", "expires_at", "ended",
"ended_at", "results": {"version", "total_voters", "counts": [{"answer_id",
"count"}], "me"}}`. `me` is the requesting user's own answer ids. `ended` is true
when the poll was ended or `expires_at` has passed, even before anything marked it
ended. The poll's `content` is a readable fallback of the question and answers. A poll
cannot be edited or forwarded.

A sticker message (`chat_send` with `sticker_id`, see `docs/protocol.md`) carries a
`sticker` block, omitted for every other message and for a deleted one: `{"id",
"name", "url"}`. `id` and `url` are `null` when the sticker was deleted, and `name`
is the label kept from send time. The message's `content` is the fallback `[Sticker:
name]`, and it cannot be edited or forwarded. Search hits carry the same block.

A group DM can also hold group event rows: `kind` is `group_add`, `group_remove`,
`group_leave`, `group_rename` or `group_icon`, with a `group_event` block
(`{"target_user_id"}` for add and remove, `{}` for leave, `{"name"}` for rename,
`{"icon_removed"}` for icon). They are read-only in the same way as call rows
(see `docs/protocol.md`). The server writes one when a member is added, removed,
leaves, or the group is renamed; the group icon row comes with the icon.

#### Pagination

Use cursor-based pagination by passing the `id` of the last message as the `before` parameter:

```
GET /api/v1/channels/5/messages?before=1042&limit=50
```

When `has_more` is `false`, you have reached the beginning of the channel history.

Pass `after` instead to page toward the present from a window fetched with
`messages/around` (below): the response keeps the same shape but its `messages`
are **oldest-first**, and `has_more` is `false` once the page reaches the newest
message. `after` with `before` is a `400`; `after` is read-gated exactly like
`before`.

```
GET /api/v1/channels/5/messages?after=1042&limit=50
```

---

### GET /api/v1/channels/{id}/messages/around/{messageId}

The window of channel history centred on one message, for jumping to a message
that is not in the client's loaded page — a search hit, a pinned entry, a reply
reference, or an `owncord://message/{channelId}/{messageId}` permalink.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (or DM participant membership) — the same gate as `GET /messages`

#### Query Parameters

| Param   | Type | Default | Range | Description                        |
| ------- | ---- | ------- | ----- | ---------------------------------- |
| `limit` | int  | 50      | 1-100 | Total window size, centre included |

Half the window sits before the centre and the remainder after it: `limit=50`
returns up to 25 older messages, the centre, and up to 24 newer ones. Near the
start or end of a channel the window is simply shorter — it is not re-balanced
toward the other side.

#### Response 200 OK

```json
{
  "messages": [],
  "has_more_before": true,
  "has_more_after": true
}
```

`messages` holds the same message objects as `GET /messages` (user, attachments,
reactions with the `me` flag, `mentions`, `mentions_everyone`), but is ordered
**oldest-first**, not newest-first like the paginated history endpoint.

`has_more_before` / `has_more_after` report whether the channel holds further
live history on each side of the returned window. A client that renders an
around-window is _detached_ from the live tail while `has_more_after` is true:
newly broadcast messages belong below the window and are not part of it, so the
client should offer a "jump to present" affordance that refetches the normal
`GET /messages` tail.

#### Errors

| Status | Code          | When                                                                                                                |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | `id` or `messageId` is not a positive integer, or `limit` is not a positive integer                                 |
| 403    | `FORBIDDEN`   | The channel exists but `READ_MESSAGES` is denied                                                                    |
| 404    | `NOT_FOUND`   | The channel does not exist, the caller is not a participant of the DM, or the message does not live in this channel |

Soft-deleted messages are 404 here, not an empty window: history omits deleted
rows, so there is no row to centre on. Deleted messages are also excluded from
the window itself, exactly as in `GET /messages`.

---

### POST /api/v1/channels/{id}/messages/purge

Bulk soft-delete the newest messages in a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` **and** `MANAGE_MESSAGES` on the channel (per-channel overrides apply)

Not available in DM channels — a DM has no `MANAGE_MESSAGES` gate, so those
requests are rejected with 403.

#### Request Body

```json
{
  "limit": 50,
  "before": 1042
}
```

| Field    | Type    | Required | Description                                                                                |
| -------- | ------- | -------- | ------------------------------------------------------------------------------------------ |
| `limit`  | integer | Yes      | How many messages to delete, 1--100. Values above 100 are clamped; 0 or negative is a 400. |
| `before` | integer | No       | Only delete messages with an id below this one. Omit or `0` to start from the newest.      |

#### Response 200 OK

```json
{
  "channel_id": 5,
  "ids": [1042, 1041, 1040],
  "count": 3
}
```

`ids` is newest-first and may hold fewer than `limit` entries when the channel
has less history; already-deleted messages are skipped. Deletion is soft: the
rows stay as tombstones, exactly as with a single delete. A single
[`chat_bulk_deleted`](protocol.md#chat_bulk_deleted-server---client-broadcast)
WebSocket event is broadcast to the channel (not one `chat_deleted` per
message), and one `message_purge` audit entry is written.

Rate limited to 5/sec per user.

---

### GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users

List the users who reacted to a message with a specific emoji — the "who
reacted" tooltip behind a reaction pill.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (DM: participant)

The reactor list is a separate endpoint rather than `user_ids` inline on every
reaction summary, so message payloads stay small: a busy channel carries dozens
of pills per page and almost none of them are ever hovered.

`{emoji}` is a path segment and must be percent-encoded (`👍` → `%F0%9F%91%8D`).
The message must belong to `{id}`; a message in another channel is a 404, so the
channel in the URL is always the one the permission check ran against.

#### Response 200 OK

```json
{
  "users": [
    { "id": 3, "username": "alice", "avatar": "" },
    { "id": 7, "username": "bob", "avatar": "/api/v1/files/abc123" }
  ]
}
```

Ordered oldest reaction first and capped at **100** reactors — the list is for a
tooltip, not an audit. `users` is always an array (`[]` when nobody used that
emoji, which is also the answer for an emoji that does not exist). `avatar` is
`""` when the user has none.

| Status | Error         | When                                                                                             |
| ------ | ------------- | ------------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST` | Non-positive `id`/`messageId`, or an empty / over-34-rune / control-character emoji              |
| 403    | `FORBIDDEN`   | No `READ_MESSAGES` on the channel                                                                |
| 404    | `NOT_FOUND`   | Channel or message not found, the message lives in another channel, or a DM the caller is not in |

---

### GET /api/v1/channels/{id}/pins

Get all pinned messages for a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel

#### Response 200 OK

Returns `{ "messages": [...], "has_more": false }`, most recently pinned first (messages pinned before migration 056 have no pin time and sort last). At most 1000 pins are returned; `has_more` is `true` only when the channel holds more and the list was truncated.

---

### GET /api/v1/channels/{id}/media

One page of the files posted in a channel, for the channel's media gallery. Only attachments of live (not deleted) messages appear; media from users the caller blocked is left out. Rate-limited with the `media:` bucket (120 requests a minute, shared with `/media/months`).

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (the same gate as the history, checked on every page)

| Query    | Description                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `kind`   | `media` (default: `image/*` and `video/*`) or `files` (everything else, voice messages included)                         |
| `q`      | Keeps file names containing this text (ASCII case-insensitive, matched literally), at most 100 characters                |
| `from`   | Keeps files posted by this user id                                                                                       |
| `order`  | `newest` (default) or `oldest`, by message                                                                               |
| `month`  | `YYYY-MM` in `tz`: newest-first starts at the end of that month, oldest-first at its start. Ignored when `cursor` is set |
| `tz`     | IANA time zone for `month`; empty means UTC                                                                              |
| `cursor` | The previous page's `next_cursor`                                                                                        |
| `limit`  | Page size, default 60, at most 100                                                                                       |

#### Response 200 OK

`{ "items": [ { "attachment": Attachment, "message_id": 123, "user": { "id", "username", "avatar" }, "timestamp": "2026-10-30 05:00:00" } ], "next_cursor": "123_<attachment id>" }`. `attachment` has the same shape as a message's attachments. `next_cursor` is `""` on the last page. The cursor holds the last item's message id and attachment id, so files posted while a viewer pages never repeat or shift a page; several files of one message keep a stable order. `400 BAD_REQUEST` for a malformed query, `403 FORBIDDEN` without read, `404 NOT_FOUND` for an unknown channel.

---

### GET /api/v1/channels/{id}/media/months

How many items each calendar month holds, for the gallery's month scrubber. Takes `kind`, `q`, `from` and `tz` as above.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel

#### Response 200 OK

`{ "months": [ { "month": "2026-10", "count": 42 } ] }`, newest month first, months counted in `tz` (UTC when empty).

---

### GET /api/v1/channels/{id}/threads

List the threads of a text channel or the posts of a forum, newest activity first by default. A forum's items carry the `post` block (tags and opening message preview).

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel

| Query      | Description                                                                   |
| ---------- | ----------------------------------------------------------------------------- |
| `archived` | `0` (default) for open threads, `1` for archived ones                         |
| `before`   | The previous page's `next_before` (an opaque cursor); omit for the first page |
| `limit`    | Page size, default 50, at most 100                                            |
| `sort`     | `activity` (default) or `created`, both newest first                          |
| `tag`      | A forum tag id, repeatable up to 5 times, any-of; forums only                 |

#### Response 200 OK

`{ "threads": [ThreadInfo, ...], "has_more": bool, "next_before": string }`; `next_before` is the cursor for the following page and is `""` when `has_more` is false. The cursor carries the last row's activity time and id, so activity in that thread between requests does not shift the paging; see [Threads](protocol.md#threads) for `ThreadInfo`. Order is `thread_last_activity_at DESC, id DESC` (activity has one-second resolution, so `id` breaks ties) or `id DESC` for `sort=created`; the cursor is the sort's own, so a `next_before` from one sort is refused under the other. A post that gains a reply while a viewer pages moves to the top: rows already past the cursor are never repeated, but a post that was still below it jumps above the cursor and is not returned by later pages, so a client merges live `thread_changed` frames into the list and dedupes by id. A forum parent uses the same `limit` bounds as a text channel. `400 BAD_REQUEST` for a malformed query, an unknown `sort`, a `tag` that is not a tag of this forum, more than 5 tags, a `tag` on a non-forum channel, or a cursor from the other sort, `403 FORBIDDEN` without read, `404 NOT_FOUND` for an unknown channel or a thread id.

---

### POST /api/v1/channels/{id}/pins/{messageId}

Pin a message in a channel. A successful pin or unpin is broadcast to the channel as [`chat_pinned`](protocol.md#chat_pinned-server---client-broadcast).

**Auth:** Required
**Permission:** `READ_MESSAGES` and `MANAGE_MESSAGES` on the channel; in a DM, a participant who is not blocked and not timed out

#### Response 204 No Content

---

### DELETE /api/v1/channels/{id}/pins/{messageId}

Unpin a message from a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` and `MANAGE_MESSAGES` on the channel; in a DM, a participant who is not blocked and not timed out

#### Response 204 No Content

---

## Search

### GET /api/v1/search

Full-text search across messages in channels the user can read. Uses SQLite FTS5 for matching.

**Auth:** Required
**Rate limit:** 30 requests/minute

#### Query Parameters

| Param        | Type   | Default        | Range                   | Description                                                                                                                                                                                                     |
| ------------ | ------ | -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`          | string | (required)     | non-empty               | Search words and filters (see [Filters](#filters)). Punctuation separates words; the last word, if three or more characters, also matches as a prefix (`deplo` finds `deploy`; `de` finds only `de`)            |
| `channel_id` | int64  | (all channels) | > 0                     | Restrict search to a single channel                                                                                                                                                                             |
| `limit`      | int    | 50             | 1-100                   | Maximum results to return                                                                                                                                                                                       |
| `sort`       | string | `relevance`    | `relevance` \| `recent` | `relevance` is best match first among the newest 2,000 matching messages in scope (older matches appear only with `recent`); `recent` is newest first. A query with filters and no words is always newest first |
| `before`     | int64  | (none)         | > 0                     | With `sort=recent` only: return messages with an id below this one. Pass the previous page's `next_before`                                                                                                      |
| `tz`         | string | `UTC`          | IANA zone name          | Time zone for the `before:`, `after:` and `during:` day boundaries, e.g. `Europe/Amsterdam`. Unknown names are a 400                                                                                            |

#### Filters

Filters are `key:value` tokens inside `q`; the remaining words are the search
text. Keys are case-insensitive and only count at the start of a token, so
`http://x`, `12:30` and `note:x` stay ordinary words. A value may be
double-quoted to hold spaces (`from:"ann lee"`); an unterminated quote runs to
the end of `q`.

| Filter          | Value                                                     | Matches                                                                  |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `from:name`     | username, optional leading `@`                            | Messages by that user (case-insensitive)                                 |
| `in:name`       | channel name, optional leading `#`                        | Messages in every readable channel with that name (names are not unique) |
| `before:date`   | `YYYY-MM-DD`                                              | Sent before 00:00 of that day in `tz`                                    |
| `after:date`    | `YYYY-MM-DD`                                              | Sent from 00:00 of the day after, in `tz`                                |
| `during:date`   | `YYYY-MM-DD`                                              | Sent during that day in `tz`                                             |
| `has:kind`      | `link`, `file`, `image`, `video`, `sound` (alias `audio`) | Messages with a link, or with an attachment of that kind                 |
| `mentions:name` | username, optional leading `@`                            | Messages whose text mentions that user (case-insensitive)                |
| `pinned:bool`   | `true` or `false`                                         | Messages that are (or are not) pinned                                    |

- Repeated `from:` or `in:` values match any of them; repeated `has:` or
  `mentions:` values must all match; different filters must all match. Several date filters intersect, and an empty range returns no results.
- An empty value (`from:`) is ignored. At most 25 filters per query and 10
  values each of `from:`, `in:`, `has:` and `mentions:`.
- `has:link` means the text contains `http://` or `https://` (approximate; there
  is no embed index). `has:file` is any attachment; `image`, `video` and `sound`
  match the attachment MIME type (`image/*`, `video/*`, `audio/*`). An upload
  not yet sent, and any deleted message, never match. `embed`, `sticker` and
  `poll` are not supported and are a `400`.
- `mentions:` matches `@user` mentions in the text. A reply ping (the reply
  notification to the replied-to author) and `@everyone` / `@here` do not count,
  and an edit that removes the mention stops the match. A reply that pings a
  user and also names them in the text still matches, judged from the current
  text (approximate: `@bobby` also counts for `bob`).
- `pinned:` takes `true` or `false`; `pinned:true pinned:false` returns nothing.
- An unknown user or channel name returns an empty `200`. `in:` only matches
  channels the caller can read, so a private, unacknowledged NSFW or someone
  else's DM channel gives exactly the answer a nonexistent name gives, with or
  without `channel_id`. `channel_id` itself keeps its `403` / `404` answers.
- A query with filters and no words has no relevance order: results are newest
  first and page with `next_before`, the same as `sort=recent`. Send
  `sort=recent&before=<next_before>` for the following pages; filters and scope
  carry over because `q` is sent again.

#### Response 200 OK

```json
{
  "results": [
    {
      "message_id": 1042,
      "channel_id": 5,
      "channel_name": "general",
      "user": {
        "id": 1,
        "username": "alex"
      },
      "content": "...matched text...",
      "timestamp": "2026-03-14T10:30:00Z",
      "mentions": [7],
      "mentions_everyone": false
    }
  ],
  "next_before": 1042
}
```

`next_before` is the `before` value for the next `sort=recent` page, or `null`
when there are no more results. It is always `null` for `sort=relevance` when `q` has words.

#### Error Responses

| Status | Code                            | When                                                                                                                                                                                                                                                                              |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`                   | `q` missing; bad `channel_id`, `limit`, `sort` or `before`; `before` without `sort=recent`; bad `tz`; a malformed `before:` / `after:` / `during:` date; an unknown `has:` kind or a `pinned:` value other than `true` / `false`; too many filters (the message names the filter) |
| 403    | `FORBIDDEN`                     | `channel_id` names a channel the caller cannot read                                                                                                                                                                                                                               |
| 403    | `NSFW_ACKNOWLEDGEMENT_REQUIRED` | `channel_id` names an NSFW channel the caller has not acknowledged                                                                                                                                                                                                                |
| 404    | `NOT_FOUND`                     | `channel_id` names no channel                                                                                                                                                                                                                                                     |

---

## GIFs

The server proxies the Klipy GIF API so the provider API key stays server-side.
Clients never contact `api.klipy.com` — a key shipped in the desktop bundle
would be public by construction. The key is configured as `gif.api_key`
(see [Server Configuration](server-configuration.md#gif-picker-gif)).

**Default-off contract:** with no key configured, both endpoints return
`503` with error code `GIF_DISABLED`. Clients must treat that as "this server
does not have GIFs" and hide/disable the GIF affordance — not retry.

The media URLs in the response point at Klipy's CDN; the client still validates
them against its `klipy.com` CDN allowlist before rendering.

### GET /api/v1/gif/search

**Auth:** Required
**Rate limit:** 30 requests/minute (dedicated per-IP bucket)

#### Query Parameters

| Param   | Type   | Default    | Range       | Description                                                                   |
| ------- | ------ | ---------- | ----------- | ----------------------------------------------------------------------------- |
| `q`     | string | (required) | 1-100 chars | Search term                                                                   |
| `limit` | int    | 20         | 1-50        | Maximum results to return                                                     |
| `pos`   | string | (none)     | 1-256 chars | Paging cursor from the previous response's `next` (`A-Za-z0-9._:=+/%~-` only) |

#### Response 200 OK

```json
{
  "results": [
    {
      "id": "abc123",
      "title": "happy cat",
      "media_formats": {
        "tinygif": { "url": "https://media.klipy.com/abc123_tiny.gif" },
        "gif": { "url": "https://media.klipy.com/abc123.gif" }
      }
    }
  ],
  "next": "CAoQ"
}
```

Only `id`, `title`, and the two `media_formats` URLs are forwarded. Every other
field the upstream returns is dropped, so an upstream that echoed the API key
could not leak it to clients. Results missing either format are omitted.

`next` is the opaque cursor for the following page: send it back as `pos` to
get it. It is `""` when there is nothing more, and also when the upstream's
cursor fails the same character rule as `pos` (it is dropped, never relayed).
A provider that ignores `pos` returns the same page again, so a client pages
only while a page brings GIFs it has not seen.

#### Errors

| Status | Code            | When                                                                              |
| ------ | --------------- | --------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT` | Missing/blank `q`, `q` over 100 chars, `limit` outside 1-50, or a malformed `pos` |
| 401    | `UNAUTHORIZED`  | No valid session (checked before the disabled check)                              |
| 429    | `RATE_LIMITED`  | Over 30 requests/minute                                                           |
| 502    | `BAD_GATEWAY`   | Upstream error, timeout, or unparseable response                                  |
| 503    | `GIF_DISABLED`  | `gif.api_key` is not configured                                                   |

### GET /api/v1/gif/trending

Same auth, rate limit, response shape, and error codes as
`/api/v1/gif/search`, minus the `q` parameter.

| Param   | Type   | Default | Range       | Description               |
| ------- | ------ | ------- | ----------- | ------------------------- |
| `limit` | int    | 20      | 1-50        | Maximum results to return |
| `pos`   | string | (none)  | 1-256 chars | Paging cursor, as above   |

### GET /api/v1/gif/favorites

Returns the caller's saved GIFs, newest first: `{"favorites": [{"url", "preview_url", "title"}]}`.
Requires a session, and is limited to 300 requests/minute like the other two favorites
endpoints; there is no `gif.api_key` dependency.

### PUT /api/v1/gif/favorites

Saves a GIF. Body: `{"url", "preview_url", "title"}`. Both URLs must be `https`
URLs on `klipy.com` or a subdomain.
A `title` over 200 bytes is cut on a character boundary. Saving a GIF that is
already a favorite changes nothing. Responds `204`.

| Status | Code                 | When                                 |
| ------ | -------------------- | ------------------------------------ |
| 400    | `INVALID_INPUT`      | Malformed body or a disallowed URL   |
| 401    | `UNAUTHORIZED`       | No valid session                     |
| 409    | `GIF_FAVORITES_FULL` | The caller already has 250 favorites |

### DELETE /api/v1/gif/favorites

Removes a favorite. The GIF is named by the `url` query parameter. Responds
`204`, including when it was not a favorite.

---

## Web Push

Server-side storage of Web Push subscriptions, plus dispatch behind its own,
second opt-in: `push.dispatch_enabled` (default **off**, independent of
`push.enabled`). See [Server Configuration](server-configuration.md#web-push-push)
for both keys, the staleness window, and the rotation procedure below.

**Default-off contract:** with `push.enabled` false, every endpoint below
answers `503 PUSH_DISABLED` after authenticating the caller. A disabled
server writes nothing. With `push.enabled` true but `push.dispatch_enabled`
false — the state an install upgraded from an earlier release starts in —
subscriptions are stored but nothing is ever sent to one.

**What dispatch sends, and to whom.** With both keys true, a new message
sends a fixed, generic `{"t":"activity"}` payload — no message text, channel
name, sender or count — to: the message's direct `@mentions` in a guild
channel, or every other participant of a one-to-one DM who trusts the
author (the same `trusted_senders` row Message Requests gates on — see
"Message Requests" below; a first-contact message from someone not yet
trusted rings no one's phone). Within that set, only offline subscribers
are pushed to (a connected client already has the message), and permission
is re-checked at dispatch time (`CanReadContent`, not whatever it was when
the subscription was created) — the same predicate every content read path
resolves, so a channel labelled `nsfw` pushes only to a recipient who has
acknowledged it (see "NSFW Acknowledgement" below); a revoke between the
first attempt and a retry drops the retry. At most one push per user per channel per 60
seconds. A `404`/`410` response prunes the subscription; a `429` or `5xx`
(or a network error) gets two retries — three attempts total — before being
dropped, and any other failure status drops immediately. Nothing is written
per attempt, and a restart drops anything in flight. Turning dispatch on
makes the server
open outbound HTTPS connections to the push service named in each stored
subscription's endpoint — see
[diagnostics.md](architecture/diagnostics.md)'s egress table.

**Refresh-by-re-POST:** a subscription is kept alive by POSTing the same
`endpoint` again — the server upserts the row (same id, `last_seen_at`
bumped) rather than creating a second one. A subscription not refreshed
within `push.subscription_ttl_days` is removed by the maintenance sweep.

**Rotation and `key_id`:** the server signs with one VAPID key at a time.
`GET /vapid` reports its `key_id`; a client that sees a different `key_id`
than the one it last subscribed under should re-subscribe — rotating the key
(an operator action: replace the key file or `OWNCORD_PUSH_VAPID_KEY`, then
restart) invalidates every subscription created under the old key. Such rows
stop being listed immediately and are removed by the sweep.

### GET /api/v1/push/vapid

**Auth:** Required

#### Response 200 OK

```json
{ "public_key": "base64url-encoded-65-byte-P-256-point", "key_id": "a1b2c3d4e5f6a7b8" }
```

### GET /api/v1/push/subscriptions

**Auth:** Required

Lists the caller's own subscriptions under the currently running VAPID key.
A subscription created under a since-rotated key is not listed.

#### Response 200 OK

```json
{
  "subscriptions": [
    {
      "id": 1,
      "device_name": "My Laptop",
      "endpoint_host": "fcm.googleapis.com",
      "created_at": "2026-09-05T12:00:00Z",
      "last_seen_at": "2026-09-05T12:00:00Z"
    }
  ]
}
```

`endpoint_host` is the endpoint URL's host only — never the endpoint itself,
never the `p256dh`/`auth` keys. An endpoint plus its auth secret is a push
credential.

### POST /api/v1/push/subscriptions

**Auth:** Required
**Body limit:** 8 KiB

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": { "p256dh": "...", "auth": "..." },
  "device_name": "My Laptop"
}
```

There is no user id in the body — the row's owner is always the
authenticated session's. `endpoint` must be an `https://` URL with a host, no
embedded credentials, at most 2048 characters. `p256dh` must decode (standard or unpadded base64url)
to a 65-byte uncompressed P-256 point (`0x04` prefix) that lies on the curve; `auth` must decode to
16 bytes. `device_name` is at most 64 runes and must not contain control
characters. A user may hold at most 10 subscriptions; the 11th evicts the
oldest by `last_seen_at`.

#### Response 201 Created

```json
{ "id": 1 }
```

#### Errors

| Status | Code            | When                                                   |
| ------ | --------------- | ------------------------------------------------------ |
| 400    | `INVALID_INPUT` | Malformed body, or a credential field fails validation |
| 503    | `PUSH_DISABLED` | `push.enabled` is false                                |

### DELETE /api/v1/push/subscriptions/{id}

**Auth:** Required

Revokes one of the caller's own subscriptions.

#### Response

`204 No Content` on success. `404 NOT_FOUND` when `id` does not exist or
belongs to another user — the two cases are indistinguishable by design.

---

## Direct Messages

DM channels use participant-based authorization rather than role-based permissions.

### POST /api/v1/dms

Create or retrieve a 1-on-1 DM channel with another user. If a DM channel already exists, it is returned and re-opened. A timed-out caller may still reopen an existing channel, but creating a new one is refused with `403 TIMED_OUT`.

**Auth:** Required

#### Request

```json
{
  "recipient_id": 2
}
```

#### Response 200 OK (existing channel) or 201 Created (new channel)

```json
{
  "channel_id": 100,
  "recipient": {
    "id": 2,
    "username": "jordan",
    "avatar": "uuid.png",
    "status": "online"
  },
  "created": false
}
```

On a newly created channel (`201`, `"created": true`) the recipient also
receives a `dm_channel_open`. Re-opening an existing DM (`200`) emits nothing —
it only touches the caller's own open state. The creator is not sent the event
on either path; it learns the channel from the response body above.

If the caller holds a `pending`, `ignored` or `deleted` message request from the other
user, `POST /api/v1/dms` accepts it, atomically: trusts the sender, opens the
conversation and marks the request `accepted`, and sends the caller's other
devices the `dm_channel_open` and `dm_request` frames `accept` sends.

If either user has blocked the other, or the recipient has turned off direct
messages from members (`allow_member_dms` in `/users/me/privacy`) and has no
trust row for the caller (accepted, written to first, or grandfathered), the
call is refused with `403 FORBIDDEN` and the same body for every cause:
`you can't message this user`. A recipient who does not exist or whose account
is not active is `404 NOT_FOUND`.

---

### GET /api/v1/dms

List all open DM channels for the authenticated user, ordered by most recent activity.

**Auth:** Required

#### Response 200 OK

```json
{
  "dm_channels": [
    {
      "channel_id": 100,
      "name": "Lunch crew",
      "is_group": true,
      "recipient": {
        "id": 2,
        "username": "jordan",
        "display_name": "Jo",
        "avatar": "/api/v1/files/uuid",
        "status": "online"
      },
      "recipients": [
        {
          "id": 2,
          "username": "jordan",
          "display_name": "Jo",
          "avatar": "/api/v1/files/uuid",
          "status": "online"
        },
        {
          "id": 3,
          "username": "sam",
          "display_name": "",
          "avatar": "",
          "status": "idle"
        }
      ],
      "last_message_id": 5042,
      "last_message": "Hey, how's it going?",
      "last_message_at": "2026-03-28T14:30:00Z",
      "unread_count": 3,
      "mention_count": 1,
      "last_read_message_id": 5039
    }
  ]
}
```

| Field                  | Description                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipient`            | The other participant of a 1:1 DM. **Backward compatibility only** — for a group it carries the first of `recipients`.                                                                                                     |
| `recipients`           | Every participant except the caller. What group-aware clients read.                                                                                                                                                        |
| `name`                 | Optional group name, max 100 characters, one line: runs of spaces collapse, and control characters, line breaks, invisible characters and stacked combining marks are refused. `""` for a 1:1 DM and for an unnamed group. |
| `is_group`             | True for a group DM. Stored, not derived from the live participant count.                                                                                                                                                  |
| `owner_id`             | Groups only, omitted for a 1:1 DM: the group's owner, always a current member. The creator at create, then the lowest remaining member id when the owner leaves or their account is erased.                                |
| `icon`                 | The group's icon as a file URL (`/api/v1/files/{id}`), `""` when it has none and for a 1:1 DM. Always present. Only the group's members can fetch the file, and only while it is the live icon.                            |
| `unread_count`         | Unread messages for the caller, capped at 100 (a value of 100 means "100 or more") — the same cap as `ready`.                                                                                                              |
| `mention_count`        | The caller's `read_states.mention_count` for the DM — the same value the `ready` payload's `dm_channels[]` carries.                                                                                                        |
| `last_read_message_id` | The caller's read pointer (`read_states.last_message_id`) for the DM; `0` when they have never read it.                                                                                                                    |

`status` is viewer-adjusted: an `invisible` participant reads as `offline`.

---

### POST /api/v1/dms/group

Create a group DM between the caller and 2–8 other users (3–10 total).

Unlike `POST /api/v1/dms` this **always creates**: the same set of people may
reasonably want more than one group, so there is no "the group for these users"
to look up.

Blocks are enforced in both directions, per recipient — a user may neither pull
someone they have blocked into a room with them nor use a group to reach
someone who has blocked them. A recipient is also refused when they have turned
off direct messages from members (`allow_member_dms`) and hold no trust row for
the caller, or when the caller holds a message request to them that they have not
accepted (pending, ignored or deleted); only the caller's own trust counts. Staff
are checked like anyone else. The check is creation-time only; see
`docs/protocol.md` § DM Authorization for why sending into a group is not
block-checked.

**Auth:** Required

#### Request

```json
{
  "recipient_ids": [2, 3],
  "name": "Lunch crew"
}
```

| Field           | Type   | Required | Description                                                                     |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `recipient_ids` | int[]  | Yes      | 2–8 other users. De-duplicated; the caller is dropped if named.                 |
| `name`          | string | No       | Group name, ≤ 100 characters. HTML-stripped. Omit or `""` for an unnamed group. |

#### Response 201 Created

The same DM summary shape `GET /api/v1/dms` returns, from the creator's seat.
Every participant — the creator included — also receives a `dm_channel_open`.
The creator is the group's owner (`owner_id`).

#### Errors

| Status | Code          | Reason                                                                |
| ------ | ------------- | --------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Fewer than 2 or more than 8 recipients, or a name over 100 characters |
| 403    | `FORBIDDEN`   | A recipient cannot be added to a group by the caller (any cause)      |
| 403    | `TIMED_OUT`   | The caller is timed out                                               |
| 404    | `NOT_FOUND`   | A recipient does not exist                                            |

---

### PATCH /api/v1/dms/{channelId}

Set or clear a group DM's name.

Any participant may rename it, the owner included; renaming is not an owner
power. A 1:1 DM refuses — its name is who is in it.

**Auth:** Required (participant)

#### Request

```json
{ "name": "Lunch crew" }
```

An empty name clears it, and the group falls back to listing its members.

The name follows the same single-line rule as at creation: no line breaks,
control or invisible characters, and at most 2 combining marks in a row.

#### Response 200 OK

The DM summary shape, from the caller's seat. Every participant also receives a
`dm_channel_open` carrying the new name, then one sequenced `chat_message` of
kind `group_rename` (author = the caller, `group_event.name` = the new name, `""`
when the name was removed). A name equal to the current one writes no row and
sends nothing.

If the change commits but the server cannot then read the summary back, the route
answers `204 No Content` instead (the change and its events have happened, and the
caller gets the same summary from its `dm_channel_open`), so a client must not
treat a missing body as a failure.

Limited to 20 group changes per user per minute, shared with add, remove and
owner transfer.

#### Errors

| Status | Code           | Reason                                                      |
| ------ | -------------- | ----------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | The channel is a 1:1 DM, or the name exceeds 100 characters |
| 403    | `TIMED_OUT`    | The caller is timed out                                     |
| 404    | `NOT_FOUND`    | Not a participant of this DM                                |
| 429    | `RATE_LIMITED` | More than 20 group changes in a minute                      |

---

### DELETE /api/v1/dms/{channelId}

Remove a DM from the caller's sidebar. What that means depends on the kind of DM,
and the route is shared because the _gesture_ is shared:

- **1:1 DM** — a hide. The channel and messages remain, the caller remains a
  participant, and a new message from either side re-opens it.
- **Group DM** — a **leave**. The caller comes out of `dm_participants`, stops
  receiving the group's messages, and cannot return unaided. When the last
  participant leaves, the channel row is deleted (a DM nobody is in is reachable
  by nobody, and its messages cascade off the channel).

The caller receives `dm_channel_close`; after a group leave the remaining
participants receive a fresh `dm_channel_open` with the new membership. If the
leaver owned the group, ownership passes to the lowest remaining member id in the
same transaction, and the refreshed `dm_channel_open` carries the new `owner_id`.
The remaining participants then get a sequenced `chat_message` of kind
`group_leave` (author = the leaver). The last leaver writes no row, because the
channel goes with them. The leaver's own read state for the DM is deleted.
A leave is never refused for a timeout and is not rate limited.

**Auth:** Required (participant)

#### Response 204 No Content

#### Errors

| Status | Code        | Reason                       |
| ------ | ----------- | ---------------------------- |
| 404    | `NOT_FOUND` | Not a participant of this DM |

---

### POST /api/v1/dms/{channelId}/members

Add people to a group DM. Any member may add, up to 10 members in all. A 1:1 DM
refuses.

The recipient checks are the ones create runs (the same code): every user must
exist and not be banned (either is "not found"), and none of the new people may
be blocked by, or have blocked, any other new person or any current member. Each
new person must also be reachable by the caller: they have not turned off direct
messages from members without trusting the caller, and the caller holds no
message request to them that they have not accepted (pending, ignored or
deleted). Only the caller's trust counts, not that of the members already in the
group, and staff are checked like anyone else. If one of several new people is
refused, nobody is added. The pairs between people who are already in the group
are not re-checked, and a member who later turns direct messages off stays in the
group, keeps sending and can leave. Once added, the group is a shared room and
sends are not block-checked. Added people see the earlier history.

**Auth:** Required (member)

#### Request

```json
{ "user_ids": [4, 5] }
```

| Field      | Type  | Required | Description                                                                                       |
| ---------- | ----- | -------- | ------------------------------------------------------------------------------------------------- |
| `user_ids` | int[] | Yes      | 1–9 users. De-duplicated. Users who are already members are skipped; if none is new, it is a 400. |

#### Response 200 OK

The DM summary shape from the caller's seat, with the new members. Then, in this
order, from the request:

1. Every member after the change, the added people included, receives a
   `dm_channel_open` (the full summary from their own seat).
2. Every member receives one sequenced `chat_message` of kind `group_add` per
   added user (author = the caller, `group_event.target_user_id` = the added
   user).

So on each connection the open arrives before the row, and an added user never
sees a row for a DM they do not know yet. The cap is counted inside the
transaction: two adds that together pass 10 cannot both succeed.

The blocked-pair and reachability checks run again inside the transaction, so a
block, a changed setting or another add that lands between the first check and
the commit cannot slip a refused person into the room (403 `FORBIDDEN`).

If the change commits but the server cannot then read the summary back, the route
answers `204 No Content` instead (the change and its events have happened, and the
caller gets the same summary from its `dm_channel_open`), so a client must not
treat a missing body as a failure.

Limited to 20 group changes per user per minute.

#### Errors

| Status | Code            | Reason                                                                                             |
| ------ | --------------- | -------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`   | A 1:1 DM, no ids, more than 9 ids, a non-positive id, or every id is already a member              |
| 403    | `FORBIDDEN`     | A new person cannot be added by the caller, or a blocked pair among the new people and the members |
| 403    | `TIMED_OUT`     | The caller is timed out                                                                            |
| 404    | `NOT_FOUND`     | The caller is not a member, or a new user does not exist or is banned                              |
| 409    | `GROUP_DM_FULL` | The group would pass 10 members                                                                    |
| 429    | `RATE_LIMITED`  | More than 20 group changes in a minute                                                             |

---

### DELETE /api/v1/dms/{channelId}/members/{userId}

Remove a member from a group DM. Owner only. To remove yourself, leave
(`DELETE /api/v1/dms/{channelId}`).

**Auth:** Required (owner)

#### Response 204 No Content

The removed member receives `dm_channel_close` (the visibility watermark is bumped
first, as on a leave) and is evicted from the group's voice call with reason
`dm_removed`. They get no row. Then the remaining members receive a refreshed
`dm_channel_open` and one sequenced `chat_message` of kind `group_remove`
(author = the owner, `group_event.target_user_id` = the removed user). The removed
member's unread state for the DM is deleted. The owner can remove everyone else,
which leaves a group of one.

A remove that races the target's own leave writes one row: whichever commits first
wins and the other gets a 404.

Limited to 20 group changes per user per minute.

#### Errors

| Status | Code           | Reason                                                |
| ------ | -------------- | ----------------------------------------------------- |
| 400    | `BAD_REQUEST`  | A 1:1 DM, or the target is the caller (leave instead) |
| 403    | `FORBIDDEN`    | The caller is not the owner                           |
| 403    | `TIMED_OUT`    | The caller is timed out                               |
| 404    | `NOT_FOUND`    | The caller or the target is not a member              |
| 429    | `RATE_LIMITED` | More than 20 group changes in a minute                |

---

### PUT /api/v1/dms/{channelId}/owner

Hand a group DM to another member. Owner only.

**Auth:** Required (owner)

#### Request

```json
{ "user_id": 3 }
```

#### Response 200 OK

The DM summary shape from the caller's seat, with the new `owner_id`. Every member
receives a refreshed `dm_channel_open`. A transfer writes no row. `owner_id`
always names a current member: a transfer to someone who has just left or been
removed is a 404 and changes nothing.

If the change commits but the server cannot then read the summary back, the route
answers `204 No Content` instead (the change and its events have happened, and the
caller gets the same summary from its `dm_channel_open`), so a client must not
treat a missing body as a failure.

Limited to 20 group changes per user per minute.

#### Errors

| Status | Code           | Reason                                   |
| ------ | -------------- | ---------------------------------------- |
| 400    | `BAD_REQUEST`  | A 1:1 DM, or the target is the caller    |
| 403    | `FORBIDDEN`    | The caller is not the owner              |
| 403    | `TIMED_OUT`    | The caller is timed out                  |
| 404    | `NOT_FOUND`    | The caller or the target is not a member |
| 429    | `RATE_LIMITED` | More than 20 group changes in a minute   |

---

### POST /api/v1/dms/{channelId}/icon

Set a group DM's icon. Any member may.

**Auth:** Required (any member). Not mounted on a server whose file storage failed to open.

#### Request

`multipart/form-data` with one `file` part, under the same rules as an avatar
(`POST /api/v1/users/me/avatar`) except that it stays still: at most 1 MiB, a
PNG, JPEG or WebP image (no GIF; sniffed from the bytes, never from the filename
or the client's type), at most 1024 x 1024 pixels, and it counts against the
uploader's storage quota. The request body is capped at 3 MiB. Crop to a square client-side.

#### Response 200 OK

The DM summary shape from the caller's seat, with the new `icon`. The file is an
unlinked attachment that the group names: its members can fetch it from
`/api/v1/files/{id}` while it is the live icon, and nobody else can (the
uploader can still read their own file). Every member receives a refreshed
`dm_channel_open`, then one sequenced `chat_message` of kind `group_icon`
(author = the caller, `group_event` `{"icon_removed": false}`). A file that
the icon replaced stops being served to the members and is deleted by the
orphan sweep. Two members changing the icon at once is not an error: the last
change to commit is the icon, and each change leaves its own row.

If the change commits but the server cannot then read the summary back, the route
answers `204 No Content` instead, as the other group routes do.

Limited to 5 uploads per user per minute, on its own limit apart from the group
changes below and from avatar uploads.

#### Errors

| Status | Code           | Reason                                                             |
| ------ | -------------- | ------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`  | A 1:1 DM, a missing `file`, or a file that breaks the image rules  |
| 403    | `TIMED_OUT`    | The caller is timed out                                            |
| 404    | `NOT_FOUND`    | The caller is not a member, or stopped being one before the commit |
| 429    | `RATE_LIMITED` | More than 5 icon uploads in a minute                               |

If the group cannot be changed after the file was stored (for instance the caller
left the group in between) the file and its record are deleted and nothing is
written or sent.

---

### DELETE /api/v1/dms/{channelId}/icon

Remove a group DM's icon. Any member may.

**Auth:** Required (any member)

#### Response 200 OK

The DM summary shape from the caller's seat, with `icon` `""`. Every member
receives a refreshed `dm_channel_open`, then a `group_icon` row with
`group_event` `{"icon_removed": true}`. A group that has no icon changes
nothing: the same `200`, no row and no event. The old file stops being served
and is deleted by the orphan sweep.

If the change commits but the server cannot then read the summary back, the route
answers `204 No Content` instead.

Limited to 20 group changes per user per minute, shared with add, remove, owner
transfer and rename.

#### Errors

| Status | Code           | Reason                                 |
| ------ | -------------- | -------------------------------------- |
| 400    | `BAD_REQUEST`  | A 1:1 DM                               |
| 403    | `TIMED_OUT`    | The caller is timed out                |
| 404    | `NOT_FOUND`    | The caller is not a member             |
| 429    | `RATE_LIMITED` | More than 20 group changes in a minute |

---

## Message Requests

B5-6: the first message from a sender the recipient does not yet trust, in a
**one-to-one** DM, stages a request instead of opening the conversation
(`message_requests`, `trusted_senders` — `docs/schema.md`, migration `046`).
Group DMs are untouched. Existing one-to-one DM pairs were grandfathered as
trusted when `046` applied, so no live conversation broke on upgrade.

**The sender's side is byte-identical across `pending`, `ignored` and
`deleted`** (decision 5, `docs/architecture/community-services.md` section
S1): `chat_send_ok`, `chat_message`, `GET /api/v1/dms` and
`GET /channels/{id}/messages` are the same whether the request ends up
pending, ignored or deleted. A sender can never distinguish those three
states from one another, or from a request nobody has looked at yet —
silence, not a rejection. `block` is not part of this claim: a blocked
sender's _later_ sends fail with `ErrBlocked` (Codex P2-9) — that denial is
the existing block gate (`PUT /api/v1/blocks/{userId}`), unchanged by B5-6,
and it is visible to the sender by design.

A recipient who has direct messages on and message requests off
(`message_requests: false` in `/users/me/privacy`) gets no request: the first
message is recorded as already accepted, the conversation opens for them
(`dm_channel_open`) and the message is delivered, mentioned and pushed as for
any trusted sender, with no `dm_request` frame. Requests already in the inbox
stay `pending`, and turning requests back on keeps that pair trusted. With
direct messages off the send is refused instead (see above).

Transitions are **recipient-only** and legal **only from `pending`**:

- `accept` — trusts the sender, opens the conversation for the recipient
  (`dm_channel_open`), and marks the request accepted, all in one
  transaction.
- `ignore` — the request drops out of the inbox; nothing else changes.
- `delete` — identical to `ignore` server-side; the held message rows stay in
  the channel (the recipient never opened it).
- `block` — blocks the sender (`PUT /api/v1/blocks/{userId}`'s existing
  effects) and only then marks the request blocked.

Blocking a user also revokes the blocker's trust in them (the blocked user's
trust in the blocker is untouched), so after an unblock their next message is a
request again.

A transition attempted on a row that is not pending returns **409
CONFLICT** if the row exists for the caller (a race, including the loser of
two simultaneous decisions) or **404 NOT_FOUND** if it does not — including
when the caller is the sender or an unrelated user, so a foreign request's
existence is never confirmed.

### GET /api/v1/dm-requests

List the caller's pending inbox, newest first.

**Auth:** Required

#### Response 200 OK

```json
{
  "requests": [
    {
      "id": 1,
      "channel_id": 42,
      "sender": {
        "id": 7,
        "username": "stranger",
        "display_name": "",
        "avatar": ""
      },
      "preview": {
        "message_id": 100,
        "content": "hi, stranger",
        "timestamp": "2026-09-05T12:00:00Z"
      },
      "created_at": "2026-09-05T12:00:00Z"
    }
  ]
}
```

---

### POST /api/v1/dm-requests/{id}/accept

### POST /api/v1/dm-requests/{id}/ignore

### POST /api/v1/dm-requests/{id}/delete

### POST /api/v1/dm-requests/{id}/block

Decide a pending request. `block` additionally blocks the sender.

**Auth:** Required (recipient only)

#### Response 200 OK

```json
{
  "id": 1,
  "state": "accepted",
  "decided_at": "2026-09-05T12:05:00Z"
}
```

#### Errors

| Status | Code        | Reason                                             |
| ------ | ----------- | -------------------------------------------------- |
| 404    | `NOT_FOUND` | Not this recipient's request, or it does not exist |
| 409    | `CONFLICT`  | The request is no longer pending                   |

---

## NSFW Acknowledgement

B5-7: a channel's `nsfw` label (`docs/schema.md`, migration `025`) is
enforced server-side (migration `047`, decision 13). A member with no
acknowledgement row for a labelled channel gets no content from it on any
path — history, around, pins, reaction users, search, live/replayed socket
delivery, or attachment bytes — regardless of role; an administrator
acknowledges like anyone else. Revoking takes effect on the caller's very
next read, with no client-side cache to invalidate.

### PUT /api/v1/channels/{id}/nsfw-acknowledgement

Record the caller's own consent to the channel's labelled content.
Idempotent. Sends the caller's other live sockets an `nsfw_ack` frame
(`docs/protocol.md`) with `"acknowledged": true`.

**Auth:** Required

#### Response 204 No Content

#### Errors

| Status | Code          | Reason                                                     |
| ------ | ------------- | ---------------------------------------------------------- |
| 400    | `BAD_REQUEST` | The channel is a thread: its consent is its parent's       |
| 404    | `NOT_FOUND`   | The channel does not exist or is not visible to the caller |
| 409    | `NOT_NSFW`    | The channel is not labelled — nothing to acknowledge       |

---

### DELETE /api/v1/channels/{id}/nsfw-acknowledgement

Revoke the caller's own acknowledgement, if any. Idempotent — revoking a row
that does not exist (never acknowledged, or the channel was since unlabelled)
still answers 204. Sends the caller's other live sockets an `nsfw_ack` frame
with `"acknowledged": false`.

**Auth:** Required

#### Response 204 No Content

#### Errors

| Status | Code          | Reason                                                     |
| ------ | ------------- | ---------------------------------------------------------- |
| 400    | `BAD_REQUEST` | The channel is a thread: its consent is its parent's       |
| 404    | `NOT_FOUND`   | The channel does not exist or is not visible to the caller |

---

## User Blocks

Blocking a user prevents DM creation and messaging in both directions
(backed by the `user_blocks` table).

### GET /api/v1/blocks

List the IDs of users the authenticated user has blocked.

**Auth:** Required

#### Response 200 OK

```json
{ "blocked_user_ids": [2, 7] }
```

---

### PUT /api/v1/blocks/{userId}

Block a user.

**Auth:** Required

#### Response 200 OK

```json
{ "message": "user blocked" }
```

---

### DELETE /api/v1/blocks/{userId}

Unblock a user. When a block was actually removed, also clears any
already-decided (accepted, ignored, deleted or blocked) message request from
that user to the caller, so their next first message forms a fresh request; a
still-pending request is kept. Unblocking someone who is not blocked is a
no-op and leaves any decided request in place.

**Auth:** Required

---

## Invite Endpoints

All invite endpoints require authentication and the `MANAGE_INVITES` permission.

### POST /api/v1/invites

Create a new invite code.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Request

```json
{
  "max_uses": 5,
  "expires_in_hours": 48
}
```

Both fields are optional. An empty body (or `0`) creates an invite with unlimited uses and no expiry; a negative value is `400 BAD_REQUEST`.

#### Response 201 Created

```json
{
  "id": 1,
  "code": "abc123def",
  "max_uses": 5,
  "uses": 0,
  "expires_at": "2026-03-30T10:30:00Z",
  "revoked": false,
  "created_at": "2026-03-28T10:30:00Z",
  "creator_username": ""
}
```

---

### GET /api/v1/invites

List all invites (active, expired, and revoked).

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 200 OK

Returns a JSON array of invite objects, newest first (at most 200). Each carries `creator_username`, the creator's username (empty once that account is erased); the create response leaves it empty.

---

### DELETE /api/v1/invites/{code}

Revoke an invite by its code string.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 204 No Content

---

### GET /api/v1/invites/{code}/redemptions

List who redeemed an invite, newest first (at most 200 rows). An unknown code is `404 NOT_FOUND`.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 200 OK

```json
[
  { "user_id": 42, "username": "alice", "redeemed_at": "2026-09-29 10:30:00" },
  { "user_id": null, "username": "", "redeemed_at": "2026-09-28 18:02:11" }
]
```

`user_id` is `null` (and `username` empty) once the redeemer's account has been erased. Uses from before migration 055 have no row, so the list can be shorter than the invite's `uses`.

---

## File Upload and Serving

### POST /api/v1/uploads

Upload a file as multipart form data.

**Auth:** Required
**Rate limit:** 10 requests/minute, and at most 10 uploads in flight per user (`429 RATE_LIMITED` beyond that)
**Body size limit:** 100 MiB, or `upload.max_size_mb` plus 1 MiB of multipart framing when that is larger. A file over `upload.max_size_mb` is refused with `400 BAD_REQUEST` ("file exceeds maximum size of N MB"). The parts after `file` are read to the end too: a body padded past the cap is refused with `413 PAYLOAD_TOO_LARGE` and a malformed tail with `400 BAD_REQUEST`, and the stored file is deleted.
**Content-Type:** `multipart/form-data`

Files are validated against blocked magic bytes (PE executables, ELF binaries, Mach-O binaries, shell scripts). Files are stored with UUID filenames.

Before any of its bytes are read, the file name is checked against the server's file-type policy (`upload.blocked_extensions` and `upload.allowed_extensions` in config.yaml, or the owner's saved `upload_blocked_extensions`/`upload_allowed_extensions` settings, which replace them). Matching is case-insensitive and looks only at the final extension, the one Windows opens the file by, so `report.pdf.bat` is refused when `bat` is blocked and `report.bat.pdf` is not; trailing dots and spaces are ignored. A non-empty allowed list means only those final extensions are accepted. A refused name gets `400 BAD_REQUEST` ("upload rejected: blocked file type: .bat"), the same shape as a magic-byte refusal. Allowing an extension never lifts the magic-byte blocks.

#### Voice messages

A voice message is an ordinary attachment that also carries its length and a small waveform, so a client can draw the player before it downloads the file (server capability `voice_messages`, WP 8.9). Send both as query parameters, not form fields:

| Parameter           | Value                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `voice_duration_ms` | Clip length in milliseconds, a decimal integer from 1 to 300000                            |
| `voice_waveform`    | Amplitude bytes, base64url without padding (`RawURLEncoding`), 1 to 256 bytes once decoded |

Send both or neither; with neither the upload is an ordinary one, exactly as before. One alone, a number out of range or not a plain decimal, a waveform that is not valid unpadded base64url or decodes outside 1 to 256 bytes, or a repeated parameter is refused with `400 BAD_REQUEST` before any quota is reserved or any of the body is read. After the type is sniffed from the file's own bytes, a voice upload whose type is not `audio/*`, `video/webm`, `video/mp4` or `application/ogg` is refused with `400 BAD_REQUEST` and the stored file is deleted. The waveform is stored as the canonical encoding of the decoded bytes. Each upload is its own attachment: sending the same clip again (a retry after a dropped connection) makes a second, independent row. The two values come back on the attachment of the message that carries it, in history, pins, threads and forwarded copies.

#### Response 201 Created

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "filename": "photo.jpg",
  "size": 204800,
  "mime": "image/jpeg",
  "url": "/api/v1/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "width": 1920,
  "height": 1080
}
```

`width` and `height` are only present for image files. `duration_ms` (integer) and `waveform` (string, the canonical base64url form) are only present for a voice upload and are omitted otherwise.

---

### DELETE /api/v1/uploads/{id}

Withdraw a file you uploaded and never sent. The file and its row are deleted
and its size stops counting against `upload.user_quota_mb` at once, instead of
when the hourly sweep of unsent uploads removes it. The client calls this when
you remove an attachment from the composer, and before it re-uploads one that
has been waiting too long.

**Auth:** Required

#### Response 204 No Content

| Status | Code        | When                                                                                                 |
| ------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| 404    | `NOT_FOUND` | No such upload, it belongs to someone else, a message already holds it, or it is your current avatar |

---

### GET /api/v1/users/me/storage

How much of the upload quota the caller has used, for the My uploads page. Rate-limited with the `uploads:` bucket (120 requests a minute, shared with the two routes below).

**Auth:** Required

#### Response 200 OK

`{ "used_bytes": 1234, "quota_bytes": 104857600 }`. `used_bytes` is the same counter uploads are admitted against, so it includes sent files, unsent uploads and the caller's avatar and banner; a user who never uploaded reads `0`. `quota_bytes` is `upload.user_quota_mb` in bytes, and `0` means no limit.

---

### GET /api/v1/users/me/uploads

The files the caller uploaded, in every state, across all channels and DMs. Rate-limited with the `uploads:` bucket.

**Auth:** Required

| Query    | Description                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `sort`   | `newest` (default: upload time, then id, descending) or `largest` (size, then id, descending)             |
| `q`      | Keeps file names containing this text (ASCII case-insensitive, matched literally), at most 100 characters |
| `cursor` | The previous page's `next_cursor`; a cursor from the other `sort` is refused                              |
| `limit`  | Page size, default 50, at most 100                                                                        |

#### Response 200 OK

```json
{
  "items": [
    {
      "attachment": {
        "id": "…",
        "filename": "photo.png",
        "size": 52113,
        "mime": "image/png",
        "url": "/api/v1/files/…"
      },
      "uploaded_at": "2026-10-30 05:00:00",
      "channel_id": 12,
      "message_id": 4410,
      "state": "message",
      "removable": true
    }
  ],
  "next_cursor": "…"
}
```

`attachment` has the same shape as a message's attachments. `next_cursor` is omitted on the last page; it is opaque and encodes the last item's sort key and id, so files uploaded while a viewer pages never repeat or shift a page. `channel_id` and `message_id` are set while a message holds the file and `null` otherwise; the response never carries a channel name, so a channel the caller lost access to leaks nothing. `state` is one of:

| State        | Meaning                                                                    | `removable` |
| ------------ | -------------------------------------------------------------------------- | ----------- |
| `message`    | Held by a live message                                                     | `true`      |
| `deleted`    | Held by a deleted message; still counted until the orphan sweep removes it | `true`      |
| `pending`    | Uploaded, never sent, and not in use                                       | `true`      |
| `avatar`     | A current avatar                                                           | `false`     |
| `banner`     | A current profile banner                                                   | `false`     |
| `group_icon` | A current group DM icon                                                    | `false`     |

`400 BAD_REQUEST` for an unknown `sort`, a malformed `cursor`, a `q` over 100 characters or a `limit` that is not a positive integer.

---

### DELETE /api/v1/users/me/uploads/{id}

Remove one of the caller's own files, wherever it sits: unsent, in a message, or in a message since deleted. The row and the stored bytes are deleted and the size stops counting against the quota at once. Rate-limited with the `uploads:` bucket.

**Auth:** Required

If a message held the file, its readers are told over the WebSocket. A message left with no text, no files and no poll, sticker or forward is deleted like any own delete (`chat_deleted`, with mention reversal and audit); if that delete is refused, for example in an archived channel, it is announced as changed instead. Any other message is sent as a [`chat_edited`](protocol.md#chat_edited-server---client-broadcast) carrying its remaining `attachments`, with `edited_at` unchanged. Forwards hold their own copies of a file, so removing the original leaves them intact.

#### Response 204 No Content

| Status | Code        | When                                                                                                                     |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 404    | `NOT_FOUND` | No such file, it belongs to someone else, or it is already gone (including a second device removing it at the same time) |
| 409    | `CONFLICT`  | The file is a current avatar, profile banner or group DM icon; change that first                                         |

---

### GET /api/v1/files/{id}

Serve a previously uploaded file by its UUID.

**Auth:** Required (Bearer token) — downloads are access-controlled
**Caching:** `Cache-Control: private, no-cache` (never stored by shared/proxy caches; browsers must revalidate)

Supports HTTP range requests and conditional requests. MIME types that could
execute under the app origin (HTML, SVG, XML, PDF) are served with
`Content-Disposition: attachment` to force download.

---

### GET /api/v1/files/{id}/thumb

Serve a preview of an image file, for showing it inline. The full file stays
at `GET /api/v1/files/{id}`.

**Auth:** Required (Bearer token), with exactly the access rule of
`GET /api/v1/files/{id}` (channel read, DM participation, the uploader for an
unlinked file, and any NSFW acknowledgement) and the same headers.

A JPEG or PNG larger than 800×800 is scaled to fit an 800×800 box, in the same
format, turned upright by its EXIF orientation. Any other image — one that
already fits, a GIF (kept animated), another format, one too large to decode
within the server's memory bound (judged from its header, so a 16-bit image
or a progressive JPEG reaches it at fewer pixels) or one that does not decode —
is served as the original bytes. A file that is not an image is a `404`.

A HEIC, HEIF or TIFF file (stored as `image/heic`, `image/heif` or `image/tiff`,
which the server tells apart by the file's own bytes) is the exception, because
no webview shows one: the response is always a JPEG with `Content-Type:
image/jpeg`, scaled to fit the 800×800 box when larger (never enlarged) and
turned upright by the file's rotation. Only a HEIC with the plain still-image layout is converted. The file has only
ftyp, meta, mdat, free and skip boxes (no movie or fragment boxes), and its
items, locations and property associations are listed once each. Its primary
item is a coded image or a grid of them. A grid's descriptor may sit in the
file or in the meta box's idat (as phones write it), and it lists each tile
once. The images the decoder reads (the primary item, a grid's tiles and any
alpha auxiliary image) are held to the layout: item data in the file body,
one base-layer picture each, parameter sets only in the decoder configuration,
and the properties the converter reads (ispe, hvcC, pixi, auxC, irot, imir,
clap, colr). Items the decoder never reads — Exif and XMP, a tone map (tmap),
thumbnails and other auxiliary images such as a depth or gain map — may carry
anything. An overlay (iovl) or other derived primary item is not converted. A HEIC
larger than about 22 megapixels (half as many at 10 bits), or a TIFF whose
decode would take more than the 96 MiB bound (judged from its header), is not
converted. If it cannot be converted — it is outside that layout, does not
decode, is too large, or the decoder fails — the response is a `404`, never
the original bytes. The failure is remembered and not tried again, and the
file is stored without dimensions. A camera RAW (DNG, NEF, CR2, ARW and the
like) is TIFF-structured but is stored as `application/octet-stream` and stays
a plain file. The original stays at
`GET /api/v1/files/{id}`. A file uploaded before the server knew these formats
was stored as `application/octet-stream` and stays a plain file.

A thumbnail is made on the first request, kept beside the original under
`upload.storage_dir/thumbs/`, and removed with it; an image that fails to
decode is remembered there too and not tried again. A server that has this
route says so with `upload_policy.thumbnails` on `auth_ok`.

---

## Custom Emoji

Server-wide custom emoji, usable as `:shortcode:` in message content and as
reaction strings.

**Permission model.** Reading the set is open to any authenticated member —
an emoji nobody can render is not an emoji, and the set is server-wide with no
per-channel scope to leak. Adding and removing require **MANAGE_SERVER**.

That is a deliberate reuse rather than a new permission bit: a bit is a
schema-visible, forever decision, and "who may change server-wide branding" is
exactly what MANAGE_SERVER already answers for the server name, icon and
settings. There is no `MANAGE_EMOJI`.

### GET /api/v1/emoji

List every custom emoji, ordered by shortcode.

**Auth:** Required

#### Response 200 OK

```json
[
  { "id": 3, "shortcode": "wave", "url": "/api/v1/emoji/3/image" },
  { "id": 7, "shortcode": "party_blob", "url": "/api/v1/emoji/7/image" }
]
```

`url` is server-relative and authenticated — see GET /api/v1/emoji/{id}/image.

---

### POST /api/v1/emoji

Upload one custom emoji as multipart form data.

**Auth:** Required — **MANAGE_SERVER**
**Rate limit:** 10 requests/minute per user
**Body size limit:** 1 MiB (the image itself is capped at 512 KiB)
**Content-Type:** `multipart/form-data`

| Field       | Type   | Notes                                                                                                                                           |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `shortcode` | string | `[a-z0-9_]{2,32}`; surrounding colons are stripped and the value is lowercased before validation, so `:WAVE:` and `wave` are the same shortcode |
| `file`      | file   | PNG, JPEG, GIF or WebP                                                                                                                          |

Validation, in the order it is applied — the permission check runs before the
multipart body is read, so a member without the bit never causes a spool to
disk:

1. MANAGE_SERVER, then the rate limit, then the shortcode format.
2. At most **512 KiB** of image bytes.
3. The MIME type is **sniffed from the file's own bytes**, never taken from the
   client's part header. Only `image/png`, `image/jpeg`, `image/gif` and
   `image/webp` are accepted. SVG is refused outright: it is markup with script
   and external-fetch capability, and an emoji is by definition rendered inline.
4. Dimensions are re-read from the sniffed image (WebP headers are parsed
   directly, since the standard library has no WebP decoder) and must be at
   most **128 x 128**.
5. Shortcodes are unique case-insensitively; a collision is `409 CONFLICT`.
6. A server holds at most 200 emoji.

On success the full set is broadcast as `emoji_update` (see protocol.md), so
every connected client converges without a reconnect.

#### Response 201 Created

```json
{ "id": 3, "shortcode": "wave", "url": "/api/v1/emoji/3/image" }
```

#### Errors

| Status | Code           | Cause                                           |
| ------ | -------------- | ----------------------------------------------- |
| 400    | `BAD_REQUEST`  | bad shortcode, wrong format, too large, too big |
| 403    | `FORBIDDEN`    | caller lacks MANAGE_SERVER                      |
| 409    | `CONFLICT`     | an emoji with that shortcode already exists     |
| 429    | `RATE_LIMITED` | upload rate limit exceeded                      |

---

### GET /api/v1/emoji/{id}/image

Serve one emoji's image bytes.

**Auth:** Required (Bearer token)
**Caching:** `Cache-Control: private, max-age=86400, immutable`

Authenticated rather than public so an emoji cannot be used as an
unauthenticated tracking pixel hosted on someone else's server. There is no
per-channel ACL to apply — emoji are server-wide by construction, so
authentication is the whole check. An emoji's bytes never change for a given
id (a replacement is a new row), which is what lets the response be cached
hard. Unknown ids answer 404.

---

### DELETE /api/v1/emoji/{id}

Delete one custom emoji and unlink its stored file.

**Auth:** Required — **MANAGE_SERVER**

Messages and reactions that used the shortcode fall back to rendering the
literal `:shortcode:` text. Broadcasts `emoji_update` on success.

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                        |
| ------ | ------------- | ---------------------------- |
| 400    | `BAD_REQUEST` | id is not a positive integer |
| 403    | `FORBIDDEN`   | caller lacks MANAGE_SERVER   |
| 404    | `NOT_FOUND`   | no emoji with that id        |

---

## Custom Stickers

Server-wide custom stickers (WP 8.8a), sent as their own message with
`chat_send.sticker_id` (see `docs/protocol.md`).

**Permission model.** The same as custom emoji: reading the set is open to any
authenticated member, and adding, renaming and removing require
**MANAGE_SERVER**. There is no `MANAGE_STICKERS` bit.

A sticker has a `name` (2 to 30 characters of ASCII letters, digits, space,
underscore or hyphen; the case typed is kept, trimmed, and uniqueness ignores
case), an optional related `emoji` the picker searches by (a single emoji or a
`:shortcode:` of a custom emoji, at most 64 bytes) and an image. A server holds
at most 60 stickers.

### GET /api/v1/stickers

List every sticker, ordered by name ignoring case.

**Auth:** Required

#### Response 200 OK

```json
[
  { "id": 3, "name": "Wave", "emoji": "👋", "url": "/api/v1/stickers/3/image" },
  { "id": 7, "name": "Party Blob", "emoji": null, "url": "/api/v1/stickers/7/image" }
]
```

`url` is server-relative and authenticated, see GET /api/v1/stickers/{id}/image.

---

### POST /api/v1/stickers

Upload one sticker as multipart form data.

**Auth:** Required, **MANAGE_SERVER**
**Rate limit:** 10 requests/minute per user
**Body size limit:** 1 MiB (the image itself is capped at 512 KiB)
**Content-Type:** `multipart/form-data`

| Field   | Type   | Notes                                                         |
| ------- | ------ | ------------------------------------------------------------- |
| `name`  | string | 2 to 30 characters of `[A-Za-z0-9 _-]` after trimming         |
| `emoji` | string | Optional. A single emoji or a `:shortcode:`, at most 64 bytes |
| `file`  | file   | PNG, GIF or WebP; animated GIF and WebP are allowed           |

Validation, in the order it is applied. The permission check runs before the
multipart body is read, so a member without the bit never causes a spool to disk:

1. MANAGE_SERVER, then the rate limit, then the name and emoji format.
2. At most **512 KiB** of image bytes.
3. The MIME type is **sniffed from the file's own bytes**, never taken from the
   client's part header. Only `image/png`, `image/gif` and `image/webp` are
   accepted. JPEG and SVG are refused.
4. Dimensions are re-read from the sniffed image and must be at most
   **320 x 320**.
5. Names are unique ignoring case; a collision is `409 CONFLICT`. Two uploads of
   the same name at once give one `201` and one `409`, and the loser leaves no
   file behind.
6. A server holds at most 60 stickers.

On success the full set is broadcast as `sticker_update` (see protocol.md).

#### Response 201 Created

```json
{ "id": 3, "name": "Wave", "emoji": "👋", "url": "/api/v1/stickers/3/image" }
```

#### Errors

| Status | Code           | Cause                                                     |
| ------ | -------------- | --------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | bad name or emoji, wrong format, too large, too big, full |
| 403    | `FORBIDDEN`    | caller lacks MANAGE_SERVER                                |
| 409    | `CONFLICT`     | a sticker with that name already exists                   |
| 429    | `RATE_LIMITED` | upload rate limit exceeded                                |

---

### PATCH /api/v1/stickers/{id}

Rename a sticker and set or clear its related emoji. The image never changes.

**Auth:** Required, **MANAGE_SERVER**
**Content-Type:** `application/json`

```json
{ "name": "Hello", "emoji": "" }
```

Both fields are optional. An absent `name` or `emoji` is kept, and `"emoji": ""`
clears it. Broadcasts `sticker_update` on success. Messages that used the sticker
keep the name they were sent with.

#### Response 200 OK

The updated sticker, in the shape of the list entries.

#### Errors

| Status | Code          | Cause                                           |
| ------ | ------------- | ----------------------------------------------- |
| 400    | `BAD_REQUEST` | id is not a positive integer, bad name or emoji |
| 403    | `FORBIDDEN`   | caller lacks MANAGE_SERVER                      |
| 404    | `NOT_FOUND`   | no sticker with that id                         |
| 409    | `CONFLICT`    | another sticker already has that name           |

---

### GET /api/v1/stickers/{id}/image

Serve one sticker's image bytes.

**Auth:** Required (Bearer token)
**Caching:** `Cache-Control: private, max-age=86400, immutable`

Authenticated rather than public, for the same reason the emoji image is. A
sticker is server-wide, so authentication is the whole check. Its bytes never
change for a given id. Unknown ids answer 404.

---

### DELETE /api/v1/stickers/{id}

Delete one sticker and unlink its stored file.

**Auth:** Required, **MANAGE_SERVER**

Messages that carried the sticker stay, with their name and a `null` `id` and
`url` in `sticker`. Broadcasts `sticker_update` on success.

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                        |
| ------ | ------------- | ---------------------------- |
| 400    | `BAD_REQUEST` | id is not a positive integer |
| 403    | `FORBIDDEN`   | caller lacks MANAGE_SERVER   |
| 404    | `NOT_FOUND`   | no sticker with that id      |

---

## Reports and the moderation queue

Local report intake, greenfield since B5-8 (BPR-070, BPR-071's server half).
There is no cross-server or central delivery of any kind — every route below
is served by this server alone, over its own database (see
`TestAbsenceContract_NoCentralOrCrossServerReportDelivery`).

`MODERATE_MEMBERS` is granted automatically only to an untouched, default
Moderator role. If that role was ever renamed or had its permissions edited
before upgrading to a server version carrying this bit, the queue has no
reader by default — grant "Moderate Members" to the role that should have it
by hand, in the admin panel's role grid.

### POST /api/v1/reports

File a report against a message, a user or an attachment. **Auth:**
Required. Rate-limited: 5 per 10 minutes per reporter.

The subject is derived by the server from the target (the message's author,
the attachment's uploader, or the user named) — it is never read from the
body, so there is no field for it.

#### Request

```json
{
  "target_type": "message",
  "target_id": "1234",
  "reason": "harassment",
  "detail": "optional free text, at most 2000 runes, no control characters"
}
```

`target_type` is one of `message`, `user`, `attachment`. `reason` is one of
`spam`, `harassment`, `nsfw_unlabelled`, `illegal`, `other`.

#### Response 201 Created

```json
{ "id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9" }
```

`id` is an opaque 32-character hex string (16 random bytes), never the
report's sequential internal id — every response, route parameter and the
`mod_queue` frame carry this public id only. Reports are filed in sequence
server-side, so a bit holder who can see reports 1 and 3 but not 2 could
otherwise infer report 2 concerns them; the public id carries no order.

#### Errors

| Status | Code               | Cause                                                                                        |
| ------ | ------------------ | -------------------------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT`    | invalid `target_type`/`reason`, missing `target_id`, or `detail` too long/unsafe             |
| 404    | `NOT_FOUND`        | the target does not exist, or the reporter cannot see it (never `403` — no existence oracle) |
| 409    | `DUPLICATE_REPORT` | the reporter already has an open or assigned report against this exact target                |
| 429    | `RATE_LIMITED`     | more than 5 reports from this reporter in 10 minutes                                         |

---

### GET /api/v1/reports/mine

The caller's own reports: id, target type, reason, state, outcome,
`created_at`, `closed_at`. Never the assignee, never the internal notes.
`id` is the opaque public id (see above).

**Auth:** Required.

#### Response 200 OK

```json
[
  {
    "id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9",
    "target_type": "message",
    "reason": "harassment",
    "state": "assigned",
    "outcome": "",
    "created_at": "2026-09-05T10:00:00Z",
    "closed_at": null
  }
]
```

---

### GET /api/v1/moderation/queue

The moderator queue. **Auth:** Required. **Permission:** `MODERATE_MEMBERS`
(or `ADMINISTRATOR`), through the canonical predicate (`CanModerate`) — never
a raw bit check.

**Query:** `state` — `open`, `assigned` or `closed` (every terminal state);
omitted defaults to open+assigned together. Newest first. A report whose
subject is the caller is excluded even when it would otherwise match — the
confidentiality rule applies to the listing, not only to `GET .../{id}`.

#### Response 200 OK

Returns a JSON array of queue rows, each carrying the reporter's and
subject's usernames but never the report's free-text detail or its notes.

---

### GET /api/v1/moderation/queue/{id}

One report, its evidence snapshot, its internal notes and its immutable
history (`events`: `created`, `assigned`, `noted`, `closed`, each with an
actor id and a state-or-outcome-word detail — never free text). `{id}` is
the opaque public id, resolved to the internal id server-side before any
lookup. **Auth:** Required. **Permission:** `MODERATE_MEMBERS` (or
`ADMINISTRATOR`).

The history lives in its own table (`report_events`), never the shared
audit log — `VIEW_AUDIT_LOG` grants no route to any of it, only the same bit
and confidentiality gate this endpoint already enforces.

`404 NOT_FOUND` both for a missing id and for a report whose SUBJECT is the
caller — indistinguishable, even when the caller holds the bit: the subject
of a report must never learn one exists. A moderator who is instead the
report's REPORTER may read it (their own filing, already visible via
`GET /api/v1/reports/mine`), but `notes` is always `[]` for them — internal
notes never reach the person who filed the report.

The evidence snapshot is content from the report's source channel
(`channel_id`), so it follows that channel's NSFW consent (B5-7, decision
13): while the channel is labelled, `evidence` is `[]` and
`evidence_withheld` is `NSFW_ACKNOWLEDGEMENT_REQUIRED` unless the caller
has acknowledged it themselves (`PUT /api/v1/channels/{id}/nsfw-acknowledgement`)
— no bit, `ADMINISTRATOR` included, bypasses this. Label and
acknowledgement are read on every request, so a revoke, an unlabel and
relabel, or a label added after filing applies to the next read. When the
source channel has been deleted, the snapshot stays readable only if that
channel was never labelled while the report existed (`reports.source_nsfw`,
migration 052). Otherwise, including when that is unknown, `evidence` is
`[]` and `evidence_withheld` is `SOURCE_CHANNEL_UNAVAILABLE`. `evidence_withheld` is omitted when the
snapshot is returned. Files the snapshot references are served by
`GET /api/v1/files/{id}` under that route's own channel and consent checks.
Once the source channel is deleted the file is unlinked, and that route
serves it only to its uploader — `ADMINISTRATOR` included.

---

### POST /api/v1/moderation/queue/{id}/assign

Assign the report to the caller. `{id}` is the opaque public id. **Auth:**
Required. **Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`).

**Query:** `force=1` reassigns a report already assigned to someone else,
and only succeeds when the caller outranks the current assignee (the same
hierarchy rule ban/kick/timeout use).

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                                                                              |
| ------ | ------------- | -------------------------------------------------------------------------------------------------- |
| 403    | `FORBIDDEN`   | caller lacks `MODERATE_MEMBERS`, or `force=1` without outranking                                   |
| 403    | `SELF_REVIEW` | caller is the report's own reporter — a moderator may not act on a report they filed               |
| 404    | `NOT_FOUND`   | no such report, or its subject is the caller                                                       |
| 409    | `CONFLICT`    | already assigned to someone else and `force` was not set, or the report is no longer open/assigned |

---

### POST /api/v1/moderation/queue/{id}/notes

Add an internal note, visible to `MODERATE_MEMBERS` holders only — never to
the reporter, never to the subject. `{id}` is the opaque public id. **Auth:**
Required. **Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`). `403
SELF_REVIEW` if the caller is the report's own reporter; `409 CONFLICT` if
the report is not open or assigned (a note may not land on a report a
concurrent close just closed) or if the moderator account no longer exists.

#### Request

```json
{ "body": "at most 4000 runes, no control characters" }
```

#### Response 204 No Content

---

### POST /api/v1/moderation/queue/{id}/close

Close the report. `{id}` is the opaque public id. **Auth:** Required.
**Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`). `403 SELF_REVIEW` if
the caller is the report's own reporter.

#### Request

```json
{ "outcome": "actioned" }
```

`outcome` is one of `actioned`, `no_action`, `duplicate`. `open` and
`assigned` may both close directly (assigning first is not required).
Nothing leaves a closed state — closing an already-closed report answers
`409 CONFLICT`, including under a concurrent double-close.

#### Response 204 No Content

---

### Member actions: `/api/v1/moderation/members`

`GET /`, `PATCH /{id}` and `DELETE /{id}/sessions` are the member-list actions
of the desktop client (list members with their ban state, ban/unban and change
role, force logout). They run the same handlers, the same bearer-token
authentication and the same `ModerationService` permission and rank checks as
`/admin/api/users`, `/admin/api/users/{id}` and `/admin/api/users/{id}/sessions`
(request and response shapes are identical), but live outside `/admin` so a
reverse proxy that answers `/admin` with a web page does not break them, and
they are not subject to `server.admin_allowed_cidrs`. They accept only a
session or API token issued by this server (any other token gets `401`), with
the permission and rank checks. A member the caller does not
outrank, or a role at or above the caller's own, is refused with `403`.

### Channel actions: `/api/v1/moderation/channels`

`POST /`, `PATCH /{id}` and `DELETE /{id}` are the channel create, edit and
delete actions of the desktop client. They run the same handlers, with the same
request and response shapes, as `POST /admin/api/channels` and
`PATCH`/`DELETE /admin/api/channels/{id}`, but live outside `/admin` so a
reverse proxy that answers `/admin` with a web page does not break them, and
they are not subject to `server.admin_allowed_cidrs`. They accept only a
session or API token issued by this server (any other token gets `401`) and
require `MANAGE_CHANNELS` (otherwise `403`).

### POST /api/v1/moderation/queue/{id}/act

Perform a moderator action against the report's subject (or, for
`"removal"`, the reported message) with `report_id` set on the ledger row,
in one transaction with the action's effect. `{id}` is the opaque public id.
**Auth:** Required. Reading the report first requires `MODERATE_MEMBERS` (or
`ADMINISTRATOR`) — the same read `GET .../{id}` gates; the action itself
then requires the bit that action needs (see the permission ladder below).
`403 SELF_REVIEW` if the caller is the report's own reporter.

#### Request

```json
{
  "kind": "timeout",
  "reason": "at most 500 runes, no control characters",
  "duration_seconds": 3600,
  "message_id": "1234"
}
```

`kind` is one of `warning`, `timeout`, `kick`, `ban`, `removal`.
`duration_seconds` applies to `timeout` only (60..2419200, i.e. 1 minute to
28 days). `message_id` applies to `removal` only, and defaults to the
report's own target when the report is against a message.

Dispatches through the exact same service call the direct route for that
`kind` uses, and sends the same post-commit transport: `ban` broadcasts
`member_ban` (and disconnects the target) exactly like
`PATCH /admin/api/users/{id}` does; `removal` broadcasts `chat_bulk_deleted`
for the removed message exactly like the channel purge route does.

#### Response 204 No Content

...for every `kind` except `timeout`, which answers `200 OK` with the same
`voice` outcome `POST .../timeout` returns:

```json
{ "voice": "applied" }
```

#### Errors

Same shape as `POST /api/v1/moderation/users/{id}/warn`/`timeout` below,
plus the report read's own `403 SELF_REVIEW` (also given when the caller
files the report and then tries to act on it themselves) and `404 NOT_FOUND`
(missing report, or the caller is its subject). A `removal` whose target
message is already deleted answers `409 ALREADY_DELETED` (never 404, which
would read as the report itself being gone).

---

## Moderator actions

Warning, timeout, kick and ban (BPR-072), narrowly permissioned per action —
gating a gentle warning on the ability to ban would invert the moderation
ladder:

| Action                   | Permission                   |
| ------------------------ | ---------------------------- |
| Warning                  | `MODERATE_MEMBERS`           |
| Timeout / lift a timeout | `MODERATE_MEMBERS`           |
| Content removal          | `MANAGE_MESSAGES` (existing) |
| Kick                     | `KICK_MEMBERS` (existing)    |
| Ban                      | `BAN_MEMBERS` (existing)     |

**Kick's real meaning.** OwnCord is single-server, so "remove from guild"
has no referent — kick is `ForceLogout`: every session of the target is
revoked and they must sign in again. It does not restrict the account from
returning immediately.

Every action writes a row to the moderator-action ledger, in the same
transaction as its effect, so an appeal (B5-10) always has something to
reference.

**Removal is the one exception to the hierarchy rule below** (a conscious
decision, not an oversight): it is governed by channel `MANAGE_MESSAGES`
alone, exactly as message deletion always has been, with no requirement to
outrank the message's author — a channel moderator routinely removes content
from users the role hierarchy does not place them above. This holds through
every entry point removal has, including the report-linked `act` route.

Warning, timeout, kick and ban all additionally require the actor to
strictly outrank the target by role position (`requireOutranks`),
re-validated live at write time so a target promoted between the check and
the write is refused, not sanctioned. Self, a peer, a superior, and the
owner as target are all refused for these four kinds.

### POST /api/v1/moderation/users/{id}/warn

Issue a warning: an audited notice the target must acknowledge on next
connect. **Auth:** Required. **Permission:** `MODERATE_MEMBERS`.

#### Request

```json
{ "reason": "at most 500 runes, no control characters" }
```

#### Response 201 Created

```json
{ "id": 42 }
```

A live target also receives a `mod_action` frame
(`{"id":42,"kind":"warning","reason":"...","expires_at":null}`), targeted
and unsequenced.

#### Errors

| Status | Code          | Cause                                                           |
| ------ | ------------- | --------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | invalid id, self-target, or reason too long/unsafe              |
| 403    | `FORBIDDEN`   | caller lacks `MODERATE_MEMBERS`, or does not outrank the target |
| 404    | `NOT_FOUND`   | no such user                                                    |

---

### POST /api/v1/moderation/users/{id}/timeout

Time-box a restriction: the target cannot send or edit messages, add
reactions, join voice, start a new DM, create or rename a group DM, ring a DM
call, pin in a DM, or set a custom status while it is active
(`403 TIMED_OUT`). Reopening an existing DM and declining a call still work.
**Auth:** Required.
**Permission:** `MODERATE_MEMBERS`.

#### Request

```json
{ "reason": "at most 500 runes, no control characters", "duration_seconds": 3600 }
```

`duration_seconds` is bounded 60..2419200 (1 minute to 28 days).

#### Response 201 Created

```json
{ "id": 43, "voice": "applied" }
```

`voice` is `"applied"` only when the mute actually landed: the actor holds
effective `MUTE_MEMBERS` in the target's CURRENT voice channel specifically
(a channel-level deny, a room the actor cannot see, or — for a DM call — the
actor not being a participant all count as not holding it there, even with
the server-wide bit), the target is currently connected to voice, and the
underlying server-mute call actually matched a live connection. Every other
case — no channel authority there, the target not in voice at all, or a
channel-switch race that leaves the mute unmatched — answers `"skipped"`.
The timeout still lands for text and reactions either way; it never grants a
voice mute the actor could not perform through the ordinary voice-moderation
route. A live target also receives a `mod_action` frame carrying
`expires_at`. The restriction is live on the target's very next send — no
reconnect needed.

#### Errors

Same shape as `warn` above, plus `400 BAD_REQUEST` for a duration outside
60..2419200.

---

### POST /api/v1/moderation/users/{id}/untimeout

Lift an active timeout early, including its voice half if it was applied.
**Auth:** Required. **Permission:** `MODERATE_MEMBERS`.

#### Response 204 No Content

A live target also receives a `mod_action` frame with `expires_at: null`.

#### Errors

Same shape as `warn` above, plus `404 NOT_FOUND` when there is no active
timeout to lift.

---

### GET /api/v1/moderation/users/{id}/actions

The full moderator-action ledger for one user, newest first: kind, actor,
reason, timestamps, and the linked report's public id when one exists.
**Auth:** Required. **Permission:** `MODERATE_MEMBERS`.

A row's `report_id` is omitted (never rendered, not merely nulled) when the
caller is the confidential SUBJECT of that report — the same guard
`GET .../queue/{id}` applies, run per row here: holding `MODERATE_MEMBERS`
is not enough to read a report's id about yourself just because it happens
to be linked from your own action ledger.

---

### PUT /api/v1/moderation/users/{id}/nickname

Set or clear another member's nickname (`users.display_name`). **Auth:**
Required. **Permission:** `MANAGE_NICKNAMES` (the `ADMINISTRATOR` bypass
applies to the bit, never to the hierarchy). The actor must strictly outrank
the target by top role; the bit is read from the OR of every role the actor
holds. Both are re-checked inside the write transaction, so an actor who loses
the bit, or a target who is promoted, between the check and the write is
refused with nothing changed and nothing broadcast. A member changes their
own nickname with `PATCH /api/v1/users/me`, never this route.

`MANAGE_NICKNAMES` is granted automatically only to an untouched, default
Moderator role (the untouched Admin and the Owner already hold it). A
Moderator or Admin role that was renamed or had its permissions edited does
not hold it: grant "Manage Nicknames" to the role that should have it by hand,
in the admin panel's role grid.

#### Request

```json
{ "display_name": "at most 32 runes, or null / \"\" to clear" }
```

`display_name` must be present. The value goes through the same cleaning and
checks as the member's own edit (spaces collapsed; no control characters, line
breaks, invisible fillers or more than two stacked combining marks).

A name that equals, ignoring case, another account's username is refused with
`400`; the member's own username is allowed.

#### Response 200 OK

```json
{ "user_id": 7, "display_name": "Big Bird" }
```

`display_name` is `null` when cleared. Every connected client also receives
the usual `user_update` frame carrying the committed row. One `nickname_change`
audit row records the actor and the old and new nickname. Rate limit: 10 per
minute per actor, spent only after authorization.

#### Errors

| Status | Code            | Cause                                                                    |
| ------ | --------------- | ------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`   | `{id}` is not a positive integer                                         |
| 400    | `INVALID_INPUT` | self-target, `display_name` absent or not a string/null, or name refused |
| 403    | `FORBIDDEN`     | caller lacks `MANAGE_NICKNAMES`, or does not outrank the target          |
| 404    | `NOT_FOUND`     | no such user, or a pending account (only after the permission check)     |
| 429    | `RATE_LIMITED`  | over 10 changes a minute                                                 |

---

### POST /api/v1/users/me/notices/{id}/ack

Acknowledge a warning — own rows only. `{id}` is the ledger row id from
`ready`'s `notices` (see [protocol.md](protocol.md)). **Auth:** Required
(session).

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                                           |
| ------ | ------------- | --------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | id is not a positive integer                                    |
| 404    | `NOT_FOUND`   | not a warning, already acknowledged, or belongs to another user |

---

### GET /api/v1/users/me/moderation

The caller's own sanctions, read from the ledger, so they survive a restart
that live `mod_action` frames and `ready.notices` do not cover: every
`warning`, `timeout`, `removal` and `ban` row that another moderator applied
to the caller, newest first. Kicks are left out because nothing persists to
appeal. Self-targeted rows are left out too: a moderator's own channel purge
is recorded against the moderator but is not a sanction against them. A `ban` row can
only reach a caller whose ban has lapsed or been reversed, since a currently
banned caller cannot authenticate. A currently banned user still appeals out
of band, as [Appeals](#appeals) describes. Rows leave this list when the
retention sweep retires them (`moderation.action_retention_days`). Removal and
ban rows never retire, so the list holds the newest 200 rows.
**Auth:** Required (session); an API token gets 401. Rate-limited: 30 per minute per IP.

#### Response 200 OK

```json
[
  {
    "id": 42,
    "kind": "timeout",
    "reason": "cool off",
    "created_at": "2026-09-23 10:00:00",
    "expires_at": "2026-09-23 11:00:00",
    "lifted_at": null,
    "acknowledged_at": null,
    "appealable": true,
    "appeal": null
  },
  {
    "id": 17,
    "kind": "warning",
    "reason": "be nice",
    "created_at": "2026-09-20 09:12:44",
    "expires_at": null,
    "lifted_at": null,
    "acknowledged_at": "2026-09-20 09:30:01",
    "appealable": false,
    "appeal": { "id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9", "state": "open" }
  }
]
```

`id` is the ledger id that [`POST /api/v1/appeals`](#post-apiv1appeals) takes
as `action_id` and that the acknowledgement route above takes. `appealable`
follows the rules the appeal route itself applies: an appealable kind with no
appeal filed against it yet, in any state. `appeal` is the appeal filed
against this row (its opaque public id and state), or `null`. The response
never includes the acting moderator, who lifted the action, the linked
report, evidence, or moderator notes.

#### Errors

| Status | Code           | Cause                       |
| ------ | -------------- | --------------------------- |
| 429    | `RATE_LIMITED` | more than 30 reads a minute |

---

## Appeals

Rate-limited appeals against a moderation action (BPR-073, plan decision 8).
`action_id` is the moderator-action ledger's own id (the caller's own `GET
/api/v1/users/me/moderation` row `id`, `GET
/api/v1/moderation/users/{id}/actions`'s `id`, or the `id` a live
`mod_action` frame or a `ready` notice already carried to the target) — not
an opaque public id; only reports and appeals carry one of those.

**Appealable kinds:** `warning`, `timeout`, `removal`, and `ban`. Kick is
never appealable — a force-logout persists nothing to reverse, the target
simply signs back in. A **ban appeal has no path here while the ban is still
in effect**: every route in this API rejects a currently effectively-banned
caller (`api/middleware.go`), including this one, so a `ban`-kind
submission can only ever arrive from a target whose ban has since lapsed or
been reversed. A ban appeal from a target who is still banned must arrive
out of band — the operator's own contact channel — until a later phase adds
one.

### POST /api/v1/appeals

File an appeal against a moderation action. **Auth:** Required. Rate-limited:
3 per 24 hours per appellant (a "blocked appellant" per decision 8 — over
the window, the caller submits nothing).

#### Request

```json
{ "action_id": 42, "body": "at most 4000 runes, no control characters" }
```

#### Response 201 Created

```json
{ "id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9" }
```

`id` is an opaque 32-character hex string, the same shape reports' public id
uses and for the identical reason — appeals are filed in sequence
server-side, so a moderator who can see appeals 1 and 3 but never 2 could
otherwise infer appeal 2 concerns someone specific.

#### Errors

| Status | Code               | Cause                                                                                      |
| ------ | ------------------ | ------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`      | invalid `action_id`, body too long/unsafe, or the action's kind is not appealable (`kick`) |
| 404    | `NOT_FOUND`        | no such action, or the caller is not its target (never `403` — no existence oracle)        |
| 409    | `ALREADY_APPEALED` | an appeal against this action already exists, in any state                                 |
| 429    | `RATE_LIMITED`     | more than 3 appeals from this appellant in 24 hours                                        |

---

### GET /api/v1/appeals/mine

The caller's own appeals: id, the appealed action's kind/reason/
`created_at`, state, `decision_note` (once decided), `created_at`,
`decided_at`. **Auth:** Required.

A state change (assignment, decision, or withdrawal) sends the appellant an
`appeal_status` frame — see [protocol.md](protocol.md).

---

### POST /api/v1/appeals/{id}/withdraw

Withdraw the caller's own appeal — the appellant only, `open` or `assigned`
states only. `{id}` is the opaque public id. **Auth:** Required. Sends the
appellant an `appeal_status` frame and a connected moderator queue a
`mod_queue` `"withdrawn"` frame, both under decision 8's per-appeal write
ordering (a delayed assignment or decision can never notify out of order
with this one) — see [protocol.md](protocol.md).

#### Response 204 No Content

#### Errors

| Status | Code        | Cause                                         |
| ------ | ----------- | --------------------------------------------- |
| 404    | `NOT_FOUND` | no such appeal, or it belongs to someone else |
| 409    | `CONFLICT`  | the appeal is already decided                 |

---

### GET /api/v1/moderation/appeals

The moderator appeal queue. **Auth:** Required. **Permission:**
`MODERATE_MEMBERS` (or `ADMINISTRATOR`).

**Query:** `state` — `open`, `assigned` or `decided` (both `upheld` and
`overturned` together); omitted defaults to open+assigned together.

**The appellant's own appeal rule:** a moderator viewing this queue never
sees their OWN filed appeal in the list, even when it matches the requested
state — the same confidentiality rule reports apply between the reporter
and the subject. Their own appeal's state is still visible through `GET
/api/v1/appeals/mine` and the live `appeal_status` frame; only the
moderation-facing surfaces built for reviewing OTHER people's appeals hide
it.

---

### GET /api/v1/moderation/appeals/{id}

One appeal, the appealed action, and the action's linked report's public id
when the action was report-linked. `{id}` is the opaque public id. **Auth:**
Required. **Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`).

The appellant's own appeal rule applies here too: a moderator requesting
their OWN appeal's detail gets `403 SELF_REVIEW`, not the row — it would
otherwise show them who is assigned and who decided, neither of which is
visible on the appeal surfaces any other way. The acting moderator's
identity is a narrower case: this response would be the first appeal
surface to show it, but a moderator (holding `MODERATE_MEMBERS`) can
already see it via the moderation ledger (`GET
/api/v1/moderation/users/{id}/actions`), so the 403 does not newly hide
that fact from them — only from a non-moderator appellant, who cannot
reach the ledger either way.

#### Errors

| Status | Code          | Cause                                     |
| ------ | ------------- | ----------------------------------------- |
| 403    | `FORBIDDEN`   | caller lacks `MODERATE_MEMBERS`           |
| 403    | `SELF_REVIEW` | the caller is this appeal's own appellant |
| 404    | `NOT_FOUND`   | no such appeal                            |

---

### POST /api/v1/moderation/appeals/{id}/assign

Assign the appeal to the caller. `{id}` is the opaque public id. **Auth:**
Required. **Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`).

**Query:** `force=1` reassigns an appeal already assigned to someone else,
and only succeeds when the caller outranks the current assignee (the same
hierarchy rule ban/kick/timeout and the report queue use).

**Two self-review rules apply, and they are different:** the moderator who
took the appealed action may not assign it to themself **where another
eligible moderator exists** (decision 8's deciding-moderator rule, applied
symmetrically to assignment) — on a one-moderator install, where no one
else is eligible, they may. Separately, and with **no such escape**, the
appellant themself may never assign their own filed appeal, even if they
independently hold `MODERATE_MEMBERS` — a governance gap on a
one-moderator install, not a bug this route papers over.

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                                                                                |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------- |
| 403    | `FORBIDDEN`   | caller lacks `MODERATE_MEMBERS`, or `force=1` without outranking                                     |
| 403    | `SELF_REVIEW` | the caller is this appeal's own appellant, or the acting moderator where another eligible one exists |
| 404    | `NOT_FOUND`   | no such appeal                                                                                       |
| 409    | `CONFLICT`    | already assigned to someone else and `force` was not set, or the appeal is no longer open/assigned   |

---

### POST /api/v1/moderation/appeals/{id}/decide

Decide the appeal. `{id}` is the opaque public id. **Auth:** Required.
**Permission:** `MODERATE_MEMBERS` (or `ADMINISTRATOR`).

**Overturning carries the reversal's own authority.** Reversing an appeal
against a warning, timeout or ban requires the decider to strictly outrank
the sanctioned target — the same hierarchy rule the direct lift paths
enforce — so a moderator cannot reverse an action taken against a peer or a
higher-ranked user, even one the owner issued. Overturning a **ban**
additionally requires `BAN_MEMBERS`, mirroring `UnbanUser`; a
`MODERATE_MEMBERS`-only holder cannot clear a ban through the appeal queue.
Overturning a **removal** is record-only (the content is already gone) and
needs no authority beyond `MODERATE_MEMBERS`. Upholding reverses nothing and
needs no such authority.

**Two self-review rules apply, and they are different:** the moderator who
took the appealed action may not decide its appeal **where another eligible
moderator exists** — eligible meaning a different user holding
`MODERATE_MEMBERS` or `ADMINISTRATOR`, and not currently banned. On a
one-moderator install, where no one else is eligible, the acting moderator
may decide their own appeal, and the audit row records that it was the
sole-moderator exception. Separately, and with **no such escape**, the
appellant themself may never decide their own filed appeal, even if they
independently hold `MODERATE_MEMBERS`.

#### Request

```json
{ "outcome": "overturned", "note": "at most 2000 runes, no control characters" }
```

`outcome` is one of `upheld`, `overturned`.

#### Response 204 No Content

**Effect of overturning:** the self-review check, the decision, and the
kind-specific ledger reversal below all commit in ONE transaction — a
decider who fails a fresh in-transaction check (their own `MODERATE_MEMBERS`
bit revoked, or a ban landed, since the request was authorized), or a
reversal that genuinely fails, leaves NOTHING committed: the appellant is
never told "overturned" while the sanction it named is still in effect.
The reversal targets the SPECIFIC appealed action by its ledger id, never
"whatever is currently active for this target" — appealing an older,
already-superseded timeout or ban cannot disturb a newer one. A `timeout`
is lifted; a `ban` is undone, but only if no strictly newer ban exists for
the same target (ban → unban → re-ban → overturn the first ban leaves the
target still banned); a `warning` is marked acknowledged, so the notice
disappears from the target's next connect. A `removal` has nothing to
restore — the reported content is already gone; overturning a removal
appeal is a record of the decision only. Upholding changes nothing further.
Each reversal that actually changes something writes its own audit row
(`user_untimeout`, `user_unban`, or a warning-acknowledged equivalent),
actor `0` (a mechanical consequence of the decision, not a second
moderation action by the human decider), alongside the decision's own
`appeal_decide` row. A ban that is actually undone also broadcasts
`member_join` for the target after the commit, exactly as the admin unban
does, so every connected client re-adds the member it dropped on the ban's
`member_ban`.

**Voice**, for a live target server-muted by the overturned timeout: lifts
alongside the ledger reversal above, through
`ModerationService.FinalizeTimeoutLift` — the same post-commit method a
moderator's direct `POST .../untimeout` uses. It clears only a mute the
appealed action itself put in place (session-bound ownership, never a
different moderator's own `voice_mod_mute`, and never a still-active,
strictly newer timeout that has since superseded this one — that mute stays
until ITS OWN issue or lift decides it, and this overturn sends no frame
for it). A ban carries no voice-mute reconcile of its own; the target's
live session was already ended when the ban landed.

#### Errors

| Status | Code              | Cause                                                                                                                                                                                                                  |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`     | invalid `outcome`, or `note` too long/unsafe                                                                                                                                                                           |
| 403    | `FORBIDDEN`       | caller lacks `MODERATE_MEMBERS`, an overturn the caller may not apply (does not outrank the target, or lacks `BAN_MEMBERS` for a ban), or the decider's own authority no longer holds when re-checked at decision time |
| 403    | `SELF_REVIEW`     | the caller is this appeal's own appellant, or the acting moderator where another eligible one exists                                                                                                                   |
| 404    | `NOT_FOUND`       | no such appeal                                                                                                                                                                                                         |
| 409    | `CONFLICT`        | the appeal is already decided or withdrawn                                                                                                                                                                             |
| 409    | `REVERSAL_FAILED` | overturning hit a genuine error applying the ledger reversal — nothing committed, including the decision itself                                                                                                        |

---

## Health Check

### GET /health

### GET /api/v1/health

Public health check endpoint, no authentication required. The server version
is deliberately not exposed here (anti-fingerprinting hardening, C-2).

```json
{
  "status": "ok",
  "uptime": 86400,
  "online_users": 3
}
```

When a health probe fails, the endpoint answers **503** with
`"status": "degraded"` and a `reason` field naming the failing subsystem —
`"hub"` (WS dispatch loop dead), `"database"`, or `"disk"`:

```json
{ "status": "degraded", "reason": "database", "uptime": 86400, "online_users": 3 }
```

---

## Server Info

### GET /api/v1/info

Returns the server name. The version field was removed from this
unauthenticated endpoint (anti-fingerprinting hardening, C-2).

**Auth:** None

```json
{
  "name": "My OwnCord Server"
}
```

### GET /api/v1/server-info

Reports server identity, connection compatibility, registration mode and the
server-default message retention window before sign-in.

**Auth:** None

| Field                     | Type    | Meaning                                                                                                                                                 |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                    | string  | The operator's server name (`server.name`)                                                                                                              |
| `protocol_epoch`          | integer | The wire-protocol epoch this server speaks. A client whose epoch differs cannot connect                                                                 |
| `browser_client_enabled`  | boolean | Whether the operator has opted in to browser-client hosting (`server.browser_client_enabled`)                                                           |
| `registration_mode`       | string  | `closed`, `invite`, `approval`, or `open`. A missing setting defaults to `invite`; an invalid value fails closed to `closed`                            |
| `retention`               | object  | Server-default message retention only; channel overrides are not disclosed                                                                              |
| `retention.messages_days` | integer | Server-default message window in days; `0` means kept indefinitely. Attachments are deleted with their messages; there is no separate attachment window |

```json
{
  "name": "My OwnCord Server",
  "protocol_epoch": 1,
  "browser_client_enabled": false,
  "registration_mode": "invite",
  "retention": {
    "messages_days": 0
  }
}
```

The response is cached server-side for **5 seconds**, so setting changes may
take that long to appear. A hard settings-read failure returns **500** with a
generic `INTERNAL_ERROR`; failures are also cached for 5 seconds. Missing,
malformed or out-of-range retention settings report `0` (keep indefinitely).

**No version is returned**, here or on `/api/v1/info` or `/health`. C-2 keeps
build identity off every unauthenticated endpoint so a server cannot be matched
against a CVE list; the protocol epoch does not leak it, because every server on
a given wire contract reports the same number. The version is available on the
admin-authenticated `GET /api/v1/diagnostics/connectivity`.

**`browser_client_enabled: true` does not mean a client is being served.** The
flag reports the operator's setting, not the build. Release builds embed the
browser client, but a build from source without the bundle answers `GET /` with
a 404 note even when the flag is on. With the flag off, no route is mounted and
no asset is served in any build —
`Server/api/browser_hosting_posture_test.go` proves it by route walk and by
wire probe.

---

## Metrics

### GET /api/v1/metrics

Runtime server metrics. IP-restricted (not token-based): allowed CIDRs come from `server.metrics_allowed_cidrs`, falling back to `server.admin_allowed_cidrs` when unset — set the dedicated key to admit a scraper without widening the admin perimeter.

**Auth:** IP restriction (metrics CIDRs, admin fallback)

```json
{
  "uptime": "2h30m15s",
  "uptime_seconds": 9015.0,
  "goroutines": 42,
  "heap_alloc_mb": 12.5,
  "heap_sys_mb": 24.0,
  "num_gc": 156,
  "connected_users": 8,
  "voice_sessions": 2,
  "broadcast_drops": 0,
  "topic_sheds_total": 0,
  "ws_broadcast_ms": { "count": 1204, "p50": 1, "p95": 5, "p99": 20, "max": 210 },
  "ws_dispatch_lag_ms": { "count": 1204, "p50": 0.5, "p95": 2, "p99": 10, "max": 90 },
  "chat_send_ack_ms": { "count": 340, "p50": 2, "p95": 10, "p99": 50, "max": 60 },
  "voice_join_ms": {
    "precheck": { "count": 12, "p50": 1, "p95": 1.4, "p99": 1.4, "max": 1.4 },
    "leave": { "count": 12, "p50": 0.5, "p95": 3.1, "p99": 3.1, "max": 3.1 },
    "persist": { "count": 12, "p50": 2, "p95": 4.2, "p99": 4.2, "max": 4.2 },
    "token": { "count": 12, "p50": 0.5, "p95": 0.8, "p99": 0.8, "max": 0.8 },
    "complete": { "count": 12, "p50": 2, "p95": 4.9, "p99": 4.9, "max": 4.9 },
    "total": { "count": 12, "p50": 5, "p95": 12.6, "p99": 12.6, "max": 12.6 }
  },
  "hub_broadcast_queue_depth": 0,
  "hub_seqmu_max_hold_ms": 12,
  "livekit_healthy": true,
  "reconnect_tier_buffer": 120,
  "reconnect_tier_db": 4,
  "reconnect_tier_full": 1,
  "reconnect_ring_misses": 3,
  "backpressure_queue_disconnects": 0,
  "backpressure_high_fallbacks": 0,
  "backpressure_low_drops": 17,
  "backpressure_presence_drops": 0,
  "delivery_loss_marks": 0,
  "ws_conn_rejects": 0,
  "disk_free_mb": 51200.5,
  "db_wal_mb": 4.2,
  "db_writer_wait_count": 3,
  "db_writer_wait_seconds": 0.021,
  "db_reader_wait_count": 11,
  "db_reader_wait_seconds": 0.004,
  "perm_cache_hits": 5120,
  "perm_cache_misses": 84,
  "event_persister": {
    "persisted": 4021,
    "dropped": 0,
    "flushes": 311,
    "errors": 0
  }
}
```

`voice_sessions` is the number of active voice connections. `broadcast_drops`
is the cumulative count of events dropped because the **hub-wide broadcast
queue** was full — sequenced events lost before delivery, worth alerting on
if it ever grows. `topic_sheds_total` counts frames the **per-sender channel topic
limiter** dropped before a sequence was assigned; like `broadcast_drops`, replay
cannot recover them, so alert on any growth. A **content** frame (a message
body, or one that discloses it) lost to either counter additionally forces the
next reconnect of a client at or behind the loss onto the full-ready path,
which rebuilds state from the database and so recovers the message; a metadata
frame does not.
Per-client send-queue pressure is reported separately:
`backpressure_queue_disconnects` (clients disconnected to force a
replay-recovering reconnect), `backpressure_high_fallbacks` (high-priority
sends that fell back to the normal queue), `backpressure_low_drops`
(typing messages silently dropped — safe to lose, but a growth trend
means clients are draining too slowly), and `backpressure_presence_drops`
(presence frames dropped on a full normal queue instead of disconnecting the
client; each is repaired by a presence snapshot, and growth during a reconnect
herd is expected). `delivery_loss_marks` counts connected clients told to
resync because a sequenced frame meant for them was dropped or withheld before
it reached their queue: each such client sees a gap in `cseq` and its next
resume takes the full-ready path. `reconnect_tier_*` counts resume
attempts served from the in-memory ring buffer, the persisted event log, and
full-resync fallback; a rising `full` share means the replay budget is too
small for observed disconnect gaps. `reconnect_ring_misses` counts the resumes
that passed the resync checks but fell behind the in-memory ring, the only ones
the persisted event log can serve; it is not a tier, and a miss normally ends in `db` or
`full` (a refused or revoked resume ends in neither). The log's hit rate is `reconnect_tier_db / reconnect_ring_misses`. A
resume forced to a full ready by a visibility, content or presence change, a
client already ahead of the ring and an empty ring are not counted. `db_writer_wait_count`/`_seconds`
accumulate time requests spent queueing for SQLite's single write connection —
the most direct saturation signal for the write path. `db_reader_wait_count`/
`_seconds` are the same pair for the reader pool (`max_readers` connections);
on in-memory databases reader and writer are the same handle, so the two
pairs report one pool. `perm_cache_*` report
permission-cache effectiveness (a miss is any lookup that repopulated from the
database). `ws_conn_rejects` counts upgrades refused by the
`server.max_ws_connections` cap, and `disk_free_mb` is free space on the data
volume (omitted when the platform can't report it). `db_wal_mb` is the size of
the SQLite write-ahead log file, read on each request (omitted when it can't be
read). `livekit_healthy` is
omitted when no LiveKit health check is wired; `event_persister` is omitted
when event persistence is disabled.

The distribution objects (`ws_broadcast_ms`, `ws_dispatch_lag_ms`,
`chat_send_ack_ms`, `voice_join_ms`) and the two gauges (`hub_broadcast_queue_depth`,
`hub_seqmu_max_hold_ms`) are the shipped, in-process metrics surface: they
exist in **every** build, unlike the OpenTelemetry instruments below, which
compile only with `-tags otel`. Each distribution reports `p50`, `p95`, `p99`
(the upper bound of the fixed bucket the quantile falls into, capped at `max` —
a coarse but comparable estimate; buckets are 0.5 ms through 5 s, anything
larger is exact max), `max` (exact) and `count`. `ws_broadcast_ms` is enqueue→fanout-done;
`ws_dispatch_lag_ms` is enqueue→dispatch-start, the direct signal for a
contended dispatch loop; `chat_send_ack_ms` is a `chat_send` frame's arrival
to its `chat_send_ok` being queued. `voice_join_ms` holds one such
distribution per phase of a completed `voice_join` — `precheck` (rate limit,
permission and channel gates), `leave` (leaving the previous channel on a
switch), `persist` (the `voice_states` write and moderator-flag restore),
`token` (minting and sending `voice_token`), `complete` (the voice topic
subscription, `voice_state` fan-out, existing states and `voice_config`) and
`total`; a refused or rolled-back join is not counted. A
`hub_seqmu_max_hold_ms` above ~100 ms is worth investigating. The top-level
figure is the longest hold since start, so it never falls; read the same key
under `windows` for the longest hold in the last minute or fifteen. The replay
purges run their database deletes outside `seqMu`.

#### The `windows` block

Every figure above is cumulative since boot, so after a day of uptime ten
minutes of stall barely moves a lifetime `p95`. The `windows` key holds the
same figures for the last minute (`1m`) and the last fifteen minutes (`15m`).
Use it to see what is happening now; keep the top-level figures for scrapers
that take their own deltas.

```json
{
  "windows": {
    "1m": {
      "seconds": 60.0,
      "as_of": "2026-10-17T12:00:00Z",
      "ws_broadcast_ms": { "count": 52, "p50": 1, "p95": 5, "p99": 20, "max": 18.4 },
      "ws_dispatch_lag_ms": { "count": 52, "p50": 0.5, "p95": 2, "p99": 5, "max": 6.1 },
      "chat_send_ack_ms": { "count": 9, "p50": 2, "p95": 10, "p99": 10, "max": 9.7 },
      "voice_join_ms": {
        "precheck": { "count": 0, "p50": 0, "p95": 0, "p99": 0, "max": 0 },
        "...": "five more phases"
      },
      "hub_seqmu_max_hold_ms": 3.1,
      "broadcast_drops": 0,
      "topic_sheds_total": 0,
      "reconnect_tier_buffer": 2,
      "reconnect_tier_db": 0,
      "reconnect_tier_full": 0,
      "reconnect_ring_misses": 0,
      "backpressure_queue_disconnects": 0,
      "backpressure_high_fallbacks": 0,
      "backpressure_low_drops": 3,
      "backpressure_presence_drops": 0,
      "delivery_loss_marks": 0,
      "ws_conn_rejects": 0,
      "db_writer_wait_count": 0,
      "db_writer_wait_seconds": 0,
      "db_reader_wait_count": 0,
      "db_reader_wait_seconds": 0
    },
    "15m": { "seconds": 900.0, "as_of": "2026-10-17T12:00:00Z", "...": "same keys" }
  }
}
```

- **Latency distributions** (`ws_broadcast_ms`, `ws_dispatch_lag_ms`,
  `chat_send_ack_ms`, each `voice_join_ms` phase) use the same fields as the
  lifetime ones, over the observations made inside the window. `max` is the
  largest observation the window saw, to the microsecond; the percentiles are
  the same coarse bucket bounds. Each observation is counted once, but at a
  sample boundary its count and its `max` can land in adjacent windows. A
  window with no observations reports `count: 0` and zero percentiles, and its
  `max` can still show a value carried from an observation at the window's
  edge.
- **`hub_seqmu_max_hold_ms`** is the longest hold inside the window.
- **Counters** (`broadcast_drops`, `topic_sheds_total`, the `reconnect_tier_*`
  and `backpressure_*` counts, `reconnect_ring_misses`, `delivery_loss_marks`, `ws_conn_rejects` and the
  `db_*_wait_*` pairs) are how much each grew during the window. They are never
  negative: a counter that was reset counts as no change.
- **`seconds`** is the time the window really covers. A server that started 40
  seconds ago reports `seconds: 40` under `1m`, and a gap in sampling (missed
  ticks) can make it longer than the nominal length.
- **`as_of`** is the newest sample's time (UTC). A sampler takes one sample
  every 10 seconds, so the figures can be up to 10 seconds old.
- **Omitted when unknown.** Until two samples exist, the whole `windows` key is
  absent, and a window that cannot be answered is left out, so a missing
  window is never a reassuring zero. A restart resets the windows with the rest
  of the process state.
- Only the figures listed above are windowed. Gauges that already describe
  now (`connected_users`, `hub_broadcast_queue_depth`, the disk and heap
  figures) are unchanged and not repeated.

### GET /api/v1/metrics/prometheus

The same figures as `GET /api/v1/metrics`, in the Prometheus text exposition
format (version 0.0.4). It exists in **every build**, with no build tag and no
config key, and it is limited exactly like the JSON endpoint: the addresses in
`server.metrics_allowed_cidrs`, falling back to `server.admin_allowed_cidrs`. A
scraper outside a private network needs `metrics_allowed_cidrs` set. It serves
only aggregates: no per-user label, no version string, no path or address.

**Auth:** IP restriction (metrics CIDRs, admin fallback)

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

```text
# HELP owncord_connected_users Users with a live WebSocket connection.
# TYPE owncord_connected_users gauge
owncord_connected_users 8
# HELP owncord_ws_dispatch_lag_seconds Time a frame waited for the dispatch goroutine.
# TYPE owncord_ws_dispatch_lag_seconds histogram
owncord_ws_dispatch_lag_seconds_bucket{le="0.0005"} 1180
owncord_ws_dispatch_lag_seconds_bucket{le="0.001"} 1196
owncord_ws_dispatch_lag_seconds_bucket{le="+Inf"} 1204
owncord_ws_dispatch_lag_seconds_sum 0.412
owncord_ws_dispatch_lag_seconds_count 1204
# HELP owncord_latency_max_seconds Largest single observation of each latency over the last minute (1m), fifteen minutes (15m) or the process lifetime. The one figure rate() and histogram_quantile() cannot derive.
# TYPE owncord_latency_max_seconds gauge
owncord_latency_max_seconds{metric="ws_dispatch_lag",window="1m"} 0.0021
owncord_latency_max_seconds{metric="ws_dispatch_lag",window="lifetime"} 0.09
```

Names carry the `owncord_` prefix and base units: seconds and bytes, where the
JSON uses milliseconds and megabytes. Counters end in `_total`.
Large values may print in exponent form (for example `5.305304e+06`), which
Prometheus parses.

| Family                                                                                                                             | Type      | Labels                                                                                                                                  | JSON field                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `owncord_uptime_seconds`, `owncord_goroutines`, `owncord_connected_users`, `owncord_voice_sessions`                                | gauge     |                                                                                                                                         | `uptime_seconds`, `goroutines`, `connected_users`, `voice_sessions`              |
| `owncord_heap_alloc_bytes`, `owncord_heap_sys_bytes`                                                                               | gauge     |                                                                                                                                         | `heap_alloc_mb`, `heap_sys_mb`                                                   |
| `owncord_gc_cycles_total`                                                                                                          | counter   |                                                                                                                                         | `num_gc`                                                                         |
| `owncord_broadcast_drops_total`, `owncord_topic_sheds_total`, `owncord_delivery_loss_marks_total`, `owncord_ws_conn_rejects_total` | counter   |                                                                                                                                         | `broadcast_drops`, `topic_sheds_total`, `delivery_loss_marks`, `ws_conn_rejects` |
| `owncord_ws_broadcast_seconds`, `owncord_ws_dispatch_lag_seconds`, `owncord_chat_send_ack_seconds`                                 | histogram |                                                                                                                                         | `ws_broadcast_ms`, `ws_dispatch_lag_ms`, `chat_send_ack_ms`                      |
| `owncord_voice_join_seconds`                                                                                                       | histogram | `phase`: `precheck`, `leave`, `persist`, `token`, `complete`, `total`                                                                   | `voice_join_ms`                                                                  |
| `owncord_latency_max_seconds`                                                                                                      | gauge     | `metric`: `ws_broadcast`, `ws_dispatch_lag`, `chat_send_ack`, `hub_seqmu_hold`, `voice_join_<phase>`; `window`: `1m`, `15m`, `lifetime` | the `max` fields, `hub_seqmu_max_hold_ms`, and the same under `windows`          |
| `owncord_hub_broadcast_queue_depth`                                                                                                | gauge     |                                                                                                                                         | `hub_broadcast_queue_depth`                                                      |
| `owncord_reconnect_tier_total`                                                                                                     | counter   | `tier`: `buffer`, `db`, `full`                                                                                                          | `reconnect_tier_*`                                                               |
| `owncord_reconnect_ring_misses_total`                                                                                              | counter   |                                                                                                                                         | `reconnect_ring_misses`                                                          |
| `owncord_backpressure_total`                                                                                                       | counter   | `kind`: `queue_disconnect`, `high_fallback`, `low_drop`, `presence_drop`                                                                | `backpressure_*`                                                                 |
| `owncord_db_wait_total`, `owncord_db_wait_seconds_total`                                                                           | counter   | `pool`: `writer`, `reader`                                                                                                              | `db_writer_wait_*`, `db_reader_wait_*`                                           |
| `owncord_perm_cache_lookups_total`                                                                                                 | counter   | `result`: `hit`, `miss`                                                                                                                 | `perm_cache_hits`, `perm_cache_misses`                                           |
| `owncord_push_total`                                                                                                               | counter   | `result`: `dispatched`, `failed`, `pruned`                                                                                              | `push_*`                                                                         |
| `owncord_event_persister_total`                                                                                                    | counter   | `kind`: `persisted`, `dropped`, `flushes`, `errors`                                                                                     | `event_persister` (omitted while event persistence is off)                       |
| `owncord_livekit_healthy`, `owncord_disk_low`                                                                                      | gauge 0/1 |                                                                                                                                         | `livekit_healthy`, `disk_low` (omitted when the JSON omits them)                 |
| `owncord_disk_free_bytes`, `owncord_disk_min_free_bytes`, `owncord_upload_storage_used_bytes`                                      | gauge     |                                                                                                                                         | `disk_free_mb`, `disk_min_free_mb`, `upload_storage_used_mb`                     |
| `owncord_db_wal_bytes`                                                                                                             | gauge     |                                                                                                                                         | `db_wal_mb` (omitted when the JSON omits it)                                     |

Notes:

- **Histogram buckets** are cumulative, in seconds (0.5 ms to 5 s, then `+Inf`).
  `+Inf` and `_count` are the same number within one scrape. `_sum` is read
  separately and can differ from the buckets by one observation still in flight.
- **Windows are Prometheus's own.** Use `rate()`, `increase()` and
  `histogram_quantile()` for deltas and quantiles; the JSON `windows` counter
  deltas and the `p50`/`p95`/`p99` fields are not exported. The one figure a
  query cannot derive is the worst single observation, so
  `owncord_latency_max_seconds` carries a `window` label. A window the server
  cannot answer yet (before its second sample) has no series, never a zero.
- **Absent sources are omitted**, as in the JSON: no `owncord_livekit_healthy`
  without a LiveKit probe, no `owncord_event_persister_total` with persistence
  off, no disk or upload family when the figure is unavailable.
- Each scrape runs the LiveKit health probe once, as each JSON read does.

### GET /metrics (OpenTelemetry exporter)

Only in a server built with `-tags otel` and `telemetry.exporter` set to
`prometheus`: the OpenTelemetry SDK's own Prometheus exporter, mounted at
`/metrics` and limited like the JSON endpoint. In the default build the route
does not exist (404); use [`GET /api/v1/metrics/prometheus`](#get-apiv1metricsprometheus),
which serves the built-in figures in every build.

---

## Admin API Authorization

The admin panel API lives under `/admin/api` (not `/api/v1`) and takes the same
`Authorization: Bearer {token}` header — a login session or an API token, which
inherits its owning user's role.

Authorization is two-layered:

1. **Perimeter.** The request is rejected with `403 FORBIDDEN` unless the
   principal's role holds at least one bit of `permissions.AdminPerimeter`
   (`ADMINISTRATOR`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_SERVER`,
   `VIEW_AUDIT_LOG`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`,
   `MANAGE_BACKUPS`, and the seven owner-type bits `RESTORE_BACKUPS`,
   `MANAGE_CONFIG`, `MANAGE_UPDATES`, `MANAGE_TOKENS`, `ISSUE_RECOVERY`,
   `VIEW_DIAGNOSTICS`, `ERASE_ACCOUNTS`). Banned
   users are rejected here even while their session is still valid.
2. **Per-route bit.** Route groups then require the specific permission below.
   `ADMINISTRATOR` bypasses every one of them except the **owner tier** (WP
   8.4d): restore, config, updates, tokens and recovery gate on the Owner role
   itself (`permissions.IsOwner`: role id 1 **or** role position `>= 100`) **or**
   the bit held explicitly, so not even `ADMINISTRATOR` substitutes for the owner
   or for the bit. Only the owner can grant an owner-tier bit. The
   **administrator tier** (`VIEW_DIAGNOSTICS`, `ERASE_ACCOUNTS`) passes
   `ADMINISTRATOR` like any other bit. Every use by a non-owner leaves an audit
   row. Only the backup schedule and retention stay Owner-only, as settings keys.

| Route                                                                                                                                                | Requires                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/api/me`                                                                                                                                  | perimeter only                                                                                                                                                                                                                                                                                               |
| `GET /admin/api/stats`                                                                                                                               | perimeter only                                                                                                                                                                                                                                                                                               |
| `GET /admin/api/users`                                                                                                                               | perimeter only                                                                                                                                                                                                                                                                                               |
| `PATCH /admin/api/users/{id}`                                                                                                                        | perimeter; `BAN_MEMBERS` for `banned`, `MANAGE_ROLES` for `role_id` (checked in the service)                                                                                                                                                                                                                 |
| `PUT/DELETE /admin/api/users/{id}/roles/{roleId}`                                                                                                    | perimeter; `MANAGE_ROLES` (checked in the service) — WP 6.3c                                                                                                                                                                                                                                                 |
| `DELETE /admin/api/users/{id}/sessions`                                                                                                              | `KICK_MEMBERS`                                                                                                                                                                                                                                                                                               |
| `DELETE /admin/api/users/{id}`                                                                                                                       | `ERASE_ACCOUNTS` (`ADMINISTRATOR` passes); the actor must outrank the target (checked in the service) — B4-9, WP 8.4d                                                                                                                                                                                        |
| `POST /admin/api/users/{id}/recovery-credential`                                                                                                     | Owner role **or** `ISSUE_RECOVERY` (`permissions.CanIssueRecovery`; `ADMINISTRATOR` does not pass); a holder who is not the owner can only issue to a member ranked strictly below them, never the owner — B4-6, WP 8.4d                                                                                     |
| `GET/POST/PATCH/DELETE /admin/api/channels…` (incl. `/permissions`, `/user-permissions` and `/access/…`)                                             | `MANAGE_CHANNELS`                                                                                                                                                                                                                                                                                            |
| `/admin/api/discord-imports…`                                                                                                                        | `MANAGE_CHANNELS`                                                                                                                                                                                                                                                                                            |
| `GET/POST/PATCH/DELETE /admin/api/roles…` (incl. `/roles/reorder`)                                                                                   | `MANAGE_ROLES`                                                                                                                                                                                                                                                                                               |
| `GET /admin/api/audit-log`                                                                                                                           | `VIEW_AUDIT_LOG`                                                                                                                                                                                                                                                                                             |
| `GET/PATCH /admin/api/settings`, `PUT /admin/api/afk-channel`                                                                                        | `MANAGE_SERVER`                                                                                                                                                                                                                                                                                              |
| `GET /admin/api/config`                                                                                                                              | `MANAGE_SERVER`                                                                                                                                                                                                                                                                                              |
| `GET/PATCH /admin/api/config/settings`, `POST /admin/api/restart`                                                                                    | Owner role **or** `MANAGE_CONFIG` (`permissions.CanManageConfig`; `ADMINISTRATOR` does not pass) — WP 8.4d                                                                                                                                                                                                   |
| `GET /admin/api/retention`, `GET /admin/api/retention/channels`, `GET /admin/api/retention/preview`, `PUT/DELETE /admin/api/channels/{id}/retention` | `MANAGE_SERVER` — B4-11                                                                                                                                                                                                                                                                                      |
| `/admin/api/registrations…` (GET, and `POST` `{id}/approve` / `{id}/deny`)                                                                           | `MANAGE_SERVER`                                                                                                                                                                                                                                                                                              |
| `POST /admin/api/logs/ticket`, `GET /admin/api/logs/stream`                                                                                          | `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes); the stream re-checks it on every write — WP 8.4d                                                                                                                                                                                                                |
| `GET/PATCH/DELETE /admin/api/logs/level`                                                                                                             | `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes) — the running level and a timed debug boost, SRE-07                                                                                                                                                                                                              |
| `POST /admin/api/support-bundles/preview`, `POST /admin/api/support-bundles/download`                                                                | `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)                                                                                                                                                                                                                                                                  |
| `GET /admin/api/attention`                                                                                                                           | `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes) — RI-07                                                                                                                                                                                                                                                          |
| `/api/v1/admin/plugins…`                                                                                                                             | `ADMINISTRATOR`                                                                                                                                                                                                                                                                                              |
| `/admin/api/tokens…`, `/admin/api/updates…`                                                                                                          | `/admin/api/tokens…`: Owner role **or** `MANAGE_TOKENS` (`permissions.CanManageTokens`; a holder who is not the owner sees, creates and revokes only their own tokens); `/admin/api/updates…`: Owner role **or** `MANAGE_UPDATES` (`permissions.CanManageUpdates`); `ADMINISTRATOR` passes neither — WP 8.4d |
| `DELETE /admin/api/backups/{name}`, `POST /admin/api/backups/{name}/restore`, `GET /admin/api/archive`, `POST /admin/api/archive/link`               | Owner role **or** `RESTORE_BACKUPS` (`permissions.CanRestoreBackups`; `ADMINISTRATOR` does not pass); the archive link is re-checked when opened — WP 8.4d                                                                                                                                                   |
| `POST /admin/api/backup`, `GET /admin/api/backups`, `POST /admin/api/backups/{name}/link` (and its `/download`)                                      | Owner role **or** `MANAGE_BACKUPS` (`permissions.CanManageBackups`; `ADMINISTRATOR` passes) — WP 8.4c; `GET /admin/api/backups` also admits `RESTORE_BACKUPS`, so a restorer can pick a backup (WP 8.4d)                                                                                                     |

Moderation routes additionally enforce the **role hierarchy**: the actor must
strictly outrank the target (`actor.position > target.position`), and a role
assignment may only grant a role positioned strictly below the actor's own —
so an admin cannot promote anyone to Owner, and a moderator cannot demote an
admin. Violations return `403 FORBIDDEN`.

### GET /admin/api/me

Describes the calling principal so a panel can hide what the role cannot use.
Every route still re-checks its bit server-side. `server_name` is the live
`server_name` setting and `version` is the build version, both for the
panel's top bar. Unauthenticated endpoints never report the version.

#### Response 200 OK

```json
{
  "id": 7,
  "username": "mod",
  "role_id": 3,
  "role_name": "Moderator",
  "role_position": 60,
  "permissions": 1048575,
  "is_owner": false,
  "server_name": "OwnCord Server",
  "version": "1.2.0"
}
```

---

## First-Run Setup

### GET /admin/api/setup/status

Reports whether initial setup is needed (the durable `settings.setup_completed`
flag is unset and no account exists).

**Auth:** None (public). After the first user exists, the response reveals
nothing about the configuration.

#### Response 200 OK

```json
{
  "needs_setup": true,
  "defaults": {
    "server_name": "OwnCord",
    "motd": "Welcome!",
    "registration_mode": "invite",
    "port": 8443,
    "tls_mode": "self-signed",
    "tls_domain": "",
    "upload_max_size_mb": 100,
    "voice_quality": "medium",
    "voice_auto_download": true
  }
}
```

`defaults` (wizard prefill from the running config and settings table) is
present only while `needs_setup` is `true`.

---

### POST /admin/api/setup

Create the first (Owner) account, optionally applying first-run wizard
configuration. Only functional while the durable `settings.setup_completed`
flag (migration 043) is unset — the flag is set in the same transaction as the
first owner and never cleared by the server, so erasing every account does not
reopen the wizard; afterwards the endpoint returns an error.

**Auth:** None (public), plus the one-time setup token
**Rate limit:** 5 requests/minute per IP

The owner's `username` follows the registration rules: 2–32 characters; letters
(any script), digits, `_`, `.` and `-`; no spaces; starting with a letter or
digit; `everyone` and `here` reserved. A refused name is `400 BAD_REQUEST`.

`setup_token` must equal the token the server printed in its start-up output;
a missing or different value is `403 FORBIDDEN`. The server makes a fresh token each time it starts.

Once setup is done the endpoint answers `403 FORBIDDEN` before hashing the
password. The hash waits in the same process-wide password-check queue as login
and registration; when that queue is full or the wait runs out, the response is
`429 AUTH_BUSY` with `Retry-After` set and no account is created. The owner's
session in the response is created already seen, so it does not show as an
unreviewed new login.

#### Request

```json
{
  "setup_token": "token-from-start-up-output",
  "username": "owner",
  "password": "MyStr0ng!Pass",
  "wizard": {
    "server_name": "My Server",
    "motd": "Welcome!",
    "registration_mode": "invite",
    "port": 8443,
    "tls_mode": "self-signed",
    "tls_domain": "",
    "upload_max_size_mb": 100,
    "voice_quality": "medium",
    "voice_auto_download": true,
    "recovery_kit": true
  }
}
```

All `wizard` fields are optional; `server_name`, `motd` and
`registration_mode` (`closed` / `invite` / `approval` / `open`, default
`invite`) are stored in the settings table (live), the rest are written back
to `config.yaml` (consumed at startup). `recovery_kit` (default `true`, also
when `wizard` is absent) asks the server to generate the owner's recovery kit
during the first run (B11-8); the secret is returned once as
`recovery_kit_secret` and only its verifier is stored. Pass
`"recovery_kit": false` to skip it.

A TLS choice the next boot could not serve answers 400 before the account is
created, as the admin panel refuses the same change: `tls_mode` `manual` when
the configured `tls.cert_file`/`tls.key_file` pair does not load or has
expired, and `tls_mode` `acme` with `port` 80.

#### Response 200 OK

```json
{
  "token": "raw-session-token",
  "user_id": 1,
  "username": "owner",
  "invite_code": "abc123def",
  "restart_required": false,
  "restart_url": "",
  "warnings": [],
  "certificate_fingerprint": "3f:a1:...:9c",
  "recovery_kit_secret": "ABCD-EFGH-IJKL-MNOP"
}
```

`restart_required` is `true` when wizard values that are only read at startup
(port, TLS) differ from the running config; the server restarts itself right
after responding, and `restart_url` is where the admin panel will be reachable
afterwards. `warnings` lists non-fatal problems (e.g. `config.yaml` not
writable) — the account exists whenever this response is returned.
`certificate_fingerprint` is as in [`GET /admin/api/stats`](#get-adminapistats),
and is also omitted when `wizard.tls_mode` differs from the running mode —
the restarted server serves a different certificate. `recovery_kit_secret` is
present unless `wizard.recovery_kit` was false or the kit could not be issued:
it is shown once and can never be retrieved again.

---

## Server Stats & User Administration

### GET /admin/api/stats

Aggregate counts for the admin dashboard.

**Auth:** Admin perimeter

#### Response 200 OK

```json
{
  "user_count": 12,
  "message_count": 4821,
  "channel_count": 9,
  "invite_count": 2,
  "db_size_bytes": 1048576,
  "online_count": 3,
  "tls_mode": "acme",
  "certificate_fingerprint": "3f:a1:...:9c"
}
```

`tls_mode` is the configured `tls.mode`. `certificate_fingerprint` is the
served TLS leaf certificate's SHA-256 in the lower-case colon-hex form the
desktop client shows before its trust prompt — the value users compare out of
band. In `acme` mode it is read on the first handshake and follows each
renewal. It is omitted when the server serves no certificate it can read (TLS
off, where a reverse proxy serves it, or ACME before its first handshake). The
certificate's expiry is on the `certificate` signal of
[GET /admin/api/attention](#get-adminapiattention).

---

### GET /admin/api/attention

The dashboard's attention panel (RI-07): server-side health signals and the
deduplicated warnings raised from them. The server samples once a minute
(the free space on the data volume, the SQLite writer pool's cumulative wait,
reconnect resumes, hub broadcast drops, per-channel topic sheds and
send-queue overflow disconnects, the newest backup file, the LiveKit voice path's state, the served TLS certificate's expiry and each maintenance job's last
run); this route only reads that state. Thresholds and hysteresis are in
[server-configuration.md](server-configuration.md#admin-attention-panel-attention).
Nothing here is exported off the host.

**Auth:** `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)

#### Response 200 OK

```json
{
  "evaluated_at": "2026-09-23T12:00:00Z",
  "signals": [
    {
      "id": "disk",
      "label": "Disk space",
      "status": "unknown",
      "detail": "disk space is not measured on this server",
      "observed_at": "2026-09-23T12:00:00Z"
    },
    {
      "id": "backup",
      "label": "Last successful backup",
      "status": "ok",
      "value": "2026-09-23 03:00 UTC",
      "threshold": "daily schedule: warn after 36h0m0s",
      "detail": "9h0m0s old",
      "observed_at": "2026-09-23T12:00:00Z"
    }
  ],
  "warnings": [
    {
      "id": "job:Backups",
      "severity": "warning",
      "title": "Maintenance job failing: Backups",
      "detail": "2 consecutive failed runs · disk I/O error",
      "action": "Search Server Logs for …",
      "first_observed": "2026-09-23T11:30:00Z",
      "last_observed": "2026-09-23T12:00:00Z",
      "occurrences": 1,
      "recovered_at": null
    }
  ]
}
```

- `status` is `ok`, `warning`, `critical` or `unknown`. `unknown` means the
  server could not take the measurement (an unsupported platform, a failed
  read, a rate with one sample so far, a job that has not run since start,
  disk space with `attention.disk_warn_free_mb` and `server.min_free_disk_mb`
  both `0`).
  It is never reported as healthy and neither raises nor clears a warning.
- `signals` ids: `disk`, `db_writer_wait`, `reconnects`, `delivery`, `voice`,
  `certificate`, `last_exit`, `last_restore`, `backup`, and `job:<name>` for each maintenance
  step.
- `certificate` reports the served TLS certificate's expiry. A `self_signed`
  or `manual` certificate is `ok` with 21 days or more left, `warning` inside
  21 days and `critical` inside 7 days or once expired. An `acme` certificate
  is measured against its renewal point, min(lifetime/3, 30 days) before
  expiry: `warning` once a third of that window has passed unrenewed and
  `critical` two thirds in (20 and 10 days for a 90-day certificate, 10 and 5
  for a 45-day one), so a healthy certificate with a shorter lifetime does not
  warn. `threshold` states the bounds in use. It is `unknown` with TLS off (a
  reverse proxy serves the certificate) and in `acme` mode before the first
  handshake.
- `last_exit` reports how the previous run ended (SRE-08): `ok` after a clean
  shutdown, `warning` when the run before this one left its boot marker armed
  (a `kill -9`, a crash, or a hardware-fault exit), with the previous run's
  start time as `value` and the last panic it recovered, if any, in `detail`;
  `unknown` on a first start, when there was no marker to read. A planned
  (clean) restart clears the marker, so it recovers this warning.
- `last_restore` appears only on a start that handled a staged backup restore
  (WP 5.5), and is read once from the result the boot-time apply left: `ok`
  with the backup name and time as `value` when it was applied, `warning`
  when it was rolled back or refused and the previous database is still in use,
  with the reason in `detail`.
- `voice` reports LiveKit. An OwnCord-managed companion reports its
  supervisor's local state — `running`, plus a `not running` warning when it is
  down and a `gave up` critical when the backoff stopped restarting it; a
  restart count appears in the detail. An externally managed LiveKit is
  probed over HTTP and reports `unreachable` as a warning when it does not
  answer; an unconfigured voice path is `unknown`.
- The first disk or voice level is reported at once, and a stopped dispatch
  loop as soon as it is seen; every other level change, including a rate's first
  warning, holds for two samples.
  A rate's `threshold` is its `attention.*` floor until it has learned a
  baseline, then the higher of the floor and three times that baseline.
  While learning, `reconnects` raises nothing and `db_writer_wait`
  and `delivery` raise at the floor; samples above the floor are not learned.
- A warning's `id` is its signal's id. A signal that keeps failing updates
  `last_observed`. One that recovers gets `recovered_at` and is listed for 24
  hours; if it fails again in that window, the same entry reopens,
  `first_observed` resets to when it fired again, and `occurrences`
  increments. Active warnings are listed first, critical before
  warning. The state is in memory, so a restart resets warning history;
  active problems re-raise within the next sample intervals, about two
  minutes (a rate needs a first sample plus two sustained ones).
- `evaluated_at` is `null` until the first sample.

#### Response 500

`INTERNAL_ERROR` "attention service unavailable" when the server was built
without the attention service (partial wirings in tests).

---

### GET /admin/api/users

List active users with role and ban state, in id order. The filters apply in
the query, so they narrow every page, not just the one returned.

**Auth:** Admin perimeter
**Query params:** `limit` (default 50, min 1, max 500), `offset` (default 0),
`q` (case-insensitive substring of the username or the nickname, at most 64
characters; longer is `400`), `role_id` (members who hold this role; omitted or `0` means any), `banned=1` (only
effective bans: a lapsed temporary ban is not listed)

#### Response 200 OK

Array of:

| Field           | Type    | Notes                                                                                                                                                                                           |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | int     |                                                                                                                                                                                                 |
| `username`      | string  |                                                                                                                                                                                                 |
| `display_name`  | string? | the member's nickname; omitted when unset                                                                                                                                                       |
| `avatar`        | string? | omitted when unset                                                                                                                                                                              |
| `role_id`       | int     |                                                                                                                                                                                                 |
| `role_name`     | string  |                                                                                                                                                                                                 |
| `role_position` | int     | the role's hierarchy position; the server refuses role changes and moderation on a member whose position is at or above the caller's (`/me` `role_position`), and the panel hides those actions |
| `role_ids`      | int[]   | every role the member holds, highest-ranked first (`role_id` is the first); the `role_id` query filter keeps members who hold that role, not only those whose top role it is                    |
| `status`        | string  | presence status                                                                                                                                                                                 |
| `created_at`    | string  |                                                                                                                                                                                                 |
| `last_seen`     | string? | omitted when never seen                                                                                                                                                                         |
| `banned`        | bool    |                                                                                                                                                                                                 |
| `ban_reason`    | string? | omitted when unset                                                                                                                                                                              |
| `ban_expires`   | string? | omitted for permanent bans                                                                                                                                                                      |

Password hashes and TOTP secrets are never included.

---

### PATCH /admin/api/users/{id}

Change a user's role and/or ban state. Both actions route through the
moderation service, which enforces the required bit (`MANAGE_ROLES` for
`role_id`, `BAN_MEMBERS` for `banned`), the role hierarchy, and writes the
audit row.

**Auth:** Admin perimeter + per-action bit (see above)

#### Request

```json
{
  "role_id": 3,
  "banned": true,
  "ban_reason": "spam",
  "ban_duration_hours": 24,
  "delete_message_seconds": 86400
}
```

All fields optional. `ban_duration_hours` makes the ban temporary (1–8760;
omitted or `0` = permanent) and is only meaningful with `banned: true`.

`delete_message_seconds` (integer, 0–604800) also deletes the target's messages
posted in the last that many seconds. It is accepted only with `banned: true`
and needs `MANAGE_MESSAGES` as well as `BAN_MEMBERS`. Messages are deleted in
every non-DM, non-archived channel where the actor holds `READ_MESSAGES` and
`MANAGE_MESSAGES`, up to 10,000 messages or 20 seconds per request. The checks
run before the ban is written, so a refused request bans nobody. Connected
clients receive a `chat_bulk_deleted` event per batch. Omitting the field, or
sending `0`, deletes nothing.

The purge may stop early. When the response has `"complete": false`, send the
same request again to continue. A retry must resend `ban_reason` and
`ban_duration_hours` unchanged: if the target is already banned and the ban
fields match, the ban is not written a second time (no new ledger row, no
refreshed reason or expiry) and only the deletion continues. For a temporary
ban, the same `ban_duration_hours` retried within an hour counts as unchanged.
Each request measures the window back from its own arrival time, so a message
that crosses the window's edge between two requests stays.

#### Response 200 OK -- the updated user (same shape as the list entry).

When `delete_message_seconds` was above 0, the object also carries:

```json
{ "purge": { "deleted": 42, "complete": true } }
```

`deleted` counts the messages deleted by this request. Without the field the
response has no `purge` member.

#### Errors

| Status | Code           | Cause                                                                                                                                                                                               |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | Invalid id/body, `ban_duration_hours` or `delete_message_seconds` out of range or not an integer, `delete_message_seconds` above 0 without `banned: true`, or attempting to modify your own account |
| 403    | `FORBIDDEN`    | Missing bit (including `MANAGE_MESSAGES` for `delete_message_seconds`), or the actor does not outrank the target                                                                                    |
| 404    | `NOT_FOUND`    | User not found                                                                                                                                                                                      |
| 429    | `RATE_LIMITED` | `delete_message_seconds` used again too soon (one per actor every 2 seconds); nothing was changed                                                                                                   |

---

### PUT /admin/api/users/{id}/roles/{roleId}

### DELETE /admin/api/users/{id}/roles/{roleId}

Add or remove one role of a member without touching the others (WP 6.3c). A
member holds one or more roles; `users.role_id`, `role` on the wire and the
rank checks follow the **top** role (highest `position`, lowest id on a tie),
while permissions are the union of every held role. `PATCH` with `role_id`
still replaces every role the member holds with that one.

The checks are those of `PATCH` with `role_id`: `MANAGE_ROLES`, the actor must
outrank the target's top role, and the role must sit below the actor's own top
role. Both calls are idempotent (adding a held role or removing one that is not
held changes nothing and writes no audit row). Each real change writes a
`role_add` or `role_remove` audit row, drops the target's cached permissions and
sends one `member_update` (with `role_ids`) plus a visibility refresh to the
target's live connection. The same routes exist under
`/api/v1/moderation/members/{id}/roles/{roleId}`.

**Auth:** Admin perimeter + `MANAGE_ROLES` (checked in the service)

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                                                                                                      |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Invalid id, unknown role, or the target is the caller                                                                      |
| 403    | `FORBIDDEN`   | Missing `MANAGE_ROLES`, the actor does not outrank the target, or the role is at or above theirs                           |
| 404    | `NOT_FOUND`   | User not found                                                                                                             |
| 409    | `LAST_ROLE`   | `DELETE` only: the role is the member's only one. Two concurrent removals of a member's last two roles cannot both succeed |

---

### DELETE /admin/api/users/{id}/sessions

Force-logout: revoke every session of the target user. The hierarchy rule
(actor outranks target) is enforced in the moderation service and the action
is audited.

**Auth:** `KICK_MEMBERS`

#### Response 204 No Content

---

### DELETE /admin/api/users/{id}

Erase the target account (B4-9): the same erasure as
[`DELETE /api/v1/auth/account`](#delete-apiv1authaccount), started by an
administrator. The hierarchy rule (actor outranks target) is enforced in the
moderation service, the actor cannot erase its own account here, the last
admin-class account cannot be erased, and the action is audited as
`account_deleted` with the actor and the target unlinked to the deletion
marker's token (B4-10). Connected clients receive `member_ban`.

**Auth:** `ERASE_ACCOUNTS` (`ADMINISTRATOR` passes), WP 8.4d

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                                                                             |
| ------ | ------------- | ------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Invalid id, or the actor's own account                                                            |
| 403    | `FORBIDDEN`   | Missing bit, the actor does not outrank the target, or the target is the last admin-class account |
| 404    | `NOT_FOUND`   | User not found                                                                                    |

---

### POST /admin/api/users/{id}/recovery-credential

Owner-assisted recovery (B4-6, BPR-045; owner decision 3). The server owner,
having verified the person out of band, receives a **15-minute, single-use**
recovery credential for the account, shown once. The user redeems it at
[`POST /api/v1/auth/recover`](#post-apiv1authrecover) in the `credential`
field: the password is replaced, every session and API token revoked, and a
session issued without the second factor. Only an argon2id verifier is
stored; issuing again replaces the outstanding credential, and a recovery by
kit withdraws it.
Refused for the caller's own account, a banned or pending account and an
anonymised row; budgeted at 5 issuances per owner and 3 per account per hour.
Audited as `recovery_assist_issued` with the verification wording only.
A holder of `ISSUE_RECOVERY` who is not the owner can issue only to a member
ranked strictly below them (`403` for an equal or higher rank and for the owner).

**Auth:** Owner role (`permissions.IsOwner`: role id 1 or position `>= 100`) **or** `ISSUE_RECOVERY` (`permissions.CanIssueRecovery`); `ADMINISTRATOR` does not substitute

#### Request

`verification` is one of `in_person`, `voice_call`, `video_call`,
`trusted_contact` — fixed wording, never free text, so nothing about the
person exists to leak into the audit log.

```json
{ "verification": "in_person" }
```

#### Response 201 Created

```json
{
  "credential": "K7QF-3M2X-9PLA-ZB5A-QW2E-TT7Y",
  "expires_at": "2026-09-02T19:15:00Z",
  "username": "alex",
  "verification": "in_person"
}
```

#### Errors

| Status | Code           | Cause                                                        |
| ------ | -------------- | ------------------------------------------------------------ |
| 400    | `BAD_REQUEST`  | Unknown verification wording, or an account this cannot help |
| 403    | `FORBIDDEN`    | Not the owner                                                |
| 404    | `NOT_FOUND`    | No such account                                              |
| 429    | `RATE_LIMITED` | Issuance budget spent                                        |
| 429    | `AUTH_BUSY`    | The admission budget for password checks is full             |

---

## Audit Log

### GET /admin/api/retention

The message-retention policy (B4-11): the server window and every channel
override.

**Auth:** `MANAGE_SERVER`

#### Response 200 OK

```json
{
  "server_days": 30,
  "revision": "opaque-policy-revision",
  "channels": [
    { "channel_id": 4, "days": 0, "updated_by": 1, "updated_at": "2026-09-03 12:00:00" },
    { "channel_id": 7, "days": 7, "updated_by": 1, "updated_at": "2026-09-03 12:01:00" }
  ]
}
```

`days` on a channel overrides the server window in either direction; `0`
keeps that channel forever.

---

### GET /admin/api/retention/channels

The channels a retention policy can target, so the page works for a
`MANAGE_SERVER` role that cannot read `GET /admin/api/channels`
(`MANAGE_CHANNELS`). DMs are never in retention scope and are omitted.

**Auth:** `MANAGE_SERVER`

#### Response 200 OK

```json
[
  { "id": 4, "name": "general" },
  { "id": 7, "name": "announcements" }
]
```

---

### GET /admin/api/retention/preview

The owner-facing effect preview: per channel with an effective window, the
cutoff the next sweep uses and how many messages it would remove.

**Auth:** `MANAGE_SERVER`

#### Response 200 OK

```json
[
  {
    "channel_id": 1,
    "channel_name": "general",
    "days": 30,
    "source": "server",
    "cutoff": "2026-08-04T12:00:00Z",
    "would_delete": 1284
  }
]
```

---

### POST /admin/api/retention/preview

**Auth:** `MANAGE_SERVER`. Computes the effect of a proposed policy without
saving or deleting anything. Send the `revision` from `GET /retention` and
exactly one edit:

```json
{
  "revision": "opaque-policy-revision",
  "proposed": { "scope": "server", "days": 30 }
}
```

For a channel, use `{"scope":"channel","channel_id":4,"days":7}`. Zero
means keep forever; `days: null` removes the override and inherits the server
window, including when removing an indefinite override.

The response contains `proposed`, `revision`, `observed_at` (UTC RFC3339),
`token`, `would_delete`, `affected_channels`, `protected_pinned`,
`protected_indefinite`, `protected_direct_messages`, and `channels`. Each
non-DM channel has `channel_id`, `channel_name`, effective `days`, `source`,
`cutoff` (finite windows only), `would_delete`, `protected_pinned` and
`protected_indefinite`. Totals describe the **whole proposed policy**, not
only the difference from the saved policy. Protected categories do not
repeat messages: indefinite channels count all messages as indefinite;
pinned counts cover finite channels. DMs are counted only in the aggregate.
Pinned messages are excluded regardless of age. A message exactly at the
cutoff is not due. The same candidate predicate is used by the sweep.

After confirmation, send `X-Retention-Preview: <token>` on the existing
server `PATCH /settings` or channel `PUT`/`DELETE` below. The token binds the
exact edit, actor, revision and observation, expires after 15 minutes, and
is invalid after server restart. It grants no permissions: the current
bearer/session and `MANAGE_SERVER` permission are resolved again on apply.

A stale revision on preview or apply returns **409** with code
`STALE_RETENTION_POLICY` and instructions to reload and preview again. Apply
compares the revision and writes in one transaction; it cannot overwrite a
concurrent policy edit. Missing, altered, expired or mismatched tokens return
**400**. All retention write routes require a preview token. A server-window
PATCH must contain only `retention_days`; apply other settings separately.
The audit entry records the prior and new policy, preview observation time
and base revision. Counts may change with new messages, pins and elapsed
time; the preview does not reserve messages or trigger an immediate sweep.

---

### PUT /admin/api/channels/{id}/retention

Set a channel's retention window. `days` is `0` (keep forever, even under a
server window) or between 1 and 3650. Refused for direct-message channels.
Audited as `channel_retention_change` with the old and new window.

**Auth:** `MANAGE_SERVER`

#### Request

```json
{ "days": 14 }
```

#### Response 200 OK

The channel's policy row (`channel_id`, `days`, `updated_by`, `updated_at`).

#### Errors

| Status | Code          | Cause                                           |
| ------ | ------------- | ----------------------------------------------- |
| 400    | `BAD_REQUEST` | Invalid id or days, or a direct-message channel |
| 404    | `NOT_FOUND`   | Channel not found                               |

---

### DELETE /admin/api/channels/{id}/retention

Remove a channel's override so the server window applies again. Audited as
`channel_retention_change`.

**Auth:** `MANAGE_SERVER`

#### Response 204 No Content

`404 NOT_FOUND` when the channel has no override.

---

### GET /admin/api/audit-log

Read the audit trail, newest first.

**Auth:** `VIEW_AUDIT_LOG`
**Query params:** `limit` (default 50, 1–500), `offset` (default 0), and three
optional filters that narrow the whole log before paging:

- `q`: case-insensitive (ASCII) substring of the actor's name, the action, the
  target type or the detail. Surrounding whitespace is trimmed; at most 100
  characters.
- `action`: one exact action name, such as `channel_delete`; at most 64 bytes.
- `hide_signins`: `1` drops the sign-in and connection rows (`user_login`,
  `ws_connect`); any other value keeps them. The admin panel sends it while
  its Sign-ins filter is off, which is the default.

An over-long or non-UTF-8 `q` or `action` is `400 BAD_REQUEST`.

#### Response 200 OK

On the first page (`offset` 0) the response also carries an
`X-Audit-Actions` header: a JSON array of the distinct action names in the
whole log, sorted, at most 200, whatever `q` and `action` are — so the admin
panel's action filter can offer actions no fetched row contains. The body is
an array of:

```json
{
  "id": 991,
  "actor_id": 1,
  "actor_name": "owner",
  "action": "user_ban",
  "target_type": "user",
  "target_id": 7,
  "detail": "spam",
  "created_at": "2026-08-04T12:00:00Z"
}
```

Rows about an erased account (B4-10) carry the deletion marker's token in
place of the id — `"subject_token"` where the erased account was the target,
`"actor_token"` where it acted, both on a row naming two erased accounts —
with `actor_id` and/or `target_id` at `0` and `detail` cleared; the fields
are omitted on every other row.

---

## Registration Queue

Approval-mode applications (`registration_mode = approval`) wait here. An
application is a locked account: it holds its username but cannot sign in
until approved. Denial anonymises the row and locks it for good (the same
convention account deletion uses, because audit rows reference the id) and
releases the username. Both decisions are audited (`registration_approve`,
`registration_deny`).

### GET /admin/api/registrations

**Auth:** `MANAGE_SERVER`

Query: `limit` (1–500, default 50), `offset`.

#### Response 200 OK

```json
[{ "id": 12, "username": "alex", "created_at": "2026-09-02T10:00:00Z" }]
```

Oldest application first.

---

### POST /admin/api/registrations/{id}/approve

Unlock the application; the account can sign in from now on.

**Auth:** `MANAGE_SERVER`

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                  |
| ------ | ------------- | -------------------------------------- |
| 400    | `BAD_REQUEST` | Malformed id                           |
| 404    | `NOT_FOUND`   | No application with that id is pending |

---

### POST /admin/api/registrations/{id}/deny

Refuse the application: the row is anonymised and locked, its username
released.

**Auth:** `MANAGE_SERVER`

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                                  |
| ------ | ------------- | -------------------------------------- |
| 400    | `BAD_REQUEST` | Malformed id                           |
| 404    | `NOT_FOUND`   | No application with that id is pending |

---

## Server Settings

### GET /admin/api/settings

**Auth:** `MANAGE_SERVER`

Returns the settings table as a flat string map, e.g.:

```json
{
  "server_name": "My Server",
  "motd": "Welcome!",
  "registration_mode": "invite",
  "require_2fa": "0"
}
```

---

### PATCH /admin/api/settings

Update settings. Keys are validated against a whitelist before anything is
written, and all updates are applied in one transaction; each change is
audited as `setting_change`.

**Auth:** `MANAGE_SERVER`

#### Request

A flat map of key → string value. Allowed keys: `server_name`, `server_icon`,
`motd`, `require_2fa`,
`registration_mode`, `backup_schedule`, `backup_retention`, `retention_days`,
`upload_blocked_extensions`, `upload_allowed_extensions`, `afk_timeout_seconds`,
`voice_owner_movable`, `game_activity_enabled`, `welcome_channel_id`.
Boolean settings
accept `1/0/true/false` and are normalized to `1`/`0`. `registration_mode`
accepts `closed`, `invite`, `approval` or `open` (case-insensitive, stored
lower-case); a change of mode is audited as `registration_mode_change`
naming the old and new mode, and while `require_2fa` is on the mode cannot
leave `closed`.

`backup_schedule` (`off`/`daily`/`weekly`) and `backup_retention` (days,
`0` to keep backups forever or `7`–`3650`) decide the owner-only backup
policy (BPR-072) and are enforced by the server's maintenance loop — see the
Backup Strategy section of `docs/deployment.md` for the exact semantics.
Because they control which of the owner's backups survive, they are the one
pair of settings a PATCH may not change without the **Owner** role: a request
carrying either key from a non-owner principal is refused with `403 FORBIDDEN`
even though the rest of this route only needs `MANAGE_SERVER`. `ADMINISTRATOR`
does not bypass it.

`upload_blocked_extensions` and `upload_allowed_extensions` are the upload
file-type policy (see [`POST /api/v1/uploads`](#post-apiv1uploads)): extensions
separated by commas or spaces, with or without the dot, stored lower-case,
deduplicated and comma-separated. An entry that is nothing but dots, holds a
dot after its leading ones, a path or stream separator or an invisible
character, or is longer than 32 bytes, is refused with `400`. A saved row
replaces the matching config.yaml list; an empty allowed list turns allow-only
mode off. Like the backup policy they need the **Owner** role (`403 FORBIDDEN` otherwise).

`voice_owner_movable` (WP 8.4a) decides whether a member holding `MOVE_MEMBERS`
can move the owner between voice channels: `true` (the default while no row
exists) or `false`, also accepted as `1`/`0`. It is stored as `true`/`false`.
Only the **Owner** role may change it (`403 FORBIDDEN` otherwise).

`game_activity_enabled` (WP 8.3e-2) decides whether members' game activity and,
since WP 8.10a, the song they are listening to are shown on this server (the
admin panel calls it "Member activity (games and music)"): `true` (the default while no row exists) or `false`, also
accepted as `1`/`0`, stored as `true`/`false`. Unlike `voice_owner_movable` it
is not owner-only: `MANAGE_SERVER` may change it. A save hands the value to the
running hub, which clears every shown game and song when it is `false` and sends the
[`game_activity_policy`](protocol.md#game_activity_policy-server---client-broadcast)
frame to every connected client; an unreadable row at start-up counts as `false`.

`retention_days` (B4-11) is the server-wide message-retention window: `0`
(the default) keeps everything, otherwise between 1 and 3650 days; a change
is audited as `retention_policy_change` naming the old and new value. The
maintenance loop removes past-window messages and their attachments per
channel (pinned messages exempt, direct messages never in scope); a
per-channel override in either direction is
[`PUT /admin/api/channels/{id}/retention`](#put-adminapichannelsidretention).

`afk_timeout_seconds` (WP 6.10a) is how long a member must have been idle
before the AFK channel may take them: one of `60`, `300`, `900`, `1800` or
`3600`, anything else is refused with `400`. A server with no row uses `300`.
Which channel is the AFK channel is not a setting: see
[`PUT /admin/api/afk-channel`](#put-adminapiafk-channel).

`welcome_channel_id` (WP 8.6) names the text channel that greets each new member
with a `member_join` row (see `docs/protocol.md`): the id of an existing,
non-archived `text` channel, or the empty string to turn welcome messages off (the
default while no row exists). A voice, archived, missing or non-numeric id is refused
with `400`. It needs only `MANAGE_SERVER`. The pointer can dangle later (the channel
deleted or archived): registration then writes no row and still succeeds.

`server_name` (1–100 bytes) and `motd` (at most 500 bytes) are trimmed and
held to the same limits the first-run setup wizard enforces.

`server_icon` is accepted and stored but has **no runtime effect** (reserved
for a future release). `max_upload_bytes` and `voice_quality` are refused with
`400` (`<key> is set in config.yaml, not here`): the real settings are
`upload.max_size_mb` and `voice.quality` in config.yaml. The setup wizard still
writes both rows and `GET /admin/api/settings` still returns them; the admin
panel reads the values in effect from
[`GET /admin/api/config`](#get-adminapiconfig).

Enabling `require_2fa` is refused unless registration is closed **and** every
user has TOTP enabled.

#### Response 200 OK -- the full settings map after the update.

#### Errors

| Status | Code          | Cause                                                                                      |
| ------ | ------------- | ------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST` | Unknown key, a value outside its key's rules above, or `require_2fa` preconditions not met |

---

### PUT /admin/api/afk-channel

Names the server's AFK channel, or clears it (WP 6.10a). Clearing the old flag
and setting the new one is one transaction, audited as `afk_channel_change`,
and a `channel_update` is broadcast for each channel whose flag moved. The AFK
channel is listen-only: its voice tokens grant no microphone, camera or screen
sharing.

**Auth:** `MANAGE_SERVER`

#### Request

```json
{ "channel_id": 12 }
```

`channel_id` must be present: a channel id flags that channel, `null` clears
the flag.

#### Response 200 OK

```json
{ "channel_id": 12 }
```

#### Errors

| Status | Code            | Cause                                                 |
| ------ | --------------- | ----------------------------------------------------- |
| 400    | `BAD_REQUEST`   | `channel_id` missing or not an id or `null`           |
| 400    | `INVALID_INPUT` | The channel is not a voice channel, or it is archived |
| 404    | `NOT_FOUND`     | No such channel (a DM id answers the same)            |

### GET /admin/api/config

**Auth:** `MANAGE_SERVER`

The config.yaml values the admin panel's Settings page shows as read-only
facts, taken from the configuration the server booted with — so an edit to
config.yaml shows here only after a restart, which is also when it takes
effect. Secrets appear only as `gif_configured` / `github_configured`
booleans. `tls_domain`, `voice_url` and `backup_dir` are included only when
the caller holds `ADMINISTRATOR` or is the owner. `logging_level` is the
level the server booted at, normalised (an unrecognised value reads `info`,
an unset one `""`); a debug boost in force shows in
`GET /admin/api/logs/level`, not here. `upload_blocked_extensions` and
`upload_allowed_extensions` are config.yaml's file-type lists, which the
Settings page shows until the owner saves its own.

#### Response 200 OK

```json
{
  "upload_max_size_mb": 100,
  "voice_quality": "medium",
  "upload_blocked_extensions": ["bat", "cmd", "ps1", "vbs", "js", "hta"],
  "upload_allowed_extensions": [],
  "server_port": 8443,
  "min_free_disk_mb": 256,
  "max_ws_connections": 1000,
  "tls_mode": "acme",
  "tls_domain": "chat.example.com",
  "user_quota_mb": 0,
  "backup_dir": "data/backups",
  "logging_level": "info",
  "voice_url": "ws://localhost:7880",
  "moderation_report_retention_days": 30,
  "moderation_action_retention_days": 90,
  "gif_configured": true,
  "github_configured": false
}
```

#### Errors

| Status | Code                 | Cause                                                     |
| ------ | -------------------- | --------------------------------------------------------- |
| 503    | `CONFIG_UNAVAILABLE` | The admin API was built without the running configuration |

---

## API Tokens

Owner role or `MANAGE_TOKENS` (WP 8.4d; `ADMINISTRATOR` does not pass): minting a
long-lived bearer credential over the network is the one admin action that, via a hijacked session, would outlive a password change or an
admin force-logout (API tokens deliberately live outside the session table;
sign-out-everywhere and account recovery do revoke them). These
routes are the HTTP equivalent of the `server token create|list|revoke` CLI. A
holder who is not the owner sees only the tokens bound to them, creates tokens
only for their own account (an empty `username` is themself; another username is
`403`) and revokes only their own (another's is `404`, like an unknown id). The
owner is unchanged.

### GET /admin/api/tokens

**Auth:** Owner role or `MANAGE_TOKENS` (own tokens only for a holder)

#### Response 200 OK

Array of:

```json
{
  "id": 1,
  "user_id": 1,
  "username": "owner",
  "label": "ci-bot",
  "created_at": "2026-08-01T10:00:00Z",
  "last_used": null,
  "expires_at": null,
  "revoked_at": null
}
```

Token hashes are never returned.

---

### POST /admin/api/tokens

**Auth:** Owner role or `MANAGE_TOKENS` (own tokens only for a holder)

#### Request

```json
{
  "label": "ci-bot",
  "username": "",
  "expires_hours": 0
}
```

`label` is required. Empty `username` binds the token to the owner account;
`expires_hours: 0` means never expires.

#### Response 201 Created

```json
{
  "id": 2,
  "token": "raw-api-token",
  "label": "ci-bot",
  "user": "owner"
}
```

The raw token is shown exactly once and is never recoverable.

---

### DELETE /admin/api/tokens/{id}

**Auth:** Owner role or `MANAGE_TOKENS` (own tokens only for a holder)

#### Response 204 No Content

`404 NOT_FOUND` if there is no _active_ token with that id.

---

## Backups

Backups are SQLite snapshots (`VACUUM INTO`) stored under `data/backups/`. Create,
list and download (the link and its redemption) are for the Owner or a holder
of `MANAGE_BACKUPS` (`ADMINISTRATOR` passes like for every bit); restore, delete
and the full archive are for the Owner or a holder of `RESTORE_BACKUPS` (WP
8.4d; `ADMINISTRATOR` does not pass), who can also list backups. The backup
schedule and retention stay Owner-only. A backup holds every message and every
password hash, which is why only the owner or an Administrator can grant
`MANAGE_BACKUPS`.

### POST /admin/api/backup

Create a backup named `chatserver_<UTC timestamp>.db`. One manual backup runs
at a time: a second request while one is in flight is `409 BACKUP_RUNNING` and
starts nothing.

**Auth:** Owner role or `MANAGE_BACKUPS`

#### Response 200 OK

```json
{
  "path": "chatserver_20260804_120000.db",
  "created": "20260804_120000"
}
```

---

### GET /admin/api/backups

List backups, newest first. This is every `.db` file in the backup directory, including the `pre_restore_` safety copies a restore writes.

**Auth:** Owner role, `MANAGE_BACKUPS` or `RESTORE_BACKUPS`

#### Response 200 OK

```json
[{ "name": "chatserver_20260804_120000.db", "size": 1048576, "date": "2026-08-04T12:00:00Z" }]
```

---

### DELETE /admin/api/backups/{name}

**Auth:** Owner role or `RESTORE_BACKUPS`

`name` is validated against path traversal. Returns `204 No Content`, or
`404 NOT_FOUND` if the file does not exist.

---

### POST /admin/api/backups/{name}/link

Issue a short-lived, single-use link to download one backup file, on the same
terms as the [archive link](#post-adminapiarchivelink). Audited as `backup_link`.

**Auth:** Owner role or `MANAGE_BACKUPS`

#### Response 200 OK

```json
{
  "path": "/admin/api/backups/chatserver_20260804_120000.db/download?token=…"
}
```

The token is random, bound to the requesting credential and to this one file,
valid for about a minute and consumable once. It is never logged. `400` for a
name that fails the path-traversal check, `404 NOT_FOUND` when no such `.db`
backup exists.

---

### GET /admin/api/backups/{name}/download

Redeem a single-use backup link. **Auth:** the `token` query parameter, as for
[`GET /admin/api/archive/download`](#get-adminapiarchivedownload); the
credential that asked for it must still be a signed-in, non-banned Owner or
holder of `MANAGE_BACKUPS` (the bit is re-checked when the link is opened), and
`{name}` must be the file the link was issued for. `200
application/octet-stream` streamed from disk as an attachment, audited as
`backup_download`; `403 FORBIDDEN` for an unknown, expired, already-used or
other-file token or a principal that no longer qualifies.

---

### POST /admin/api/backups/{name}/restore

Restore the database from a backup. The server checks the backup, writes a
`pre_restore_<timestamp>.db` safety backup (the restore is aborted if that
fails), stages a checked copy and a marker beside the database, responds, and
restarts itself through the normal shutdown. The database that is running is
not written. The next start swaps the staged copy in before the database
opens, checks it, and keeps the previous database if the check fails.

**Auth:** Owner role or `RESTORE_BACKUPS`

#### Response 200 OK

```json
{
  "message": "restore staged — server restarting",
  "backup": "chatserver_20260804_120000.db"
}
```

A `500 INTERNAL_ERROR` ("could not stage the backup — database untouched")
means the copy could not be written, for example because the database volume
is full; nothing restarts. `409 DATABASE_BUSY` is no longer returned.

---

### GET /admin/api/archive

Download the full archive: a `VACUUM INTO` snapshot of the database, the data
directory and `config.yaml` in one zip. What it carries and leaves out is in
[deployment.md](deployment.md#the-full-archive).

The admin panel does not call this route; it asks for a single-use link
(`POST /admin/api/archive/link`) and opens that, so a large archive streams to
disk instead of being buffered in the page. This route stays for direct API
callers that send the `Authorization` header themselves.

**Auth:** Owner role or `RESTORE_BACKUPS`

#### Response 200 OK

`application/zip`, sent as `attachment; filename="owncord-archive.zip"`. The
zip is built before the status is written, so a failed build is a JSON error:
`507 STORAGE_LOW_DISK` when building it would leave the backup directory's
volume below `server.min_free_disk_mb`, otherwise `500 INTERNAL_ERROR`.
`409 ARCHIVE_IN_PROGRESS` while another archive is being built or sent.

---

### POST /admin/api/archive/link

Issue a short-lived, single-use link to the full archive, for the panel to
open as a plain browser download.

**Auth:** Owner role or `RESTORE_BACKUPS`

#### Response 200 OK

```json
{
  "path": "/admin/api/archive/download?token=…"
}
```

The token is random, bound to the requesting owner, valid for about a minute
and consumable once. It is never logged. `409 ARCHIVE_IN_PROGRESS` while
another archive is being built or sent.

---

### GET /admin/api/archive/download

Redeem a single-use archive link. **Auth:** the `token` query parameter (a
browser download cannot send an `Authorization` header); the token IS the
authorisation, and the credential that asked for it must still be a signed-in,
non-banned Owner. `200 application/zip` on success, `403 FORBIDDEN` for an
unknown, expired or already-used token or a principal that no longer
qualifies, `409 ARCHIVE_IN_PROGRESS` while another archive is being built or
sent.

---

## Server Updates

Self-update from GitHub Releases, for the Owner or a holder of `MANAGE_UPDATES` (WP 8.4d; `ADMINISTRATOR` does not pass) (minisign/Ed25519-verified; see
`docs/security.md`).

### GET /admin/api/updates

**Auth:** Owner role or `MANAGE_UPDATES`

#### Response 200 OK

```json
{
  "current": "v1.2.0-alpha.4",
  "latest": "v1.2.0",
  "update_available": true,
  "required_assets_present": true,
  "release_url": "…",
  "download_url": "…",
  "checksum_url": "…",
  "signature_url": "…",
  "manifest_url": "…",
  "manifest_signature_url": "…",
  "release_notes": "…",
  "can_apply": true
}
```

`can_apply` is `false` when `POST /updates/apply` would refuse; checking still
works, and `apply_blocked` (present only then) says why:

- `container`: a container deployment (detected via `OWNCORD_CONTAINER`, which
  the shipped Dockerfile sets, or the engine marker files). The admin SPA
  replaces the apply button with an image-upgrade note. This wins when both
  reasons apply.
- `install_read_only`: the service cannot create files in the folder that holds
  its program file. The admin SPA says to install the new release by hand.

#### Errors

| Status | Code                  | Cause                             |
| ------ | --------------------- | --------------------------------- |
| 503    | `UPDATE_UNAVAILABLE`  | Update checking is not configured |
| 502    | `UPDATE_CHECK_FAILED` | GitHub API failure                |

---

### POST /admin/api/updates/apply

Download, verify and apply the latest release. On success the server responds
first, then broadcasts a restart notice, swaps the binary (with staged-hash
re-verification against TOCTOU swaps), spawns the new process and shuts down.

**Auth:** Owner role or `MANAGE_UPDATES`

#### Response 200 OK

```json
{ "status": "applying", "version": "v1.2.0" }
```

#### Errors

| Status | Code                                                         | Cause                                                                                                                                                       |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 503    | `CONTAINER_DEPLOYMENT`                                       | Container deployment — the binary is image content; upgrade by pulling the new image (opt back in with `OWNCORD_CONTAINER=0` if the binary is bind-mounted) |
| 503    | `INSTALL_READ_ONLY`                                          | The service cannot write to the folder that holds its program file; checked before any download. Install the new release by hand                            |
| 503    | `UPDATE_UNAVAILABLE`                                         | Update checking is not configured                                                                                                                           |
| 503    | `SHUTTING_DOWN`                                              | The server has begun shutting down, so the update was not downloaded or applied (checked before the download and again before the restart countdown starts) |
| 409    | `RESTART_PENDING`                                            | A restart from an earlier apply/restore is already pending                                                                                                  |
| 409    | `UPDATE_IN_PROGRESS`                                         | Another restart-sensitive operation (update apply or backup restore) is running                                                                             |
| 409    | `NO_UPDATE`                                                  | Already up to date                                                                                                                                          |
| 503    | `SERVER_SHUTTING_DOWN`                                       | The server began shutting down while the update was being checked or downloaded; nothing was applied, try again once it is back                             |
| 502    | `UPDATE_CHECK_FAILED` / `MISSING_ASSETS` / `DOWNLOAD_FAILED` | Check, asset or download/verification failure                                                                                                               |

---

## Server Logs (SSE)

Streaming the server log requires two steps because `EventSource` cannot send
an `Authorization` header.

### POST /admin/api/logs/ticket

Issue a single-use ticket (30 s TTL) bound to the calling bearer credential.

**Auth:** `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)

#### Response 200 OK

```json
{ "ticket": "64-hex-chars" }
```

---

### GET /admin/api/logs/stream?ticket={ticket}

Server-Sent Events stream of structured log records: on connect the in-memory
ring buffer (capacity 2000) is replayed as backfill, then new entries stream
live, with a keepalive every 15 s. The ticket is consumed on connect; the
`VIEW_DIAGNOSTICS` bit (or `ADMINISTRATOR`) is re-checked throughout the stream, and revoking the
underlying session or API token (or banning the user) mid-stream cuts it.
The server ends every open stream as its shutdown begins, so an open stream
does not hold up a restart; reconnect with a fresh ticket once it is back.

**Auth:** single-use ticket (from `POST /admin/api/logs/ticket`)

Each event's data is one JSON record:

```json
{ "ts": "2026-08-04T12:00:00Z", "level": "INFO", "msg": "…", "source": "…", "attrs": "…" }
```

---

### GET /admin/api/logs/level

The log level the server is running at, the level it started with (and
reverts to), and when a debug boost reverts.

**Auth:** `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)

#### Response 200 OK

```json
{ "level": "debug", "base_level": "info", "reverts_at": "2026-09-28T12:15:00Z" }
```

`reverts_at` is absent when no boost is pending.

#### Errors

| Status | Code                 | Cause                                                    |
| ------ | -------------------- | -------------------------------------------------------- |
| 503    | `CONFIG_UNAVAILABLE` | The admin API was built without the log-level controller |

---

### PATCH /admin/api/logs/level

Raise the server's log level to `debug` for 15 minutes. The server reverts to
`base_level` on its own when the window ends; a second PATCH restarts the
window. Recorded in the audit log as `log_level_debug_on`.

**Auth:** `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)

#### Request

```json
{ "level": "debug", "duration_seconds": 900 }
```

Both fields are required and only these values are accepted.

#### Response 200 OK -- same shape as `GET /admin/api/logs/level`.

#### Errors

| Status | Code                 | Cause                                                    |
| ------ | -------------------- | -------------------------------------------------------- |
| 400    | `BAD_REQUEST`        | Invalid body, or any level or window other than above    |
| 503    | `CONFIG_UNAVAILABLE` | The admin API was built without the log-level controller |

---

### DELETE /admin/api/logs/level

Revert to `base_level` at once and cancel a pending boost. Recorded in the
audit log as `log_level_reverted`.

**Auth:** `VIEW_DIAGNOSTICS` (`ADMINISTRATOR` passes)

#### Response 200 OK -- same shape as `GET /admin/api/logs/level`.

#### Errors

| Status | Code                 | Cause                                                    |
| ------ | -------------------- | -------------------------------------------------------- |
| 503    | `CONFIG_UNAVAILABLE` | The admin API was built without the log-level controller |

---

## Role Management

Create, edit, delete and reorder roles. The whole group requires
`MANAGE_ROLES`; `RoleService` then enforces the hierarchy rules below, so a
principal that clears the bit still cannot escalate through it.

**Rules, all measured against the _actor's_ role position:**

- You may only create, edit, delete or reorder roles positioned **strictly
  below** your own. Equal rank is refused too, so a role cannot rewrite itself.
  Nothing sits above position 100, which makes the seeded Owner role
  immutable and undeletable for everyone, owner included.
- You may never **grant** a permission bit your own role lacks. Removing one is
  allowed — de-escalation is always safe. `ADMINISTRATOR` bypasses this check
  entirely (it is what lets the owner hand out anything).
- The default role (`is_default = 1`) cannot be deleted: every member falls
  back to it.
- Deleting a role gives the default role to each member it leaves with no
  role (a member who holds another role keeps it and is not moved), re-derives
  every holder's top role in the same transaction, drops the role's `channel_overrides` rows, invalidates the moved members'
  cached permissions, and broadcasts a `member_update` per member.
- Names are unique **case-insensitively** (migration `023`), matching the
  case-insensitive lookup the desktop client does. Max 32 characters.
- Colors are `#rgb` or `#rrggbb`, normalized to uppercase. `""` clears the
  color. Anything else is `400`.
- Unknown permission bits are masked off rather than rejected.
- Moving a role (a `position` edit or a reorder) re-derives the top role of
  every member who holds it next to another role, and sends them a
  `member_update`.
- Every mutation writes an audit row (`role_create`, `role_update`,
  `role_delete`, `role_reorder`) and broadcasts `roles_update` (see
  `docs/protocol.md`) carrying the full new list.

### GET /admin/api/roles

Roles ordered by position descending, each with its member count.

#### Response 200 OK

```json
[
  {
    "id": 1,
    "name": "Owner",
    "color": "#E74C3C",
    "permissions": 2147483647,
    "position": 100,
    "is_default": false,
    "member_count": 1
  },
  {
    "id": 4,
    "name": "Member",
    "color": null,
    "permissions": 1635,
    "position": 40,
    "is_default": true,
    "member_count": 12
  }
]
```

### POST /admin/api/roles

#### Request

```json
{
  "name": "Helper",
  "color": "#5865F2",
  "permissions": 3,
  "position": 50
}
```

| Field         | Type    | Required | Description                                                           |
| ------------- | ------- | -------- | --------------------------------------------------------------------- |
| `name`        | string  | Yes      | 1–32 characters, unique case-insensitively                            |
| `color`       | string  | No       | `#rgb`/`#rrggbb`, or `""` for none                                    |
| `permissions` | integer | No       | Bitfield; defaults to `0`                                             |
| `position`    | integer | No       | Must be free; defaults to the highest free slot below the actor's own |
| `hoist`       | boolean | No       | The role is its own member-list group; defaults to `false`            |
| `mentionable` | boolean | No       | Any member may ping the role; defaults to `false`                     |

#### Response 201 Created

The created role (`id`, `name`, `color`, `permissions`, `position`,
`is_default` — always `false`; the default role is seeded, never created —
`hoist` and `mentionable`).

#### Errors

| Status | Code          | When                                                                                |
| ------ | ------------- | ----------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Missing/blank/over-long name, duplicate name, bad color, negative or taken position |
| 403    | `FORBIDDEN`   | Missing `MANAGE_ROLES`, position at or above your own, or a permission bit you lack |

### PATCH /admin/api/roles/{id}

Partial update — every field is optional and an omitted one is left alone.
Same body and same errors as `POST`, plus `404 NOT_FOUND` for a missing role.
Editing a role at or above your own position is `403`.

`expected_permissions` (optional integer) is the permission mask the editor
loaded. When present and the role's stored mask is different, nothing is
written and the response is `409` with code `ROLE_CONFLICT`: another admin
changed the role since it was loaded, so reload it and apply the change again.
Omit the field to skip the check (the admin panel always sends it). The
comparison and the write happen under one lock, so two edits that carry the
same `expected_permissions` cannot both succeed.

| Status | Code            | When                                                       |
| ------ | --------------- | ---------------------------------------------------------- |
| 409    | `ROLE_CONFLICT` | `expected_permissions` differs from the role's stored mask |

A permission change additionally invalidates the cached permissions of that
role's members and re-syncs their channel visibility (the server sends targeted
`channel_create`/`channel_delete`), because a role's mask is the base every
channel's effective permission derives from.

#### Response 200 OK

The updated role.

### DELETE /admin/api/roles/{id}

#### Response 204 No Content

#### Errors

| Status | Code          | When                                                                 |
| ------ | ------------- | -------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | The role is the default role, or is the seeded Owner role            |
| 403    | `FORBIDDEN`   | Missing `MANAGE_ROLES`, or the role is at or above your own position |
| 404    | `NOT_FOUND`   | No such role                                                         |

### PATCH /admin/api/roles/reorder

#### Request

```json
{ "role_ids": [2, 9, 3, 4] }
```

`role_ids` is highest-rank-first and must name **exactly** the set of roles
strictly below your own position — a partial list is refused rather than
silently leaving the omitted roles at positions that now collide. Positions are
normalized to `N…1`, so they stay unique, stay below the actor, and never
collide with the untouched roles above.

#### Response 200 OK

The full role list after the reorder, position descending.

#### Errors

| Status | Code          | When                                                                    |
| ------ | ------------- | ----------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Wrong number of ids, or a duplicate id                                  |
| 403    | `FORBIDDEN`   | Missing `MANAGE_ROLES`, or an id that is unknown or not below your rank |

---

## Channel Management (admin)

`POST /admin/api/channels` takes `{name, type, category_id, category, topic, position}`;
`PATCH /admin/api/channels/{id}` takes `{name, topic, category_id, category, slow_mode,
position, archived, nsfw, voice_max_users, voice_max_video, password}` and seeds every
omitted field from the current row, so a partial body is safe.

The numeric fields are bounds-checked before anything is written, and an
out-of-range value is refused with `400 INVALID_INPUT` rather than clamped —
a caller that sent `-1` meant something, and storing `0` would hide it. A
refused body writes nothing at all:

| Field             | Range   | Meaning                                                   |
| ----------------- | ------- | --------------------------------------------------------- |
| `slow_mode`       | 0…21600 | Cooldown in seconds; 0 = off (6-hour ceiling, as Discord) |
| `voice_max_users` | 0…99    | Voice capacity; 0 = unlimited                             |
| `voice_max_video` | 0…99    | Simultaneous cameras/screen shares; 0 = unlimited         |

`nsfw` is a bool; the server stores, broadcasts and audits it, and enforces it
on every content path (see "NSFW Acknowledgement"). The
audit detail names the transition: `updated #foo (marked NSFW)` /
`(unmarked NSFW)`, and plain `updated #foo` when the flag did not move.

`password` (string) on the `PATCH` sets, changes or removes a voice channel's
password: absent leaves it alone, `""` removes it, anything else (1 to 64
characters, no control characters) becomes the password and is stored only as a
bcrypt hash. On a channel that is not a voice channel any value answers `400`.
Every set, change or removal makes members enter the new password on their next
join but removes nobody already inside, and the audit detail reads `updated #foo
(password set)` / `(password changed)` / `(password removed)`, never the password.
No response, list or broadcast carries the password or its hash; they show
`password_protected` only.

The voice limits are stored on a channel of any type but are only meaningful on
a voice one; the desktop client offers them for voice channels alone and omits
the keys entirely elsewhere, so a text-channel edit cannot wipe limits the row
happens to hold.

`type` must be `text`, `voice` or `announcement` (`400 INVALID_INPUT`
otherwise). **`category` constrains nothing.** Categories are free text and a
channel of any type may live under any of them — a voice channel under
"Gaming", a text channel under "Voice Channels". Grouping is a display concern:
the desktop client groups by whatever category a channel carries and falls back
to a synthetic "Voice" group only for voice channels with no category at all.
(Before phase 5 the server refused any non-voice channel under a category
literally named "Voice Channels", and any voice channel outside it.)

`PATCH` accepts `category_id`, so moving a channel between categories is an edit
rather than a delete-and-recreate. `0` makes it uncategorized, and an id that
does not exist is `400 INVALID_INPUT`. The older `category` name string still
works on create and `PATCH`: it is matched to a category by name ignoring case,
a name that matches none creates the category, and an empty string means none.
`category_id` wins when both are sent, and a `PATCH` that names neither leaves
the category alone.

### Categories (WP 6.5a)

A category is an object with an `id`, a `name` (at most 100 characters, unique
ignoring case) and a `position`. Five routes manage them, all behind
`MANAGE_CHANNELS`, mounted under both `/admin/api/channels` and
`/api/v1/moderation/channels`:

| Route                        | Body           | Result                                                                                                               |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET  .../categories`        | none           | `200` array of `{id, name, position}` by `(position, id)`                                                            |
| `POST .../categories`        | `{name}`       | `201` the new category, appended last. `409 CATEGORY_NAME_TAKEN` on a duplicate                                      |
| `PUT  .../categories/order`  | `{ids: [...]}` | `200` the new list. The ids must be exactly the current set: `409 CATEGORY_LIST_STALE` and nothing written otherwise |
| `PATCH .../categories/{id}`  | `{name}`       | `200` the renamed category. `404` when missing, `409 CATEGORY_NAME_TAKEN` on a duplicate                             |
| `DELETE .../categories/{id}` | none           | `204`. Its channels are not deleted: they keep their overrides and become uncategorized                              |

Every mutation is audited (`category_create`, `category_rename`,
`category_reorder`, `category_delete`). A rename, reorder or delete changes the
`category`, `category_id` and `category_position` of the channels in the
touched categories, so the server re-broadcasts `channel_update` for each of
them and then sends `channel_categories` to connected managers (see
[protocol.md](protocol.md#channel_categories-server---client)).

A name already used by another channel of the same `type` in the same
category (`category_id`) is refused with `409 CHANNEL_NAME_TAKEN`, ignoring case: a create,
or a `PATCH` that changes the name or the category. It is a check at write
time, not a database constraint, so channels that already share a name are
left as they are, and a `PATCH` that leaves both name and category alone still
saves.

### Category permissions (WP 6.5d)

A category carries permission overrides that its channels can stay **synced**
to. They are a template that is copied onto channels, never inherited: a
channel's effective access is still computed from its own override rows alone.
The routes are on `/admin/api` only, behind `MANAGE_CHANNELS` like the channel
override routes:

| Route                                                      | Body            | Result                                                                                              |
| ---------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `GET  /admin/api/channels/categories/{id}/permissions`     | none            | `200` `{category_id, roles, users}`: every role (zero masks when it has no row), existing user rows |
| `PUT  .../categories/{id}/permissions/{roleId}`            | `{allow, deny}` | `200` the role row. Writes the category row and the same row on every synced channel                |
| `DELETE .../categories/{id}/permissions/{roleId}`          | none            | `204`. Removes the category row and the row on every synced channel                                 |
| `PUT/DELETE .../categories/{id}/user-permissions/{userId}` | as above        | the same for one member                                                                             |
| `POST /admin/api/channels/{id}/permissions/sync`           | none            | `200` `{channel_id, permissions_synced}`. Replaces the channel's rows with its category's template  |

A write runs the channel override guards over everything it touches: the
escalation guard covers the bits written, the bits already on the category row
and the bits already on every synced channel row it overwrites (a role cannot
set or clear a bit its own role lacks), and the hierarchy rules apply to a role
or member target. Any refusal is `403` and nothing is written; the category row
and the channel rows are written in one transaction, and the channel set is read
inside it. A sync, or a `PATCH` with `sync_permissions: true`, is guarded the
same way over the union of the rows it removes and the rows it writes, and
answers `400` when the channel has no category. A changed set of rows under a
sync answers `409 PERMISSIONS_CHANGED` (retry). Writes are audited
(`category_perms_update`, `category_perms_clear`, `category_user_perms_update`,
`category_user_perms_clear`, `channel_perms_sync`).

Sync lifecycle: a channel created in a category (by `category_id` or the legacy
name) starts as a copy of the template and synced; copying is not a grant by the
creator, so it is not blocked by bits the creator lacks. A direct write or delete
of a channel override, or a `PATCH` that moves the channel to another category,
sets `permissions_synced` to false and keeps its rows, unless the `PATCH` carries
`sync_permissions: true`, which replaces its rows with the target category's
template and marks it synced. `sync_permissions` on a `PATCH` works on both channel
mounts (`/admin/api/channels/{id}` and `/api/v1/moderation/channels/{id}`); combined
with a legacy `category` name that would create a new category it answers `400`,
because a new category has no template to sync with. Deleting a category drops its template; its
channels keep their rows and become unsynced. `permissions_synced` is on the
admin channel list and on `GET /admin/api/channels/{id}/permissions`; it is not
on the websocket channel payload.

---

## Channel Permission Overrides

Two override layers per channel, both gated on `MANAGE_CHANNELS` and both
audit-logged. They resolve in Discord's order:

```
base role permissions -> role override -> user override
```

The later, narrower layer wins: a **user** deny beats a **role** allow, a user
allow beats a role deny, and within one layer allow beats deny. `ADMINISTRATOR`
bypasses both layers entirely. See `docs/schema.md` ("Permission Checking
Logic") for the formula and `permissions.EffectiveChannelPerms` for the single
implementation.

Denying `READ_MESSAGES` hides the channel outright — from the WS `ready`
payload, from `GET /api/v1/channels`, from reconnect replay and from live
broadcasts. Every write below invalidates the affected permission cache entries
and then re-syncs connected clients with targeted `channel_create` /
`channel_delete` messages, so sidebars converge without a reconnect.

DM channels have no override surface: `400 INVALID_INPUT`.

A thread has no overrides, NSFW label, archive flag or retention policy of its
own: each is its parent channel's. Every `/admin/api/channels/{id}` route,
retention included, answers a thread id with `400`.

### GET /admin/api/channels/{id}/permissions

Both layers for one channel. `roles` lists **every** role (zero masks when it
carries no override) so the panel can render a complete grid; `users` lists
**only** members who actually have an override row.

#### Response 200 OK

```json
{
  "channel_id": 4,
  "roles": [
    {
      "role_id": 1,
      "role_name": "Owner",
      "position": 100,
      "permissions": 2147483647,
      "allow": 0,
      "deny": 0
    },
    {
      "role_id": 4,
      "role_name": "Member",
      "position": 40,
      "permissions": 1635,
      "allow": 0,
      "deny": 514
    }
  ],
  "users": [{ "user_id": 12, "username": "alice", "role_id": 4, "allow": 2, "deny": 0 }]
}
```

### PUT /admin/api/channels/{id}/permissions/{roleId}

### PUT /admin/api/channels/{id}/user-permissions/{userId}

Write one override row. Same body for both layers:

```json
{ "allow": 2, "deny": 1 }
```

| Field   | Type    | Description                  |
| ------- | ------- | ---------------------------- |
| `allow` | integer | Bits granted in this channel |
| `deny`  | integer | Bits refused in this channel |

Bits outside `permissions.AllPerms` are masked off rather than rejected, so an
unknown bit can never be persisted. A row with both masks `0` is meaningless —
the admin panel sends `DELETE` for that case instead.

#### Response 200 OK

The stored row: `{role_id, role_name, position, permissions, allow, deny}` for
the role layer, `{user_id, username, role_id, allow, deny}` for the user layer.

#### Cache and fan-out

- Role layer: `InvalidateAll` (any member of that role is affected), then
  `RefreshChannelVisibility`.
- User layer: `InvalidateUser(userId)` only — a per-user override cannot change
  anyone else's verdict, and dropping the whole cache for one member would cost
  every connected client a repopulate — then `RefreshChannelVisibility`, which
  resolves visibility per user through the full order.

#### Audit

`channel_perms_update` / `channel_user_perms_update`, target `channel`.

#### Errors

| Status | Code            | When                          |
| ------ | --------------- | ----------------------------- |
| 400    | `BAD_REQUEST`   | Unparseable id or body        |
| 400    | `INVALID_INPUT` | The channel is a DM           |
| 403    | `FORBIDDEN`     | Missing `MANAGE_CHANNELS`     |
| 404    | `NOT_FOUND`     | Unknown channel, role or user |

### DELETE /admin/api/channels/{id}/permissions/{roleId}

### DELETE /admin/api/channels/{id}/user-permissions/{userId}

Clear the override row, returning the target to the layer above it. `204 No
Content`; deleting a row that does not exist is a no-op, not a `404`. Same
cache/fan-out behavior as the writes; audits as `channel_perms_clear` /
`channel_user_perms_clear`.

### GET /admin/api/channels/{id}/access/explain

Explain one member's effective access in a channel (RI-06). Query:
`user_id` and `action`, both required. Actions map one-to-one onto the
server's authorization predicates:

| `action`         | Predicate                                                 |
| ---------------- | --------------------------------------------------------- |
| `view_channel`   | `CanViewChannel`                                          |
| `read_content`   | `CanReadContent` (adds NSFW consent)                      |
| `send_message`   | `CanSendMessage`                                          |
| `add_reaction`   | `CanAddReaction`                                          |
| `join_voice`     | `CanJoinVoice`                                            |
| `moderate_voice` | `AuthorizeVoiceModerator` (base `MUTE_MEMBERS` + channel) |
| `move_voice`     | `AuthorizeVoiceMover` (base `MOVE_MEMBERS` + channel)     |

The decision is the predicate's own verdict over the member's live state —
role bits, both override layers, active timeout and NSFW acknowledgement,
never the 30-second permission cache. An effectively banned account, or one
whose registration is not `active`, holds no session, so every action is
denied with that reason. Nothing here creates or uses a session for the
member. `bits` traces each bit the predicate consulted through the layers
(`""` means the layer has no opinion). It is omitted when
`administrator_bypass` is true: an Administrator's decision consults no bit
and no override layer.

Like editing a member's override, explaining one is refused for a member
whose role ranks at or above the caller's own, unless the caller holds
`ADMINISTRATOR`: the answer discloses that member's ban, registration,
timeout and NSFW consent state.

```json
{
  "user_id": 12,
  "username": "alice",
  "role_id": 4,
  "role_name": "Member",
  "channel_id": 4,
  "restrictions": {
    "banned": false,
    "registration_status": "active",
    "timed_out": true,
    "nsfw_acknowledged": false,
    "channel_archived": false,
    "channel_nsfw": false,
    "channel_type": "text"
  },
  "decisions": [
    {
      "action": "send_message",
      "allowed": false,
      "reason": "user is timed out",
      "administrator_bypass": false,
      "bits": [
        {
          "bit": "SEND_MESSAGES",
          "base": true,
          "role_override": "deny",
          "user_override": "allow",
          "effective": true
        },
        {
          "bit": "READ_MESSAGES",
          "base": true,
          "role_override": "",
          "user_override": "",
          "effective": true
        }
      ]
    }
  ]
}
```

Audited as `permission_explain`, target `user`.

### POST /admin/api/channels/{id}/access/preview

Evaluate a proposed override before saving it. Body: exactly one of `role_id`
(role layer) or `user_id` (member layer), plus the `allow`/`deny` masks the
matching `PUT` would take (clamped the same way). Every member the override
could reach — each holder of the role, or the one member — is evaluated for
every action with the current and the proposed layer, through the same
predicates as `explain`; `members` lists only those whose decision changes.
Nothing is written. A `user_id` preview follows the same rank rule as
`explain`. A `role_id` preview is refused for a role at or above the caller's
own rank, with no Administrator bypass, as saving that role's override is. The
save path still applies its own escalation and hierarchy checks.

```json
{
  "channel_id": 4,
  "allow": 0,
  "deny": 2,
  "evaluated": 3,
  "members": [
    {
      "user_id": 12,
      "username": "alice",
      "changes": [
        {
          "action": "view_channel",
          "before": true,
          "after": false,
          "after_reason": "permission denied: missing READ_MESSAGES"
        }
      ]
    }
  ]
}
```

Audited as `permission_preview`, target `channel`.

| Status | Code          | When                                                                      |
| ------ | ------------- | ------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Bad `user_id`, missing or unknown `action`, or not exactly one of the ids |
| 403    | `FORBIDDEN`   | Missing `MANAGE_CHANNELS`, or the member or role ranks at or above you    |
| 404    | `NOT_FOUND`   | Unknown or DM channel, unknown role or user                               |

### Discord import

Import one Discord channel's history from a DiscordChatExporter JSON export
(a `.json` file, or a `.zip` of it with its `_Files` folder) as a new text
channel. All routes require `MANAGE_CHANNELS` and answer `503
SERVICE_UNAVAILABLE` on a server with no upload storage. One import runs at a
time, server-wide.

The channel is built hidden and published in one step when the job ends, with
every member's read state past the last message and a single `channel_create`
event; no message events, pings or unread badges are sent. Mentions are stored
as plain text. Reactions, embeds, stickers, polls, threads and system messages
are skipped and counted. Attachments are copied only from the zip, under the
normal file-type and size rules; remote links are never fetched. PNG and GIF
attachments get their width and height recorded; other images are sized by the
client when they load.

#### POST /admin/api/discord-imports/upload?filename={name}&category_id={id}

The request body is the export file itself (`application/octet-stream`),
streamed to a temp file under `data/import-tmp`, never held in memory, and
removed when the job ends. `filename` must end in `.json` or `.zip`.
`category_id` is optional; `0` or absent means no category. The body is capped
by `upload.import_max_mb` (default 500) and runs under the file-upload progress
deadline with a total time sized for the cap at 2 Mbit/s (never under 10
minutes). The category is checked and the free disk space (plus
`server.min_free_disk_mb`) is confirmed before the body is read. Answers `202 Accepted`:

```json
{ "id": 12, "status": "running" }
```

| Status | Code                  | When                                                                                     |
| ------ | --------------------- | ---------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`         | Wrong extension, bad `category_id`, unknown category, empty body, or not a usable export |
| 409    | `CONFLICT`            | Another import is running (checked before the body is read)                              |
| 413    | `PAYLOAD_TOO_LARGE`   | The file is over `upload.import_max_mb`                                                  |
| 507    | `STORAGE_LOW_DISK`    | Not enough free disk space for the upload                                                |
| 503    | `SERVICE_UNAVAILABLE` | No upload storage, or the server is shutting down                                        |

Audited as `discord_import_start`, and `discord_import_publish` when the job
finishes (target `channel`).

#### GET /admin/api/discord-imports/latest

The newest job (`null` when none ran) plus what the panel's form shows:
`retention_days` is the server-wide message window (`0` keeps everything), and
`max_upload_bytes` the largest file the upload takes. A panel that is reopened
mid-import finds the running job here.

#### GET /admin/api/discord-imports/{id}

One job, for progress polling. `status` is `running`, `done`, `failed` or
`cancelled`. `imported` rises after each chunk of about 500 messages; `total`
is known only once the job finishes. `error` is set on `failed`. `404
NOT_FOUND` for an unknown id.

```json
{
  "id": 12,
  "status": "done",
  "source_name": "general.zip",
  "imported": 4210,
  "skipped": 36,
  "skipped_attachments": 2,
  "total": 4246,
  "error": null,
  "created_at": "2026-10-30T09:15:02Z",
  "finished_at": "2026-10-30T09:15:41Z"
}
```

#### POST /admin/api/discord-imports/{id}/cancel

Asks a running job to stop. Answers `202` with `{"id": 12, "status":
"cancelling"}`; the job then ends as `cancelled`, its channel and files are
removed, and the status route reports it. `409 CONFLICT` when the job is not
running, `404 NOT_FOUND` for an unknown id. Audited as `discord_import_cancel`.

---

## Plugin Administration

Manage WASM plugins. These endpoints sit behind **both** the admin IP
restriction (allowed CIDRs) **and** admin bearer-token authentication, and
require the `ADMINISTRATOR` bit specifically (the widened admin perimeter does
not open them).
Plugin execution additionally requires a server built with `-tags wazero`
and `plugins.enabled: true` in config.

Errors use the standard JSON envelope. When the runtime is unavailable,
mutating endpoints answer `503 PLUGINS_DISABLED`. Install answers
`400 INVALID_INPUT` for a bad multipart body, a missing `plugin` part or bytes
that are not a zip, `415 UNSUPPORTED_MEDIA_TYPE` for a part not labelled as a
zip, `413 PAYLOAD_TOO_LARGE` past 16 MiB, and `400 INSTALL_FAILED` when the
package does not install. A path id below 1 is `400 BAD_REQUEST`, an unknown
id on uninstall `404 NOT_FOUND`, and a store failure `500 INTERNAL_ERROR`. `GET /api/v1/admin/plugins`
always answers `200` and reports the runtime state in an `X-Plugin-Runtime`
response header instead.

### GET /api/v1/admin/plugins

List installed plugins.

#### Response 200 OK

Array of plugin rows: `ID`, `Name`, `Version`, `Enabled`, `ManifestJSON`,
`InstalledAt`.

### POST /api/v1/admin/plugins/install

Install a plugin from an uploaded zip (multipart form). The archive is
size-capped (16 MiB compressed / 64 MiB uncompressed) and hardened against
zip-slip and symlinks; installation is staged and atomically renamed.

#### Response 201 Created

```json
{ "name": "plugin-name" }
```

### POST /api/v1/admin/plugins/{id}/enable

### POST /api/v1/admin/plugins/{id}/disable

Enable or disable an installed plugin.

### DELETE /api/v1/admin/plugins/{id}

Uninstall a plugin.

---

## LiveKit Endpoints

These endpoints are only registered when LiveKit voice is configured.

### POST /api/v1/livekit/webhook

LiveKit webhook receiver. Uses LiveKit JWT verification. IP-restricted via `server.livekit_webhook_allowed_cidrs` (falls back to `server.admin_allowed_cidrs` when unset). Called by the LiveKit server, not by clients. A missing or bad signature answers `401 UNAUTHORIZED`; a `participant_joined` that cannot be reconciled answers `503 SERVICE_UNAVAILABLE` so LiveKit retries it. Both use the standard JSON error envelope.

### GET /api/v1/livekit/health

Check whether the LiveKit server is reachable.

**Auth:** IP restriction (`server.livekit_webhook_allowed_cidrs`, admin fallback)

#### Response 200 OK

```json
{
  "status": "ok",
  "livekit_reachable": true
}
```

#### Response 503 Service Unavailable

```json
{
  "status": "degraded",
  "livekit_reachable": false,
  "error": "connection refused"
}
```

### /livekit/\* (Reverse Proxy)

All requests to `/livekit/*` are reverse-proxied to the LiveKit server URL. The `/livekit` prefix is stripped before forwarding. This allows the client to connect to LiveKit through OwnCord's HTTPS server, avoiding mixed-content blocks.

**Auth:** None (LiveKit handles its own JWT-based auth). The JWT arrives as the `access_token` query parameter (JS SDK) or an `Authorization: Bearer` header (Rust SDK, the Linux client's native voice); on a WebSocket upgrade the proxy forwards the query string, the `Sec-WebSocket-Protocol` values and `Authorization`, and no other request header.
**Rate limit:** 30 requests/minute per IP

---

## Diagnostics

### GET /api/v1/diagnostics/connectivity

Returns connectivity diagnostics for debugging voice/network issues.

**Auth:** Required — `ADMINISTRATOR` only (H-8 hardening: the response reveals network topology)
**Rate limit:** 5 requests/minute per IP

```json
{
  "server": {
    "version": "1.0.0",
    "uptime_s": 3600,
    "go_version": "go1.23.0",
    "online_users": 5
  },
  "voice": {
    "enabled": true,
    "livekit_url": "localhost:7880",
    "livekit_health": true,
    "node_ip": "203.0.113.1",
    "proxy_path": "/livekit"
  },
  "client": {
    "remote_addr": "192.168.1.100",
    "is_private_network": true,
    "address_class": "private"
  }
}
```

`client.address_class` is one of `loopback`, `private`, `cgnat`, `link_local`,
`unique_local`, `global` or `other`. It exists because `is_private_network`
alone cannot distinguish a LAN host from a tailnet peer from a carrier-NAT
client — `cgnat` covers `100.64.0.0/10`, which is both the carrier-NAT range
and the range Tailscale allocates from.

#### The `reachability` block (optional)

When `server.reachability_report_enabled` is set, the response carries an
extra `reachability` object. It is **off by default**: it enumerates every
address on every interface, which is the most topology-revealing part of an
endpoint that is already admin-only for that reason. With the flag off the key
is absent rather than empty, so "switched off" cannot be misread as "nothing to
report".

```json
{
  "reachability": {
    "listen_port": 8443,
    "binds_all_interfaces": true,
    "local_addresses": [
      { "addr": "127.0.0.1", "kind": "loopback" },
      { "addr": "192.168.1.50", "kind": "private" }
    ],
    "has_global_address": false,
    "cgnat_range_present": false,
    "required_ports": [
      { "port": "8443", "protocol": "tcp", "purpose": "OwnCord HTTPS, REST API and WebSocket" }
    ],
    "tls_mode": "self_signed",
    "public_ip_https_supported": false,
    "public_ip_https_reason": "This build cannot obtain a certificate for a bare IP address: ...",
    "undeterminable": [
      {
        "fact": "Whether TCP port 8443 is reachable from the internet",
        "why": "Proving inbound reachability needs something outside your network to connect back in. ...",
        "how_to_check": "Test from a network that is not your own — a phone on mobile data works — ..."
      }
    ]
  }
}
```

The `undeterminable` list is the point of the block, and it is never empty —
not even on a host where everything looks correct. **The server performs no
network probe of any kind**: it opens no socket and resolves no name, so it
cannot and does not claim to know whether anything outside can reach it.
Blocked ports, CGNAT, hairpin NAT and a changing public IP are all invisible
from inside the network, and each entry names the check the owner runs
instead. `cgnat_range_present` is reported with a `cgnat_note` giving both
explanations for a `100.64.0.0/10` address, never a verdict.

See [docs/port-forwarding.md](port-forwarding.md) for the operator-facing
version of the same material.

---

## Client Auto-Update

### GET /api/v1/client-update/{target}/{current_version}

Tauri-compatible update endpoint. The desktop client checks this to see if a newer version is available.

**Auth:** None

#### Path Parameters

| Param             | Type   | Description                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`          | string | Tauri updater target `{os}-{arch}-{installer}` (e.g., `windows-x86_64-nsis`, `windows-aarch64-nsis`, `linux-x86_64-appimage`, `linux-aarch64-appimage`). Selects the platform's updater artifact and is echoed back as the `platforms` key. Targets without a published updater artifact get 204. The `linux-x86_64-deb` and `linux-aarch64-deb` targets are served only with `?deb_install=pkexec` (see below). |
| `current_version` | string | Client's current semver version (e.g., `1.0.0`)                                                                                                                                                                                                                                                                                                                                                                  |

#### Query Parameters

| Param         | Type   | Description                                                                                                                                                                                                                                                                                   |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deb_install` | string | Opt-in for the `linux-*-deb` targets. Exactly `pkexec` (case-sensitive) says the client can install a signed `.deb` through a privileged helper. Without it a `-deb` target always gets 204, so older `.deb` clients keep their "cannot update itself" notice. Ignored on every other target. |

For an opted-in `-deb` client the server also answers **200 with the latest
version** when the client is already current or newer, instead of 204. The
Tauri plugin resolves the platform entry before it compares versions; the 200
tells the client that the server can serve its package, so it can tell
"up to date" from "this server cannot serve me". The protocol-epoch withhold
and a release without a signed `.deb` still give 204.

#### Response 200 OK (update available, or an opted-in `-deb` client)

```json
{
  "version": "1.2.0",
  "notes": "## What's Changed\n...",
  "pub_date": "2026-03-28T00:00:00Z",
  "platforms": {
    "windows-x86_64-nsis": {
      "signature": "base64-encoded-signature",
      "url": "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/OwnCord_1.2.0_x64-setup.nsis.zip"
    }
  }
}
```

#### Response 204 No Content

Client is already up-to-date (except an opted-in `-deb` client, see above), no client build is published for `target`, or
the newest release speaks a **newer protocol epoch than this server** (read
from the release's signed server-update manifest, `protocol_epoch`; a manifest
that fails signature verification is withheld the same way). The server
upgrades first, then its clients are offered the matching release — see
`docs/protocol.md`, Compatibility.

---

## WebSocket

### GET /api/v1/ws

WebSocket upgrade endpoint. Authentication is performed in-band (first message must be an `auth` frame with the session token). See [protocol.md](protocol.md) for the full WebSocket message protocol.
