# REST API Spec

Base URL: `https://{server}:{port}/api`

Auth: session token in cookie `session` (set on login) or `Authorization: Bearer {token}` header for programmatic access.

All responses are JSON. Errors return `{ "error": "CODE", "message": "Human-readable detail" }`.

---

## Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | None (requires invite code) | Create account |
| POST | `/api/auth/login` | None | Login, returns session token |
| POST | `/api/auth/logout` | Yes | Invalidate current session |
| POST | `/api/auth/verify-totp` | Partial (after login with 2FA) | Submit TOTP code |

### POST /api/auth/register
```json
// Request
{ "username": "alex", "password": "strongpassword", "invite_code": "abc123" }
// Response 201
{ "user": { "id": 1, "username": "alex" }, "token": "session-token" }
```

### POST /api/auth/login
```json
// Request
{ "username": "alex", "password": "strongpassword" }
// Response 200 (no 2FA)
{ "token": "session-token", "requires_2fa": false }
// Response 200 (2FA required)
{ "partial_token": "temp-token", "requires_2fa": true }
```

---

## Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/users/me` | Yes | Get current user profile |
| PATCH | `/api/users/me` | Yes | Update own profile (username, avatar) |
| PUT | `/api/users/me/password` | Yes | Change password |
| POST | `/api/users/me/totp/enable` | Yes | Start 2FA setup, returns QR URI + backup codes |
| POST | `/api/users/me/totp/confirm` | Yes | Confirm 2FA with first TOTP code |
| DELETE | `/api/users/me/totp` | Yes | Disable 2FA |
| GET | `/api/users/me/sessions` | Yes | List active sessions |
| DELETE | `/api/users/me/sessions/{id}` | Yes | Revoke a session |

---

## Channels

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/channels` | Yes | List all channels user can see |
| GET | `/api/channels/{id}/messages` | Yes | Paginated message history |
| GET | `/api/channels/{id}/pins` | Yes | Get pinned messages |
| POST | `/api/channels/{id}/pins/{msg_id}` | Yes (mod) | Pin a message |
| DELETE | `/api/channels/{id}/pins/{msg_id}` | Yes (mod) | Unpin a message |

### GET /api/channels/{id}/messages
Query params: `before` (message ID), `limit` (1-100, default 50)
```json
// Response 200
{
  "messages": [
    {
      "id": 1042,
      "channel_id": 5,
      "user": { "id": 1, "username": "alex", "avatar": "uuid.png" },
      "content": "Hello!",
      "reply_to": null,
      "attachments": [],
      "reactions": [{ "emoji": "👍", "count": 2, "me": true }],
      "pinned": false,
      "edited_at": null,
      "deleted": false,
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ],
  "has_more": true
}
```

---

## File Uploads

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/uploads` | Yes | Upload a file (multipart) |
| GET | `/api/files/{uuid}` | Yes | Download a file |

### POST /api/uploads
Multipart form data. Field: `file`. Max size from server config (default 25MB).

```json
// Response 201
{ "id": "upload-uuid", "filename": "photo.jpg", "size": 204800, "mime": "image/jpeg", "url": "/api/files/upload-uuid" }
```

Server validates: magic bytes, rejects executables, strips EXIF, stores with UUID filename.

---

## Search

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/search` | Yes | Full-text search across accessible channels |

Query params: `q` (search query), `channel_id` (optional filter), `limit` (default 25)

```json
// Response 200
{
  "results": [
    {
      "message_id": 1042,
      "channel_id": 5,
      "channel_name": "general",
      "user": { "id": 1, "username": "alex" },
      "content": "...matched text...",
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ]
}
```

---

## Invites

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/invites` | Yes (admin) | List all invites |
| POST | `/api/invites` | Yes (manage_invites) | Create an invite |
| DELETE | `/api/invites/{id}` | Yes (manage_invites) | Revoke an invite |

### POST /api/invites
```json
// Request
{ "max_uses": 5, "expires_in_hours": 48 }
// Response 201
{ "id": 1, "code": "abc123def", "url": "chatserver://invite/abc123def", "max_uses": 5, "expires_at": "2026-03-16T10:30:00Z" }
```

---

## Admin Endpoints (admin panel uses these)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/stats` | Admin | Server stats (users, messages, disk, uptime) |
| GET | `/api/admin/users` | Admin | List all users with details |
| PATCH | `/api/admin/users/{id}` | Admin | Update user (role, ban/unban) |
| DELETE | `/api/admin/users/{id}/sessions` | Admin | Force logout a user |
| POST | `/api/admin/channels` | Admin | Create channel |
| PATCH | `/api/admin/channels/{id}` | Admin | Update channel |
| DELETE | `/api/admin/channels/{id}` | Admin | Delete channel |
| GET | `/api/admin/audit-log` | Admin | View audit log (paginated) |
| POST | `/api/admin/backup` | Owner | Trigger manual backup |
| GET | `/api/admin/backups` | Owner | List available backups |
| POST | `/api/admin/backups/{id}/restore` | Owner | Restore from backup |
| GET | `/api/admin/settings` | Admin | Get server settings |
| PATCH | `/api/admin/settings` | Admin | Update server settings |
| GET | `/api/admin/update-check` | Admin | Check for new server version |

---

## WebRTC / TURN Credentials

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/voice/credentials` | Yes | Get time-limited TURN credentials |

```json
// Response 200
{
  "ice_servers": [
    { "urls": "stun:server:3478" },
    { "urls": "turn:server:3478", "username": "timestamp:userid", "credential": "hmac-hash" }
  ],
  "expires_in": 86400
}
```

---

## Custom Emoji

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/emoji` | Yes | List all custom emoji |
| POST | `/api/emoji` | Yes (admin) | Upload new emoji |
| DELETE | `/api/emoji/{id}` | Yes (admin) | Delete emoji |

---

## Soundboard

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/sounds` | Yes | List all soundboard sounds |
| POST | `/api/sounds` | Yes (permission) | Upload a sound |
| DELETE | `/api/sounds/{id}` | Yes (admin) | Delete a sound |

---

## Health Check

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | None | Returns 200 if server is running |

```json
{ "status": "ok", "version": "1.0.0", "uptime": 86400 }
```

---

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `UNAUTHORIZED` | 401 | Missing or invalid session |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Too many requests (includes `retry_after`) |
| `INVALID_INPUT` | 400 | Bad request body or params |
| `CONFLICT` | 409 | e.g. username already taken |
| `TOO_LARGE` | 413 | File exceeds upload limit |
| `SERVER_ERROR` | 500 | Internal server error |
