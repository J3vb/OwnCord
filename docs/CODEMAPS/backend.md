<!-- Generated: 2026-03-20 | Files scanned: 35 | Token estimate: ~900 -->

# Backend Codemap (Go Server)

## HTTP Routes

### Auth (rate-limited)
```
POST /api/v1/auth/register  → handleRegister    [3/min]
POST /api/v1/auth/login     → handleLogin       [5/min]
POST /api/v1/auth/logout    → handleLogout      [AUTH]
GET  /api/v1/auth/me        → handleMe          [AUTH]
```

### Channels & Messages
```
GET  /api/v1/channels/             → handleListChannels   [AUTH]
GET  /api/v1/channels/{id}/messages → handleGetMessages   [AUTH, paginated]
GET  /api/v1/search?q=             → handleSearch         [AUTH, FTS5]
```

### Invites, Uploads
```
POST   /api/v1/invites/      → handleCreateInvite  [AUTH, MANAGE_INVITES]
GET    /api/v1/invites/      → handleListInvites   [AUTH, MANAGE_INVITES]
DELETE /api/v1/invites/{code} → handleRevokeInvite [AUTH, MANAGE_INVITES]
POST   /api/v1/uploads       → handleUpload       [AUTH, max 100MB]
GET    /api/v1/uploads/{id}  → handleDownload      [AUTH]
```

### WebSocket & LiveKit
```
GET  /api/v1/ws                → ServeWS()              [upgrade, in-band auth]
POST /api/v1/livekit/webhook   → LiveKit webhook        [JWT verify]
WS   /livekit/*                → reverse proxy → :7880  [mixed-content fix]
```

### Admin (/admin, IP-restricted)
```
GET  /admin/stats, /users, /channels, /audit-log, /settings, /backups
POST /admin/channels, /backup, /updates/apply
GET  /admin/logs/stream  [WebSocket log viewer]
```

## Middleware Chain
```
RequestID → Recoverer → requestLogger → SecurityHeaders → MaxBodySize(1MB)
  Per-route: AuthMiddleware, RequirePermission(bit), RateLimitMiddleware
  Admin: AdminIPRestrict(allowedCIDRs)
```

## WS Message Handlers (ws/handlers.go)

| Type | Handler | Rate | DB | Broadcast |
|------|---------|------|-----|-----------|
| chat_send | handleChatSend | 10/s | CreateMessage | channel |
| chat_edit | handleChatEdit | 10/s | EditMessage | channel |
| chat_delete | handleChatDelete | 10/s | DeleteMessage | channel |
| reaction_add/remove | handleReaction | 5/s | Add/RemoveReaction | channel |
| typing_start | handleTyping | 1/3s | — | channel (excl sender) |
| presence_update | handlePresence | 1/10s | UpdateUserStatus | all |
| voice_join | handleVoiceJoin | — | JoinVoice + GenToken | all |
| voice_leave | handleVoiceLeave | — | LeaveVoice | all |
| voice_mute/deafen | handleVoiceMute/Deafen | — | UpdateVoice* | all |
| voice_camera | handleVoiceCamera | 2/s | UpdateVoiceCamera | all |

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| main.go | 291 | Entry, init, graceful shutdown |
| api/router.go | 198 | Route mounting, Hub + LiveKit init |
| api/middleware.go | 325 | Auth, permissions, rate limit, security headers |
| ws/hub.go | 303 | Client registry, broadcast, settings cache |
| ws/handlers.go | 522 | WS message dispatcher |
| ws/voice_handlers.go | 332 | Voice join/leave/mute/camera |
| ws/livekit.go | 170 | Token generation, room management |
| ws/livekit_process.go | 189 | LiveKit binary lifecycle |
| ws/livekit_webhook.go | 178 | LiveKit event processing |
