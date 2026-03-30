<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~800 -->

# Go Server Codemap

## Source Stats
- 74 source files, ~14,528 lines (excluding tests)
- 58 test files

## REST Routes (api/)

### Auth -- /api/v1/auth
| Method | Path | Handler | Rate Limit |
|--------|------|---------|------------|
| POST | /register | handleRegister | 3/min |
| POST | /login | handleLogin | 60/min |
| POST | /verify-totp | handleVerifyTOTP | 10/min |
| POST | /logout | handleLogout | auth |
| GET | /me | handleMe | auth |
| DELETE | /account | handleDeleteAccount | 5/min |

### TOTP -- /api/v1/users/me/totp
| Method | Path | Handler | Rate Limit |
|--------|------|---------|------------|
| POST | /enable | handleEnableTOTP | 5/min |
| POST | /confirm | handleConfirmTOTP | 5/min |
| DELETE | / | handleDisableTOTP | 5/min |

### Channels -- /api/v1/channels (all auth-required)
| Method | Path | Handler |
|--------|------|---------|
| GET | / | handleListChannels |
| GET | /{id}/messages | handleGetMessages |
| GET | /{id}/pins | handleGetPins |
| POST | /{id}/pins/{msgId} | handleSetPinned(true) |
| DELETE | /{id}/pins/{msgId} | handleSetPinned(false) |
| GET | /api/v1/search | handleSearch (30/min) |

### DMs -- /api/v1/dms (auth)
| Method | Path | Handler |
|--------|------|---------|
| POST | / | handleCreateDM |
| GET | / | handleListDMs |
| DELETE | /{channelId} | handleCloseDM |

### Invites -- /api/v1/invites (auth + MANAGE_INVITES)
| Method | Path | Handler |
|--------|------|---------|
| POST | / | handleCreateInvite |
| GET | / | handleListInvites |
| DELETE | /{code} | handleRevokeInvite |

### Other Endpoints
| Method | Path | Handler | Access |
|--------|------|---------|--------|
| GET | /health, /api/v1/health | handleHealth | public |
| GET | /api/v1/info | handleInfo | public |
| GET | /api/v1/metrics | handleMetrics | admin IP |
| GET | /api/v1/diagnostics/connectivity | handleDiagnosticsConnectivity | auth |
| POST | /api/v1/uploads | MountUploadRoutes | auth |
| GET | /api/v1/files/{id} | handleServeFile | auth |
| POST | /api/v1/livekit/webhook | MountWebhookRoute | admin IP |
| GET | /api/v1/livekit/health | handleLiveKitHealth | admin IP |
| Handle | /livekit/* | NewLiveKitProxy | 30/min |
| GET | /api/v1/ws | ws.ServeWS | WS upgrade |

## Middleware Chain
`RequestID -> Recoverer -> requestLogger -> SecurityHeaders -> MaxBodySize(1MiB) -> [per-route: Auth, RateLimit, AdminIP]`

## WS Message Types (ws/message_types.go)
**Client -> Server (17):** auth, chat_send, chat_edit, chat_delete, reaction_add, reaction_remove, typing_start, channel_focus, presence_update, voice_join, voice_leave, voice_mute, voice_deafen, voice_camera, voice_screenshare, voice_token_refresh, ping

**Server -> Client (27):** auth_ok, auth_error, ready, chat_message, chat_send_ok, chat_edited, chat_deleted, reaction_update, typing, presence, channel_create, channel_update, channel_delete, voice_state, voice_config, voice_token, voice_speakers, voice_leave, member_join, member_leave, member_update, member_ban, server_restart, error, pong, dm_channel_open, dm_channel_close

## Key Source Files
| File | Lines | Purpose |
|------|-------|---------|
| api/router.go | 312 | chi router, middleware stack, Hub/LiveKit init |
| api/auth_handler.go | 829 | register, login, 2FA, delete account |
| api/channel_handler.go | 576 | messages, pins, search |
| api/middleware.go | 348 | auth, rate limit, CORS, security headers |
| api/dm_handler.go | 225 | DM CRUD with real-time close broadcast |
| api/invite_handler.go | 173 | invite management |
| api/upload_handler.go | 195 | file upload/serve with MIME validation |
| api/livekit_proxy.go | 198 | reverse proxy for LiveKit signaling |
| ws/hub.go | 499 | client registry, broadcast, heartbeat sweep |
| ws/handlers.go | 185 | message dispatch switch |
| ws/handlers_chat.go | 355 | chat_send, chat_edit, chat_delete |
| ws/handlers_presence.go | 139 | presence_update, channel_focus |
| ws/handlers_reaction.go | 103 | reaction_add, reaction_remove |
| ws/serve.go | 385 | WS upgrade, in-band auth, ready, reconnect replay |
| ws/voice_join.go | 235 | LiveKit token generation, voice state |
| ws/voice_controls.go | 179 | mute, deafen, camera, screenshare |
| ws/voice_leave.go | 87 | voice disconnect cleanup |
| ws/livekit.go | 202 | LiveKit SDK wrapper |
| ws/livekit_process.go | 309 | companion process lifecycle |
| ws/livekit_webhook.go | 195 | participant_joined/left events |
| ws/ringbuffer.go | 78 | 1000-event replay buffer |
| ws/messages.go | 480 | all payload struct definitions |
| config/config.go | 296 | TOML config with env overrides |
| main.go | 336 | startup, TLS, graceful shutdown |

## DB Layer (db/)
| File | Lines | Tables |
|------|-------|--------|
| auth_queries.go | 434 | users, sessions, login_attempts |
| message_queries.go | 522 | messages, messages_fts, reactions |
| channel_queries.go | 243 | channels, channel_overrides, read_states |
| dm_queries.go | 286 | dm_participants, dm_open_state |
| voice_queries.go | 278 | voice_states |
| admin_queries.go | 374 | audit_log, settings, roles |
| attachment_queries.go | 156 | attachments |
| models.go | 198 | all Go struct definitions |
| migrate.go | 203 | 8 migrations, schema_versions tracking |
| errors.go | 33 | sentinel errors: ErrNotFound, ErrDuplicate, ErrForbidden |
