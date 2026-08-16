# Graph Report - OwnCord  (2026-08-16)

## Corpus Check
- 1080 files · ~1,387,686 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 11334 nodes · 32669 edges · 503 communities (427 shown, 76 thin omitted)
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 4683 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c0495f10`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- dispatcher.ts
- createElement
- testing.T
- livekitSession.ts
- messages.store.ts
- seedChannel
- context.Context
- buildChannelRouter
- content-parser.ts
- media.ts
- telemetry.go
- waitRegistered
- types.ts
- NewAdminAPI
- Fixed
- messages_test.go
- main.ts
- net/http.HandlerFunc
- NewTestClient
- newHandlerHub
- livekitE2EE.ts
- drainChanTimeout
- buildDMRouter
- tofu.rs
- newAuthTestDB
- newMigratedTestDB
- EventPersister
- Config
- secret_store.rs
- Hub
- database/sql.Result
- newUploadTestDB
- SidebarArea.ts
- writeJSON
- audit_writer_test.go
- HashToken
- syntax-highlight.ts
- ChannelSidebar.ts
- plugin/registry_test.go
- Key
- Registry
- livekit_test.go
- NewChecker
- net/http.Handler
- userStatus.ts
- DB
- testing.F
- Result
- livekit_proxy.rs
- native/helpers.ts
- NewRouter
- profileCreateToken
- totp_test.go
- MemberList.ts
- openMigratedMemory
- newServeHub
- 3. Security
- permissions_test.go
- mappers.go
- postJSONWithToken
- http_proxy.rs
- newVoiceTestDB
- messages.go
- time.Time
- ProfileManager
- architecture/README.md
- devDependencies
- itoa
- helpers_test.go
- .handleReaction
- Security Policy
- Role
- channels.sql.go
- Deployment Guide
- livekit_proxy_test.go
- newEmojiService
- ws_proxy.rs
- bughunt.js
- openAdminTestDB
- DB
- Tables
- newMentionFixture
- Channel
- newWAFMiddleware
- seedUser
- storage_test.go
- Migrate
- Hub
- chdirTemp
- DB
- updater_test.go
- newTestMessageService
- newTestUpdater
- Hub
- compilerOptions
- NewEventRingBuffer
- VoiceDeps
- emoji_handler_test.go
- handleCreateEmoji
- doRequest
- AudioPipeline
- LoadOrGenerate
- Auth Endpoints
- MigrateFS
- newOverrideFixture
- save.go
- REST API Reference
- NewRegistry
- voice_moderation_test.go
- ptt.rs
- OwnCord Audit — Documentation Accuracy & UI/UX Test Coverage (2026-08-04)
- scripts
- ResolveTokenHash
- Load
- handleVoiceE2EEOfferV2
- commands.rs
- newEmitTestHub
- Plan: Remediate security-hardening review regressions
- verify.go
- newRoleCRUDService
- PermissionService
- EnsureLiveKitBinary
- clientip_test.go
- newDeafenRaceDB
- Hub
- gif_handler_test.go
- navigateToMainPage
- messages.sql.go
- Channel Endpoints
- newSignedTestUpdater
- host_http_test.go
- Topic
- DB
- users
- Client
- channel-controller.test.ts
- Queries
- Queries
- Queries
- middleware_and_spawn_test.go
- password_test.go
- newPurgeService
- handleVoiceTokenRefreshV2
- pubsub_test.go
- newChannelTestAPI
- handleLogStream
- handleSetup
- log/slog.Value
- Updater
- Credential storage
- dependencies
- VoiceWidget.ts
- Config Key Reference
- newTestPermService
- markdown.ts
- VideoGrid.ts
- Manifest
- rate-limiter.ts
- e2e/helpers.ts
- main.test.ts
- testing.M
- newMockDB
- OwnCord
- bughunt-fix.js
- buildTauriMockScript
- OwnCord Introspection MCP Server
- Bug-detection improvements — design
- New
- eslint-rules.js
- DB
- OwnCord — Security Review
- Plan: Slash command dispatcher in WS
- net/http.Request
- ChannelTopic
- UserService
- Blocked — fix attempted, revert-proof failed
- handlers_backup.go
- logger.ts
- fallback_crypto.rs
- Direct Messages
- WebSocket Protocol Reference
- command.go
- NewRingBuffer
- ws-load.js
- newDMFixture
- handler
- tauri-client/package.json
- screen-share-tracks.test.ts
- LoginFormApi
- social.parity.spec.ts
- fakeDirInfo
- Role Management
- User Profile & Sessions
- F3 — Voice E2EE identity keys + TOFU (the remaining work)
- run
- newWazeroTestRegistry
- newUserSvc
- plugins_handler_test.go
- badDirFile
- Contributing
- User
- mcp-introspect/package.json
- v1.2.0-alpha.1 — Discord feature parity
- Task Observer — Continuous Skill Discovery & Improvement
- scanPluginDirectory
- AuditWriter
- 1. Channel sidebar
- Voice, Video & E2EE — target UX
- NewWAFMiddlewareCRS
- LiveKitProcess
- migrate.go
- sync.Mutex
- Messaging — target UX
- .handleWebhookParticipantLeft
- handleChannelFocusV2
- handlers_channel_perms_test.go
- knip.json
- RNNoiseProcessor
- Name
- finish
- TestHarness
- Connection & Authentication — target UX
- Settings & Admin — target UX
- buildClientUpdateRouter
- Save
- New
- event.go
- NewTopicRateLimiter
- Skill Authoring — taxonomy, licensing, confidentiality, editing rules
- .oxlintrc.json
- attachment_queries_test.go
- e2e/dm-system.spec.ts
- Queries
- emoji.sql.go
- OwnCord — Architectural Audit & Spec-Conformance Review
- LiveKit Setup Guide
- Voice Signaling
- Quick Start Guide
- readPump
- mockTauriFullSessionWithVoice
- index.mjs
- countingReadStateStore
- bughunt.harness.mjs
- voice-audio-tab.test.ts
- reactions.sql.go
- Channel Permission Overrides
- Server Stats & User Administration
- .UpdateUserProfile
- groupDMFixture
- handleChatCommandV2
- slashFS
- Running the bughunt pipeline
- MainPage.ts
- reconnectAfterCertAccept
- FenwickTree
- emoji-voicemod.parity.spec.ts
- voice-e2ee-verify.spec.ts
- include
- Queries
- Custom Emoji
- OwnCord — Test-Coverage Audit
- OriginAcceptOptions
- EventRingBuffer
- FuzzImageDimensions
- newTokenTestDB
- scripts
- bughunt-fix.harness.mjs
- router.ts
- E2E Test Status — 2026-08-05
- render-ledger.mjs
- newBlockService
- TestMigrate_UpgradeFromMigration019PreservesData
- Queries
- TestChannelVisibility_RESTWSAgreement
- fuzzOpenMigratedMemory
- Finish the V2 Dispatch Migration (backlog item 11) — Design
- Port Forwarding Guide
- Chat Messages
- hello/main.go
- OwnCord — Comprehensive Project Audit
- RingBuffer
- Client HTTP TOFU Proxy (D5) — Design
- create_tray
- API Tokens
- Backups
- Plugin Administration
- Invite Endpoints
- 2. Code Quality
- Infrastructure roadmap — design
- Member Updates
- genprotocol/main.go
- Hub
- .finishVoiceLeave
- ChatSendCmd
- Environments, Activation Setup, and Handoff-Doc Mode
- handlePingV2
- capabilities-scope.test.ts
- ParseLevel
- GET /admin/api/updates
- Channel-Visibility Unification (backlog item 3) — Design
- sqlc Adoption (D2) — Progress & Plan
- Authentication Flow
- Voice Moderation
- bug_report.md
- Pull Request
- prettier
- openFileDB
- hello plugin
- TestAdminAPI_PatchChannel_ArchiveCleansVoice
- TestAdminDeleteChannel_UnlinksAttachmentsForReclaim
- 4. Dependencies & Supply Chain
- protocol_contract_test.go
- ChatCommandCmd
- ci-check
- Comprehensive Review (scheduled or fallback)
- VoiceWidgetOptions
- countingLimiter
- cert-tofu.spec.ts
- updater.spec.ts
- errDMParticipantsStore
- tsconfig.build.json
- User Blocks
- PATCH /admin/api/settings
- GET /api/v1/gif/search
- First-Run Setup
- LiveKit Endpoints
- README.md
- LiveKitProcess
- 5. Test Coverage & Quality
- ChatEditCmd
- VoiceE2EEOfferCmd
- VoiceModDeafenCmd
- VoiceModMuteCmd
- GET /api/v1/client-update/{target}/{current_version}
- OwnCord Architecture Blueprints
- Voice End-to-End Encryption
- feature_request.md
- setupDiagnosticsRouter
- RunningInContainer
- ChatDeleteCmd
- PresenceUpdateCmd
- ReactionAddCmd
- ReactionRemoveCmd
- stubExcludeSenderEvent
- stubSequencedDMEvent
- stubVoiceChannelEvent
- stubVoiceChannelGuardedEvent
- VoiceE2EEAnnounceCmd
- VoiceModMoveCmd
- OwnCord
- OwnCord Client (Tauri v2)
- VadProcessor
- log_level_from_env
- TestHandleVoiceCameraV2_RefusedWhenScreenshareSlotFull
- File Upload and Serving
- Server Logs (SSE)
- DM Calls
- Channel Updates
- Heartbeat and Connection Liveness
- Message Type Reference Table
- Direct Messages
- OwnCord Server (Go)
- 1. Architecture
- CallDeclineCmd
- CallRingCmd
- ChannelFocusCmd
- MarkReadCmd
- stubChannelEvent
- stubUserTargetedEvent
- TypingStartCmd
- VoiceCameraCmd
- VoiceDeafenCmd
- VoiceJoinCmd
- VoiceMuteCmd
- VoiceScreenshareCmd
- errDMChannelIDsStore
- db-change
- enable_media_capture
- admin-panel.spec.ts
- start-server.sh
- Channel Focus and Read State
- Error Handling
- Presence
- Transport Layer
- pre-commit
- pre-push
- 6. CI/CD & DevEx
- 7. Observability
- 015_plugins.sql
- tryLoadPluginTOML
- tryLoadPluginTOML
- protocol-change/SKILL.md
- strip-appimage-bundled-libs.sh
- jitsi-rnnoise.d.ts
- stryker.config.mjs
- Querier
- .serialize
- 003_audit_log.sql
- 011_rate_lockouts.sql
- 014_events_table.sql
- chaos-test.sh
- voice-test.sh
- RateLimiter
- github.com/owncord/server
- owncord-client
- attachments
- attachments
- emoji
- .RoundTrip
- docker-smoke.sh
- TestRegisterNow_ReplacementNeverLosesAConcurrentGlobalBroadcast
- prettier
- @vitest/browser
- @vitest/coverage-v8

## God Nodes (most connected - your core abstractions)
1. `waitRegistered()` - 287 edges
2. `DB` - 279 edges
3. `NewTestClientWithUser()` - 268 edges
4. `NewAdminAPI()` - 232 edges
5. `openAdminTestDB()` - 215 edges
6. `doRequest()` - 213 edges
7. `createElement()` - 208 edges
8. `newTestModService()` - 194 edges
9. `newTestRoleService()` - 192 edges
10. `openMigratedMemory()` - 180 edges

## Surprising Connections (you probably didn't know these)
- `buildTotpSection()` --indirect_call--> `render()`  [INFERRED]
  Client/tauri-client/src/components/settings/AccountTab.ts → .superpowers/render-ledger.mjs
- `SidebarAreaResult` --references--> `MountableComponent`  [EXTRACTED]
  Client/tauri-client/src/pages/main-page/SidebarArea.ts → Client/tauri-client/src/lib/safe-render.ts
- `SidebarMemberSectionResult` --references--> `MountableComponent`  [EXTRACTED]
  Client/tauri-client/src/pages/main-page/SidebarMemberSection.ts → Client/tauri-client/src/lib/safe-render.ts
- `E2EEDeps` --references--> `WsClient`  [EXTRACTED]
  Client/tauri-client/src/lib/livekitE2EE.ts → Client/tauri-client/src/lib/ws.ts
- `ModerationGates` --calls--> `roleHasPermission()`  [EXTRACTED]
  Client/tauri-client/src/components/MemberList.ts → Client/tauri-client/src/lib/permissions.ts

## Import Cycles
- 3-file cycle: `Client/tauri-client/src/components/message-list/attachments.ts -> Client/tauri-client/src/components/message-list/media.ts -> Client/tauri-client/src/components/message-list/content-parser.ts -> Client/tauri-client/src/components/message-list/attachments.ts`
- 3-file cycle: `Client/tauri-client/src/components/message-list/attachments.ts -> Client/tauri-client/src/components/message-list/media.ts -> Client/tauri-client/src/components/message-list/embeds.ts -> Client/tauri-client/src/components/message-list/attachments.ts`
- 3-file cycle: `Client/tauri-client/src/lib/audioElements.ts -> Client/tauri-client/src/lib/livekitSession.ts -> Client/tauri-client/src/lib/roomEventHandlers.ts -> Client/tauri-client/src/lib/audioElements.ts`
- 4-file cycle: `Client/tauri-client/src/components/message-list/attachments.ts -> Client/tauri-client/src/components/message-list/media.ts -> Client/tauri-client/src/components/message-list/content-parser.ts -> Client/tauri-client/src/components/message-list/custom-emoji.ts -> Client/tauri-client/src/components/message-list/attachments.ts`

## Communities (503 total, 76 thin omitted)

### Community 0 - "dispatcher.ts"
Cohesion: 0.01
Nodes (213): invalidateReactionUsers(), DispatcherCleanup, enforceModeratorAudioState(), livekitSession(), log, mapDmPayload(), mapDmUser(), wireConnectionStatus() (+205 more)

### Community 1 - "createElement"
Cohesion: 0.02
Nodes (246): buildRow(), CertFirstUseModalOptions, CertMismatchModalOptions, createCertFirstUseModal(), createCertMismatchModal(), createIdentityMismatchModal(), IdentityMismatchModalOptions, createChannelSidebar() (+238 more)

### Community 2 - "testing.T"
Cohesion: 0.02
Nodes (253): testing.T, adminPanelSource(), TestAdminPanelEmojiSectionIsWired(), TestAdminPanelEmojiUsesTheMemberAPI(), TestLoginRateLimit_Value(), TestRateLimiterCleanupHorizon_CoversMaxSlowMode(), TestSlashFS_GlobNormalizes(), TestSlashFS_ResolvesBackslashPath() (+245 more)

### Community 3 - "livekitSession.ts"
Cohesion: 0.02
Nodes (120): VoiceModerationCallbacks, buildKeybindsTab(), buildVoiceAudioTabInner(), CameraInvalidationRegistrar, CameraRegistrar, createVoiceAudioTab(), MicRegistrar, VoiceAudioTabHandle (+112 more)

### Community 4 - "messages.store.ts"
Cohesion: 0.02
Nodes (107): baseMime(), isAudioMime(), isVideoMime(), isSameDay(), shouldGroup(), buildVirtualItems(), createMessageList(), estimateItemHeight() (+99 more)

### Community 5 - "seedChannel"
Cohesion: 0.06
Nodes (68): purgeSeed(), seedAroundMessages(), seedChannel(), TestAddReaction_Success(), TestAddReaction_UniqueConstraint(), TestCreateMessage_ContentPreserved(), TestCreateMessage_ReturnsID(), TestCreateMessage_WithReplyTo() (+60 more)

### Community 6 - "context.Context"
Cohesion: 0.02
Nodes (40): ChannelUpdate, ServerStats, CountRoleMembersRow, CreateRoleParams, GetUserWithRoleRow, InstallPluginParams, PluginKVDeleteParams, PluginKVGetParams (+32 more)

### Community 7 - "buildChannelRouter"
Cohesion: 0.06
Nodes (146): aroundResponse, offlineBroadcaster, purgeBroadcast, purgeResponseBody, reactionUsersResponse, recordingPurgeBroadcaster, aroundPath(), decodeAround() (+138 more)

### Community 8 - "content-parser.ts"
Cohesion: 0.02
Nodes (134): buildPreview(), byLabel(), createEmojiAutocomplete(), EmojiAutocompleteComponent, EmojiAutocompleteOptions, EmojiSuggestion, filterEmojiSuggestions(), MAX_EMOJI_SUGGESTIONS (+126 more)

### Community 9 - "media.ts"
Cohesion: 0.04
Nodes (65): CODE_BLOCK_REGEX, INLINE_CODE_REGEX, MASKED_LINK_REGEX, URL_REGEX, clearEmbedCaches(), EMPTY_OG, isPrivateHost(), log (+57 more)

### Community 10 - "telemetry.go"
Cohesion: 0.03
Nodes (72): go.opentelemetry.io/otel/attribute.KeyValue, go.opentelemetry.io/otel/metric.Float64Gauge, go.opentelemetry.io/otel/metric.Float64Histogram, go.opentelemetry.io/otel/metric.Int64Counter, go.opentelemetry.io/otel/metric.Meter, go.opentelemetry.io/otel/trace.Span, go.opentelemetry.io/otel/trace.Tracer, Invite (+64 more)

### Community 11 - "waitRegistered"
Cohesion: 0.06
Nodes (135): TestBuildReady_IncludesCanSend(), TestBuildReady_CarriesChannelFeatureFlags(), TestHandleVoiceCamera_BadPayload(), TestHandleVoiceCamera_NotInVoice2(), TestHandleVoiceDeafen_BadPayload(), TestHandleVoiceDeafen_NotInVoice2(), TestHandleVoiceMute_BadPayload(), TestHandleVoiceMute_NotInVoice2() (+127 more)

### Community 12 - "types.ts"
Cohesion: 0.02
Nodes (115): attachReactionTooltip(), buildReactionTooltip(), cache, cacheKey(), chipSetFor(), formatReactorNames(), getCachedReactionUsers(), hide() (+107 more)

### Community 13 - "NewAdminAPI"
Cohesion: 0.08
Nodes (108): TestAdminAPI_AuditLog_InvalidLimitParam(), TestAdminAPI_AuditLog_Pagination(), TestAdminAPI_CheckUpdate_NilUpdater(), TestAdminAPI_CreateChannel_DefaultsTypeToText(), TestAdminAPI_CreateChannel_InvalidBody(), TestAdminAPI_DeleteChannel_InvalidID(), TestAdminAPI_ForceLogout_InvalidID(), TestAdminAPI_ListUsers_CapLargeLimit() (+100 more)

### Community 14 - "Fixed"
Cohesion: 0.01
Nodes (140): Fixed, OC-0002 — high — A dead E2EE worker is invisible; the Secured badge cannot detect it, OC-0004 — medium — Key-holder promotion silently no-ops when the client's own voice_state has not arrived, OC-0005 — medium — Rotation offers exceed the server rate limit in large channels, permanently starving the same peers, OC-0006 — medium — Both rotation paths call keyProvider.setKey with no session-generation guard, OC-0007 — medium — Reconnect reaches the Secured state without confirming the room key is current, OC-0008 — medium — restoreLocalVoiceState has no internal supersession guard, OC-0009 — low — attemptAutoReconnect's tail has no supersession checkpoints after connected (+132 more)

### Community 15 - "messages_test.go"
Cohesion: 0.06
Nodes (56): buildAuthError(), buildChannelCreate(), buildChannelUpdate(), buildChatBulkDeleted(), buildChatDeleted(), buildChatEdited(), buildMemberBan(), buildMemberJoin() (+48 more)

### Community 16 - "main.ts"
Cohesion: 0.02
Nodes (95): createUserUpdateCredentialSaver(), deleteCredential(), getInvoke(), loadCredential(), log, saveCredential(), SavedCredential, formatMessageLink() (+87 more)

### Community 17 - "net/http.HandlerFunc"
Cohesion: 0.09
Nodes (65): createChannelRequest, createTokenRequest, createTokenResponse, errorResponse, HubBroadcaster, memberUnbanBroadcaster, patchUserRequest, PermissionInvalidator (+57 more)

### Community 18 - "NewTestClient"
Cohesion: 0.05
Nodes (96): TestEventDeliveryHasNoGuestPath(), NewEventSink(), TestEmitSequencedDM_UsesNormalQueueToPreserveSeqOrder(), TestEmitUserTargeted_KeepsHighPriorityFastLane(), NewTestClient(), NewTestClientWithChannel(), TestChatCommand_MalformedPayload_ReturnsBadRequest(), TestChatCommand_NoRegistry_ReturnsError() (+88 more)

### Community 19 - "newHandlerHub"
Cohesion: 0.06
Nodes (137): channelFocusMsg(), denyReadOnChannel(), TestChannelFocus_AdminBypassesDeny(), TestChannelFocus_AllowedByDefault(), TestChannelFocus_DeniedByOverride(), TestChatSend_DeniedWithoutSendMessages(), callMsg(), seedGroupDM() (+129 more)

### Community 20 - "livekitE2EE.ts"
Cohesion: 0.06
Nodes (54): closeIdentityModal(), openIdentityMismatchModal(), ANNOUNCE_DOMAIN, base64ToUint8(), buildAnnounceMessage(), computeKeyFingerprint(), deriveWrappingKey(), exportIdentityKeyPair() (+46 more)

### Community 21 - "drainChanTimeout"
Cohesion: 0.10
Nodes (87): drainChanTimeout(), TestWebhook_ParticipantLeft_SurvivesCancelledRequestContext(), captureLogs(), participantIdentityFor(), roomNameFor(), TestWebhook_ParticipantJoined_MalformedInput(), TestWebhook_ParticipantJoined_NilFieldsIgnored(), TestWebhook_ParticipantJoined_RogueParticipantFlagged() (+79 more)

### Community 22 - "buildDMRouter"
Cohesion: 0.08
Nodes (74): cancelAfterArm, cancelOnLookupStore, evictCall, mockBroadcaster, mockBroadcastMsg, watermarkVoiceBroadcaster, decodeBlockedIDs(), dmPut() (+66 more)

### Community 23 - "tofu.rs"
Cohesion: 0.06
Nodes (54): CapturedFingerprint, CertificateDer, CaptureVerifier, cert_store_key(), decide(), default_verify_schemes(), evaluate(), extract_host() (+46 more)

### Community 24 - "newAuthTestDB"
Cohesion: 0.07
Nodes (98): recordingAuthBroadcaster, TestDeleteAccount_BroadcastsMemberBan(), TestDeleteAccount_NoBroadcasterOmitted(), buildAuthRouter(), buildAuthRouterWithProxies(), contains(), containsStr(), deleteJSONWithToken() (+90 more)

### Community 25 - "newMigratedTestDB"
Cohesion: 0.06
Nodes (71): TestBlockUser_And_IsBlocked(), TestBlockUser_Idempotent(), TestBlockUser_SelfBlockIsSilentlyDropped(), TestIsEitherBlocked(), TestListBlockedUsers(), TestUnblockUser(), TestUnblockUser_NotBlockedIsNoOp(), seedEmojiUploader() (+63 more)

### Community 26 - "EventPersister"
Cohesion: 0.05
Nodes (28): PluginRow, rowScanner, rowsScanner, sync/atomic.Bool, sync/atomic.Uint64, DB, parseSQLiteTime(), scanEventRows() (+20 more)

### Community 27 - "Config"
Cohesion: 0.11
Nodes (24): BackupConfig, DatabaseConfig, EventPersistenceConfig, LoggingConfig, PluginsConfig, SecurityConfig, ServerConfig, UploadConfig (+16 more)

### Community 28 - "secret_store.rs"
Cohesion: 0.07
Nodes (61): credential_lock_serializes_overlapping_commands(), CredentialData, CredentialStoreProbe, delete_credential(), delete_identity_key(), identity_account(), load_credential(), load_identity_key() (+53 more)

### Community 30 - "database/sql.Result"
Cohesion: 0.04
Nodes (30): ApplyVoiceServerDeafenParams, ApplyVoiceServerMuteParams, ClearVoiceServerDeafenParams, ClearVoiceServerMuteParams, CreateAPITokenParams, DeleteOtherSessionsParams, DeleteSessionByIDParams, EnableCameraIfUnderLimitParams (+22 more)

### Community 31 - "newUploadTestDB"
Cohesion: 0.11
Nodes (71): io.Closer, io.Seeker, buildAvatarRouter(), doAvatarUpload(), TestUploadAvatar_IsReadableByOtherUsersWhileInUse(), TestUploadAvatar_NotMountedWithoutStorage(), TestUploadAvatar_RejectsNonImageAndOversizedDimensions(), TestUploadAvatar_RequiresAuthAndAFile() (+63 more)

### Community 32 - "SidebarArea.ts"
Cohesion: 0.04
Nodes (82): DmConversation, QuickSwitcherOptions, QuickSwitchProfile, ToastContainer, adminPanelUrl(), openAdminPanel(), ApiClient, navigateToChannel() (+74 more)

### Community 33 - "writeJSON"
Cohesion: 0.09
Nodes (64): changePasswordRequest, createDMRequest, createGroupDMRequest, createInviteRequest, dmVisibilityMarker, dmVoiceEvictor, inviteResponse, ProfileBroadcaster (+56 more)

### Community 34 - "audit_writer_test.go"
Cohesion: 0.19
Nodes (15): fakeAuditor, captureLogs(), TestWriteAudit_LogsFailureButDoesNotPropagate(), TestWriteAudit_SuccessLogsNothing(), NewAuditWriter(), TestAuditWriter_BatchFlush(), TestAuditWriter_ConcurrentEnqueue(), TestAuditWriter_DrainOnStop() (+7 more)

### Community 35 - "HashToken"
Cohesion: 0.11
Nodes (49): TestNewRouter_DeleteAccount_BroadcastsMemberBanOverWS(), TestNewRouter_LiveKitProcessStartFailure_VoiceJoinFailsClosed(), voiceJoinWSMsg(), GenerateToken(), HashToken(), TestGenerateToken_HexCharacters(), TestGenerateToken_Length(), TestGenerateToken_MultiDeviceUniqueness() (+41 more)

### Community 36 - "syntax-highlight.ts"
Cohesion: 0.12
Nodes (14): ALIASES, BACKTICK_STRING, C_BLOCK_COMMENT, CodeToken, DQ_STRING, HASH_COMMENT, JS_LIKE, LANGS (+6 more)

### Community 37 - "ChannelSidebar.ts"
Cohesion: 0.05
Nodes (78): attachChannelContextMenu(), CHANNEL_MUTE_CHANGED, attachDragHandlers(), DragState, ensureGlobalDragListeners(), listenerOwners, releaseOwner(), retargetDetachedDrag() (+70 more)

### Community 38 - "plugin/registry_test.go"
Cohesion: 0.19
Nodes (27): buildZip(), Registry, newRegistryWithDir(), simpleManifest(), TestRegistry_Activate_AfterClose(), TestRegistry_Activate_WithoutRuntime(), TestRegistry_DisablePlugin_ClearsFlagAndCommands(), TestRegistry_DisablePlugin_UnknownIDIsNoOp() (+19 more)

### Community 39 - "Key"
Cohesion: 0.07
Nodes (47): AuthBroadcaster, authSuccessResponse, deleteAccountRequest, loginRequest, passwordConfirmationRequest, registerRequest, totpConfirmationRequest, totpEnableResponse (+39 more)

### Community 40 - "Registry"
Cohesion: 0.04
Nodes (27): github.com/tetratelabs/wazero/api.Memory, github.com/tetratelabs/wazero/api.Module, Broadcaster, bytesReaderAt, CommandResult, Instance, UITabBinding, Registry (+19 more)

### Community 41 - "livekit_test.go"
Cohesion: 0.03
Nodes (102): google.golang.org/protobuf/proto.Message, TestBuildDMChannelOpen_NilAvatar(), TestBuildDMChannelOpen_NilRecipient(), TestBuildDMChannelOpen_ValidRecipient(), TestQualityBitrate_EmptyFallsBackToMedium(), TestQualityBitrate_KnownPresets(), TestQualityBitrate_UnknownFallsBackToMedium(), TestBuildChatSendOK_ValidJSON() (+94 more)

### Community 42 - "NewChecker"
Cohesion: 0.19
Nodes (47): NewChecker(), TestHandleChannelFocus_SkipsNoOpReadStateWrite(), NewChannelService(), Store, TestHandlePresenceUpdate_BareStatusReadFailureAbortsBeforeCommit(), TestHandlePresenceUpdate_CustomStatusWriteFailureKeepsStoredText(), TestHandlePresenceUpdate_CustomStatusWriteFailureSwallowedAfterStatusCommit(), TestHandleChannelFocus_DMExemptFromArchiveGate() (+39 more)

### Community 43 - "net/http.Handler"
Cohesion: 0.07
Nodes (61): contextKey, errorResponse, go.opentelemetry.io/otel/sdk/metric.MeterProvider, go.opentelemetry.io/otel/sdk/trace.TracerProvider, net/http.Handler, TestBodyCapExemptions_RouteEnvelopesReachable(), SecurityHeaders(), TestRateLimitMiddlewareWithPrefix_SeparatesClientUpdateBucket() (+53 more)

### Community 44 - "userStatus.ts"
Cohesion: 0.10
Nodes (23): UserBarOptions, ACTIVITY_EVENTS, ACTIVITY_THROTTLE_MS, AUTO_IDLE_DELAY_MS, AutoIdleController, nextAutoStatus(), startAutoIdle(), createPresenceSender() (+15 more)

### Community 45 - "DB"
Cohesion: 0.06
Nodes (22): ChannelUnread, MessageWithUser, ReactionCount, ReactionInfo, UserPublic, ReactionUser, Message, DB (+14 more)

### Community 46 - "testing.F"
Cohesion: 0.12
Nodes (11): testing.F, FuzzValidateAvatarURL(), FuzzValidateDisplayName(), FuzzSanitizeUploadFilename(), FuzzValidateUsername(), FuzzEffectiveChannelPerms(), FuzzEffectivePerms(), FuzzValidateShortcode() (+3 more)

### Community 47 - "Result"
Cohesion: 0.12
Nodes (41): requirePerm(), Event, BuildCallSignalForTest(), handleCallDeclineV2(), handleCallRingV2(), dmEventOrFallback(), TestDMEventOrFallback(), Event (+33 more)

### Community 48 - "livekit_proxy.rs"
Cohesion: 0.06
Nodes (44): adds_no_headers_when_none_are_present(), can_reuse_proxy(), clear_if_port_matches_clears_only_a_matching_entry(), connect_tls(), does_not_rewrite_headers_that_merely_contain_host_or_origin(), handle_connection(), LiveKitProxyState, matches_header_names_case_insensitively() (+36 more)

### Community 49 - "native/helpers.ts"
Cohesion: 0.09
Nodes (35): CDP_PORT, cleanupUserDataDir(), createUserDataDir(), __dirname, __filename, NativeFixtures, acquirePersistentPage(), CDP_PORT (+27 more)

### Community 50 - "NewRouter"
Cohesion: 0.06
Nodes (44): clientDiag, diagnosticsResponse, EventPersisterMetrics, healthDeps, healthResponse, infoResponse, livekitHealthResponse, MetricsSources (+36 more)

### Community 51 - "profileCreateToken"
Cohesion: 0.11
Nodes (48): identityKeyFailStore, net/http/httptest.ResponseRecorder, getWithToken(), TestUpdateProfile_BroadcastCarriesEveryProfileField(), TestUpdateProfile_RejectsBadDisplayName(), TestUpdateProfile_SetsDisplayNameAndAbout(), TestChangePassword_MalformedBody(), TestChangePassword_MissingNewPassword() (+40 more)

### Community 52 - "totp_test.go"
Cohesion: 0.08
Nodes (37): PartialAuthChallenge, pendingTOTPEnrollment, BuildTOTPURI(), generateOpaqueToken(), PartialAuthStore, PendingTOTPStore, UsedTOTPCodeStore, NewPartialAuthStore() (+29 more)

### Community 53 - "MemberList.ts"
Cohesion: 0.05
Nodes (48): appendBanFlow(), BAN_DURATIONS, ChannelContextMenuOptions, ContextMenuResult, createChannelContextMenu(), createMemberContextMenu(), createMenuItem(), createSeparator() (+40 more)

### Community 54 - "openMigratedMemory"
Cohesion: 0.06
Nodes (62): openMigratedMemory(), TestCreateChannel_EmptyCategory(), TestCreateChannel_ReturnsID(), TestCreateChannel_UniqueIDs(), TestDeleteChannel_NonExistent(), TestDeleteChannel_RemovesChannel(), TestDeleteChannelOverride(), TestGetChannel_Found() (+54 more)

### Community 55 - "newServeHub"
Cohesion: 0.11
Nodes (40): TestBuildReady_IncludesDMVoiceStates(), TestBuildReady_PropagatesDMChannelsError(), TestBuildReady_PropagatesListMembersError(), TestBuildReady_PropagatesUnreadCountsError(), TestBuildReady_IncludesOwnVoiceStateAfterDMClosed(), newServeHub(), ownerRole(), seedServeUser() (+32 more)

### Community 56 - "3. Security"
Cohesion: 0.20
Nodes (10): 3. Security, Authentication & Authorization, Input Validation, Observations (not blocking), Overall Posture: **GOOD** (no critical issues in core app security), Rate Limiting, Secrets & Configuration, SQL Injection (+2 more)

### Community 57 - "permissions_test.go"
Cohesion: 0.09
Nodes (39): EffectivePerms(), HasAdmin(), HasAnyPerm(), HasPerm(), HasServerPerm(), TestAdminPerimeter_Membership(), TestEffectivePerms_AllowAddsPermission(), TestEffectivePerms_AllowAndDenyTogether() (+31 more)

### Community 58 - "mappers.go"
Cohesion: 0.08
Nodes (17): Attachment, AttachmentAccess, SessionWithBanStatus, Session, DB, generateInviteCode(), Invite, Session (+9 more)

### Community 59 - "postJSONWithToken"
Cohesion: 0.18
Nodes (30): postJSONWithToken(), buildCombinedRouter(), TestCombinedRouter_ProfileAndInvites(), TestCreateInvite_MalformedJSON(), TestCreateInvite_WithExpiration(), TestListInvites_MemberForbidden(), TestRevokeInvite_AlreadyRevoked(), buildInviteRouter() (+22 more)

### Community 60 - "http_proxy.rs"
Cohesion: 0.08
Nodes (39): A, B, copy_with_deadline(), copy_with_deadline_reclaims_a_stalled_connection(), handle_connection(), HttpProxyState, ProxyEntry, remove_if_port_matches_removes_only_matching_entry() (+31 more)

### Community 61 - "newVoiceTestDB"
Cohesion: 0.14
Nodes (45): TestVoice_CountActiveCameras_SomeCameras(), TestVoice_CountActiveCameras_Zero(), TestVoice_EnableCameraIfUnderLimit_AtLimit(), TestVoice_EnableCameraIfUnderLimit_Success(), TestVoice_GetAllVoiceStates_Empty(), TestVoice_GetAllVoiceStates_MultipleChannels(), TestVoice_JoinVoiceChannelIfCapacity_AtLimit(), TestVoice_JoinVoiceChannelIfCapacity_ReplacesOwnState() (+37 more)

### Community 62 - "messages.go"
Cohesion: 0.04
Nodes (68): userUpdateSpy, encoding/json.RawMessage, parseCallChannelID(), BuildDMChannelOpenInfoForTest(), ParseChannelIDForTest(), buildChannelCreateFor(), buildChatMessage(), buildChatSendOK() (+60 more)

### Community 63 - "time.Time"
Cohesion: 0.03
Nodes (40): touchThrottle, failingLockoutStore, Attachment, AuditLog, Channel, ChannelOverride, ChannelUserOverride, DmOpenState (+32 more)

### Community 65 - "architecture/README.md"
Cohesion: 0.06
Nodes (31): Client Architecture (Tauri), D7 — Module map, Key mechanisms, Quality tooling, D5 — Entity-relationship overview, Data Model, Domain notes, How the schema is accessed (+23 more)

### Community 66 - "devDependencies"
Cohesion: 0.06
Nodes (35): devDependencies, eslint, @eslint/js, fast-check, jsdom, knip, oxlint, @playwright/test (+27 more)

### Community 67 - "itoa"
Cohesion: 0.11
Nodes (37): itoa(), TestDeleteChannelPermission_RefusesEqualOrHigherRole(), TestPutChannelPermission_ModeratorCannotEscalate(), TestPutChannelPermission_RefusesEqualOrHigherRole(), seedOverrideTarget(), TestChannelUserPermission_NonAdminForbidden(), TestDeleteChannelUserPermission_ClearsOverride(), TestPutChannelUserPermission_AdministratorCanGrantAnyBit() (+29 more)

### Community 68 - "helpers_test.go"
Cohesion: 0.09
Nodes (39): ExtractBearerToken(), IsEffectivelyBanned(), IsSessionExpired(), TestExtractBearerToken_BearerCaseInsensitive(), TestExtractBearerToken_BearerWithNoToken(), TestExtractBearerToken_EmptyHeaderValue(), TestExtractBearerToken_MissingHeader(), TestExtractBearerToken_MultipleSpaces() (+31 more)

### Community 69 - ".handleReaction"
Cohesion: 0.36
Nodes (4): ReactionUser, MessageService, validateEmoji(), ReactionResult

### Community 70 - "Security Policy"
Cohesion: 0.14
Nodes (14): Account Deletion, Audit Logging, Client Security Hardening, Credential Storage, Input Validation, Known Limitations, Reporting Vulnerabilities, Search and Rate Limiting (+6 more)

### Community 71 - "Role"
Cohesion: 0.13
Nodes (15): Role, Store, ModerationService, RoleInput, RoleService, Store, NewRoleService(), requireBelowActor() (+7 more)

### Community 72 - "channels.sql.go"
Cohesion: 0.08
Nodes (20): AdminUpdateChannelParams, CreateChannelParams, DeleteChannelPermissionParams, DeleteChannelUserPermissionParams, GetChannelOverridesRow, GetChannelPermissionParams, GetChannelPermissionRow, GetChannelRow (+12 more)

### Community 73 - "Deployment Guide"
Cohesion: 0.05
Nodes (39): Admin Backup Endpoint, Auto-Update, Background Maintenance, Backup Strategy, Building from Source, Client, config.yaml for Docker, Data Persistence (+31 more)

### Community 74 - "livekit_proxy_test.go"
Cohesion: 0.09
Nodes (42): LiveKitHealthHandlerForTest(), isOriginAllowed(), isWebSocketUpgrade(), NewLiveKitProxy(), TestIsOriginAllowed_CaseInsensitive(), TestIsOriginAllowed_EmptyAllowlistDenies(), TestIsOriginAllowed_EmptyOriginAllowed(), TestIsOriginAllowed_FirstPartyDesktopOrigins() (+34 more)

### Community 75 - "newEmojiService"
Cohesion: 0.10
Nodes (28): recordingEmojiBroadcaster, Emoji, EmojiImageURL(), Store, NewEmojiService(), NormalizeShortcode(), newEmojiService(), TestEmojiCreate_DuplicateShortcodeIsConflict() (+20 more)

### Community 76 - "ws_proxy.rs"
Cohesion: 0.12
Nodes (25): AtomicU64, accept_cert_fingerprint(), clear_sender_if_current(), disconnect_closes_the_outbound_channel(), disconnect_invalidates_an_in_flight_connect_attempt(), emit_cert_tofu(), emit_ws_state(), is_valid_cert_fingerprint() (+17 more)

### Community 77 - "bughunt.js"
Cohesion: 0.06
Nodes (31): ARGS, BUGCLASS_LENSES, buildAdaptiveLenses(), churnFiles, cleanStreak, clusterOf(), confirmedAll, confirmedSorted (+23 more)

### Community 78 - "openAdminTestDB"
Cohesion: 0.11
Nodes (34): TestNewHandler_APIRoutesMounted(), TestNewHandler_AuthProtectedRoute(), TestNewHandler_ReturnsNonNilHandler(), TestNewHandler_ServesStaticRoot(), TestNewHandler_SetsCSPOnRoot(), TestNewHandler_WithUpdater(), TestOwnerOnlyMiddleware_AdminDenied(), TestOwnerOnlyMiddleware_MemberDenied() (+26 more)

### Community 79 - "DB"
Cohesion: 0.05
Nodes (49): roleDeletingInvalidator, dbtx, DBTX, database/sql.DB, database/sql.Row, database/sql.Rows, database/sql.Stmt, database/sql.Tx (+41 more)

### Community 80 - "Tables"
Cohesion: 0.05
Nodes (37): Admin perimeter, api_tokens, attachments, audit_log, Bit Map, channel_overrides, channel_user_overrides, channels (+29 more)

### Community 81 - "newMentionFixture"
Cohesion: 0.15
Nodes (34): parseMentionTokens(), MessageService, mentionCount(), newMentionFixture(), sendAs(), TestChannelFocus_ClearsMentionCount(), TestEditMessage_EveryoneGateApplies(), TestEditMessage_ReplacesMentionsWithoutRecounting() (+26 more)

### Community 82 - "Channel"
Cohesion: 0.05
Nodes (15): memberUpdateCall, mockHub, mockHubWB, restartCall, unbanMockHub, Channel, channelRefs(), ChannelService (+7 more)

### Community 83 - "newWAFMiddleware"
Cohesion: 0.13
Nodes (19): matchRecorder, coraza.WAF, github.com/corazawaf/coraza/v3/types.Interruption, github.com/corazawaf/coraza/v3/types.MatchedRule, github.com/corazawaf/coraza/v3/types.Transaction, TestNewCRSWAF_LoadsCoreRuleSet(), TestNormalizeCRSMode(), TestWAFMiddleware_CRSDetectMode_AllowsBenignSQLishChatMessage() (+11 more)

### Community 84 - "seedUser"
Cohesion: 0.08
Nodes (45): setRole(), TestDeleteAccount_AdminAllowedWhenOwnerExists(), TestDeleteAccount_AllowedWhenOtherAdminExists(), TestDeleteAccount_AnonymisesUsername(), TestDeleteAccount_ClearsAvatarAndTOTP(), TestDeleteAccount_ClearsPassword(), TestDeleteAccount_ClearsProfileFields(), TestDeleteAccount_DeletesSessions() (+37 more)

### Community 85 - "storage_test.go"
Cohesion: 0.09
Nodes (40): newTestStorage(), TestDelete_DotDot(), TestDelete_DotPrefixFilename(), TestDelete_EmptyFilename(), TestDelete_NotFound(), TestDelete_PathTraversal(), TestDelete_ValidUUID(), TestOpen_DotDot() (+32 more)

### Community 86 - "Migrate"
Cohesion: 0.13
Nodes (31): failReadFS, TestNewRouterRefusesToStartWithMalformedTOTPKey(), Migrate(), openMemory(), TestBegin(), TestCloseIdempotent(), TestExec(), TestForeignKeysEnabled() (+23 more)

### Community 87 - "Hub"
Cohesion: 0.09
Nodes (8): sync/atomic.Pointer, Client, LiveKitProcess, Hub, TopicRateLimiter, broadcastMsg, clientEvent, pendingPresence

### Community 88 - "chdirTemp"
Cohesion: 0.11
Nodes (31): TestOwnerOnlyMiddleware_OwnerAllowed(), backdate(), listBackupFiles(), mustSetSetting(), TestMaintainBackups_RetentionNeverDeletesNewest(), TestMaintainBackups_ScheduleAndRetention(), CaptureSetupLimiter(), SetBackupBaseDir() (+23 more)

### Community 89 - "DB"
Cohesion: 0.06
Nodes (19): channelPermissionsResponse, channelFields, MemberSummary, channelFromFields(), Channel, ChannelOverride, ChannelRoleOverride, ChannelUserOverride (+11 more)

### Community 90 - "updater_test.go"
Cohesion: 0.11
Nodes (31): TestCheckForUpdate_IncludesAssetsList(), TestDownloadFile_NoTokenToExternalHost(), TestDownloadFile_SendsTokenToGitHub(), TestFetchTextAsset_Success(), TestFindClientAssets_ByTarget(), TestFindClientAssets_NilCache(), TestFindClientAssets_NoMatchingAssets(), TestParseChecksumFile_EmptyData() (+23 more)

### Community 91 - "newTestMessageService"
Cohesion: 0.12
Nodes (31): seedAroundHistory(), TestGetMessagesAround_ClampsLimit(), TestGetMessagesAround_DeletedCentreIsNotFound(), TestGetMessagesAround_EdgesReportNoMore(), TestGetMessagesAround_ExactFitReportsNoMore(), TestGetMessagesAround_MessageFromAnotherChannelIsNotFound(), TestGetMessagesAround_RejectsBadIDs(), TestGetMessagesAround_SplitsTheLimitAroundTheCentre() (+23 more)

### Community 92 - "newTestUpdater"
Cohesion: 0.09
Nodes (31): net/http/httptest.Server, dialAndAuthWS(), TestCheckForUpdateCancelledCallerDoesNotPoisonCache(), TestFetchTextAssetCachedCancelledCallerDoesNotPoisonCache(), TestCheckForUpdate_ErrorCaching(), TestFetchTextAsset_Error(), serverDownloadAssetName(), TestCheckForUpdateCoalescesConcurrentMisses() (+23 more)

### Community 93 - "Hub"
Cohesion: 0.08
Nodes (10): TestExtractEventType(), TestExtractEventTypeLengthCap(), Hub, extractEventType(), wrapWithSeq(), buildChannelDelete(), TestBuildChannelDelete_Payload(), TestBuildChannelDelete_Type() (+2 more)

### Community 94 - "compilerOptions"
Cohesion: 0.06
Nodes (32): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution, noEmit (+24 more)

### Community 95 - "NewEventRingBuffer"
Cohesion: 0.20
Nodes (18): NewEventRingBuffer(), TestConcurrent_PushAndEventsSince(), TestEventsSince_AfterSeqEqualsOldest_ReturnsNil(), TestEventsSince_AfterSeqZero_ReturnsBehavior(), TestEventsSince_AfterSpecificSeq(), TestEventsSince_AheadOfNewestSeq(), TestEventsSince_AtLatestSeq(), TestEventsSince_CapacityBoundaries() (+10 more)

### Community 96 - "VoiceDeps"
Cohesion: 0.09
Nodes (31): hasChannelAccess(), hasChannelAccessLive(), registerCallHandlers(), registerChatHandlers(), registerPingHandler(), registerPresenceHandlers(), reactionV2Handler(), registerReactionHandlers() (+23 more)

### Community 97 - "emoji_handler_test.go"
Cohesion: 0.17
Nodes (32): emojiHarness, emojiSeedUser(), gifBytes(), jpegBytes(), newEmojiHarness(), pngBytes(), TestBroadcastEmojiSet_SurvivesCanceledRequestContext(), TestEmojiDelete_BadIDIs400() (+24 more)

### Community 98 - "handleCreateEmoji"
Cohesion: 0.14
Nodes (26): EmojiBroadcaster, emojiResponse, FileStore, uploadResponse, broadcastEmojiSet(), chi.Router, handleCreateEmoji(), handleDeleteEmoji() (+18 more)

### Community 99 - "doRequest"
Cohesion: 0.16
Nodes (26): doRequest(), TestAdminAPI_PatchRole_NoRenameNoMemberUpdate(), TestAdminAPI_PatchRole_RenameBroadcastsMemberUpdate(), createUserWithRole(), decodeRole(), doRequestRaw(), newRolesHandler(), TestAdminAPI_CreateRole_DuplicateNameIsBadRequest() (+18 more)

### Community 100 - "AudioPipeline"
Cohesion: 0.05
Nodes (15): AudioPipeline, DeviceManager, createRNNoiseProcessor(), createScriptProcessorPipeline(), loadRNNoise(), log, ProcessingPipeline, RNNoiseModule (+7 more)

### Community 101 - "LoadOrGenerate"
Cohesion: 0.16
Nodes (24): TLSResult, crypto/tls.Config, fileExists(), GenerateSelfSigned(), loadACME(), loadCertPair(), LoadOrGenerate(), loadOrGenerateSelfSigned() (+16 more)

### Community 102 - "Auth Endpoints"
Cohesion: 0.07
Nodes (30): Auth Endpoints, DELETE /api/v1/auth/account, DELETE /api/v1/users/me/totp, Errors, Errors, Errors, Errors, GET /api/v1/auth/me (+22 more)

### Community 103 - "MigrateFS"
Cohesion: 0.17
Nodes (31): testing/fstest.MapFS, MigrateFS(), countVersions(), hasVersion(), simpleFS(), tableExists(), TestMigrate_AllMigrationsRecorded(), TestMigrate_AppliedAtIsISO8601() (+23 more)

### Community 104 - "newOverrideFixture"
Cohesion: 0.62
Nodes (6): newOverrideFixture(), seedChannelUserOverride(), TestListVisibleChannels_PerUserOverrideSplitsRoleMates(), TestPermissionService_AppliesUserOverrideLayer(), TestPermissionService_InvalidateUserPicksUpNewOverride(), visibleIDs()

### Community 105 - "save.go"
Cohesion: 0.26
Nodes (11): bytesProvider, go.yaml.in/yaml/v3.Node, validateYAML(), applyPatch(), atomicWrite(), findValue(), Patch, mappingRoot() (+3 more)

### Community 106 - "REST API Reference"
Cohesion: 0.07
Nodes (29): Admin API Authorization, Audit Log, Authentication, Channel Management (admin), Diagnostics, Error Codes, GET /admin/api/audit-log, GET /admin/api/me (+21 more)

### Community 107 - "NewRegistry"
Cohesion: 0.20
Nodes (15): TestManifestCommandsValidation(), TestRegisterCommandRequiresManifestDeclaration(), TestStorageKeysIsolatedPerPlugin(), TestStorageRejectsOversizedKeyAndValue(), openPluginTestDB(), TestDispatchCommandRuntimePlatformRace(), ParseManifest(), TestParseManifestRejectsBadEntrypoint() (+7 more)

### Community 108 - "voice_moderation_test.go"
Cohesion: 0.27
Nodes (28): voiceMuteMsg(), auditActions(), joinVoice(), newVoiceModHub(), seedVoiceUserWithRole(), TestVoiceDeafen_SelfUndeafenWhileServerDeafened_Refused(), TestVoiceMod_Deafen_ClearingRestoresSelfUnmute(), TestVoiceMod_Deafen_SetsServerDeafenedAndMutes() (+20 more)

### Community 109 - "ptt.rs"
Cohesion: 0.11
Nodes (18): is_allowed_ptt_capture_vk(), is_key_down(), is_modifier_vk(), keycode_to_vk(), ptt_listen_for_key(), ptt_set_key(), ptt_set_key_accepts_valid_codes_and_get_reflects_them(), ptt_start() (+10 more)

### Community 110 - "OwnCord Audit — Documentation Accuracy & UI/UX Test Coverage (2026-08-04)"
Cohesion: 0.07
Nodes (28): 10. Appendix — session command log index, 11. Remediation addendum (2026-08-04, same branch), 12. Closure addendum (2026-08-05, follow-up branch), 13. Final closure (2026-08-05, owner-directed), 1. Executive summary, 2. Architecture summary (as verified), 3. Test-run results (this session, at `5630aa1`), 4. UI/UX flow coverage matrix (+20 more)

### Community 111 - "scripts"
Cohesion: 0.07
Nodes (27): scripts, build, dev, format, format:check, knip, lint, lint:fix (+19 more)

### Community 112 - "ResolveTokenHash"
Cohesion: 0.09
Nodes (15): fakeStore, tokenStore, APITokenListItem, ResolveTokenHash(), future(), past(), TestResolveTokenHash(), DB (+7 more)

### Community 113 - "Load"
Cohesion: 0.16
Nodes (22): IsDefaultVoiceCredentials(), Load(), TestIsDefaultVoiceCredentials(), TestLoadDefaults(), TestLoadEnvironmentVariableOverrides(), TestLoadEnvOverride_EventPersistence(), TestLoadEnvOverridesPrecedenceOverYAML(), TestLoadEnvVarNoUnderscore() (+14 more)

### Community 114 - "handleVoiceE2EEOfferV2"
Cohesion: 0.16
Nodes (24): offerDeps(), TestVoiceE2EEOfferV2_EmptyFields(), TestVoiceE2EEOfferV2_HappyPath(), TestVoiceE2EEOfferV2_InvalidBase64(), TestVoiceE2EEOfferV2_NilKeyHolder_ReturnsInternal(), TestVoiceE2EEOfferV2_NoReply(), TestVoiceE2EEOfferV2_NotInVoiceChannel(), TestVoiceE2EEOfferV2_NotKeyHolder() (+16 more)

### Community 115 - "commands.rs"
Cohesion: 0.14
Nodes (15): get_cert_fingerprint(), get_identity_pin(), get_settings(), identity_pin_key(), is_settings_key_allowed(), log_cmd_err(), open_devtools(), AppHandle (+7 more)

### Community 116 - "newEmitTestHub"
Cohesion: 0.12
Nodes (28): TestEmitEvents_PresenceEvent_UsesNormalPriorityQueue(), drainChan(), Hub, newEmitTestHub(), registerEmitTestClient(), registerEmitTestVoiceClient(), TestEmitEvents_BroadcastAllEvent(), TestEmitEvents_ChannelEvent_CallsBroadcastToChannel() (+20 more)

### Community 117 - "Plan: Remediate security-hardening review regressions"
Cohesion: 0.08
Nodes (24): Cross-cutting requirements, Non-goals, Plan: Remediate security-hardening review regressions, Sequencing, W1-1. Plugin CPU budget must not permanently brick the module, W1-2. E2EE key rotation drops peers in 7+ participant calls, W1-3. Attachment-ownership check breaks Postgres and isn't atomic, W1-4. Ban authorization guards dead code (+16 more)

### Community 118 - "verify.go"
Cohesion: 0.13
Nodes (15): aead.dev/minisign.PublicKey, os.File, TestEnsureVPrefix(), ensureVPrefix(), TestOpenVerifiedBinary_CommitHappyPath(), TestOpenVerifiedBinary_SwapAfterVerifyDetectedAtCommit(), TestOpenVerifiedBinary_WrongHash(), fileSHA256() (+7 more)

### Community 119 - "newRoleCRUDService"
Cohesion: 0.14
Nodes (26): TestAffectedUserIDs_LookupFailureReportsNotOK(), TestCreateRole_ConcurrentCreatesCannotCollideOnPosition(), assertAudit(), newRoleCRUDService(), TestAffectedUserIDs(), TestCreateRole_CannotGrantUnheldBit(), TestCreateRole_CannotPlaceAtOrAboveOwnRank(), TestCreateRole_DefaultPlacementAvoidsCollision() (+18 more)

### Community 120 - "PermissionService"
Cohesion: 0.11
Nodes (15): sync.RWMutex, DB, ChannelOverride, ChannelRef, Checker, EffectiveChannelPerms(), ChannelOverride, TestEffectiveChannelPerms_ResolutionOrder() (+7 more)

### Community 121 - "EnsureLiveKitBinary"
Cohesion: 0.15
Nodes (24): io.Reader, io.ReaderAt, sync/atomic.Int32, extractChatserverFromTarGz(), TestExtractChatserverFromTarGz(), cleanupOldLiveKitBinaries(), downloadTo(), EnsureLiveKitBinary() (+16 more)

### Community 122 - "clientip_test.go"
Cohesion: 0.18
Nodes (23): net.IPNet, inCIDRs(), TestClientIP_BroadTrustedCIDRKeepsClientsDistinct(), TestClientIP_NoTrustedProxies_UsesRemoteAddr(), TestClientIP_RemoteAddrWithoutPort(), TestClientIP_SpoofedXFFFromUntrustedRemoteIgnored(), TestClientIP_TrustedProxy_NoXRealIP_FallsBackToRemoteAddr(), TestClientIP_TrustedProxy_UsesXRealIP() (+15 more)

### Community 123 - "newDeafenRaceDB"
Cohesion: 0.73
Nodes (5): mustCreateDeafenRaceChannel(), newDeafenRaceDB(), seedDeafenRaceUser(), TestVoiceModDeafen_RollbackFollowsTargetChannelMove(), TestVoiceModDeafen_UndeafenRollbackDoesNotApplyOnUnauthorizedChannel()

### Community 125 - "gif_handler_test.go"
Cohesion: 0.21
Nodes (23): lastRequest, net/http.Client, SetGIFUpstreamForTest(), chi.Router, MountGIFRoutes(), buildGIFRouter(), decodeGIFError(), decodeGIFResults() (+15 more)

### Community 126 - "navigateToMainPage"
Cohesion: 0.19
Nodes (6): emitWsEvent(), emitWsMessage(), mockTauriFullSession(), mockTauriFullSessionWithMessages(), navigateToMainPage(), simulateReconnect()

### Community 127 - "messages.sql.go"
Cohesion: 0.13
Nodes (12): CreateMessageParams, EditMessageContentParams, GetChannelUnreadCountsParams, GetChannelUnreadCountsRow, GetMessagesForAPIParams, GetMessagesForAPIRow, GetReadStateParams, GetReadStateRow (+4 more)

### Community 128 - "Channel Endpoints"
Cohesion: 0.09
Nodes (23): Channel Endpoints, DELETE /api/v1/channels/{id}/pins/{messageId}, Errors, GET /api/v1/channels, GET /api/v1/channels/{id}/messages, GET /api/v1/channels/{id}/messages/around/{messageId}, GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users, GET /api/v1/channels/{id}/pins (+15 more)

### Community 129 - "newSignedTestUpdater"
Cohesion: 0.20
Nodes (22): aead.dev/minisign.PrivateKey, multiAssetManifest(), testHash(), TestVerifyReleaseManifest_LegacySingleAssetStillVerifies(), TestVerifyReleaseManifest_MultiAssetBadChecksumFails(), TestVerifyReleaseManifest_MultiAssetSelectsLinuxEntry(), TestVerifyReleaseManifest_MultiAssetSelectsWindowsEntry(), TestVerifyReleaseManifest_MultiAssetUnknownAssetFails() (+14 more)

### Community 130 - "host_http_test.go"
Cohesion: 0.13
Nodes (19): net.Conn, net.IP, HTTPRequest, HTTPResponse, TestEmptyAllowlistDeniesEveryHost(), Registry, GuardedDialContext(), ipAllowed() (+11 more)

### Community 131 - "Topic"
Cohesion: 0.14
Nodes (12): TestGracefulStopContext_BudgetBoundsNoticeWait(), TestGracefulStopContext_IdleSkipsNoticeWait(), TestEmitEvents_DirectPresenceDropsQueuedEntry(), Client, NewPubSub(), TestUserTopic(), TestVoiceTopic(), topicFor() (+4 more)

### Community 132 - "DB"
Cohesion: 0.12
Nodes (9): mentionExecer, ChannelOverride, DB, MentionTarget, Message, insertMentionRows(), LowerASCII(), MessageService (+1 more)

### Community 133 - "users"
Cohesion: 0.14
Nodes (15): channel_overrides, channels, messages, messages_fts, roles, sessions, users, voice_states (+7 more)

### Community 134 - "Client"
Cohesion: 0.12
Nodes (4): Hub, Client, newClient(), wsConn

### Community 135 - "channel-controller.test.ts"
Cohesion: 0.13
Nodes (19): acknowledgeNsfw(), clearNsfwAcknowledgements(), isNsfwAcknowledged(), nsfwGateRequired(), setNsfwGateHost(), storageKey(), makeOpts(), makeSlots() (+11 more)

### Community 136 - "Queries"
Cohesion: 0.12
Nodes (8): BanUserParams, CreateUserParams, ListMembersRow, UpdateUserIdentityKeyParams, UpdateUserStatusParams, UpdateUserTOTPSecretParams, Queries, User

### Community 137 - "Queries"
Cohesion: 0.12
Nodes (9): CloseDMParams, GetDMParticipantsForUserRow, GetDMParticipantsRow, GetUserDMChannelsRow, IsDMParticipantParams, OpenDMParams, RemoveDMParticipantParams, SetDMChannelNameParams (+1 more)

### Community 138 - "Queries"
Cohesion: 0.12
Nodes (9): GetAuditLogParams, GetAuditLogRow, ListAllUsersParams, ListAllUsersRow, LogAuditParams, SetSettingParams, UpdateUserRoleParams, Queries (+1 more)

### Community 139 - "middleware_and_spawn_test.go"
Cohesion: 0.16
Nodes (20): adminAuthMiddleware(), isolateSpawnedTestBinary(), openWhiteboxTestDB(), TestAdminAuthMiddleware_RoleNotFound(), TestHandleGetAuditLog_DBError(), TestHandleGetSettings_DBError(), TestHandleGetStats_DBError(), TestHandleListChannels_DBError() (+12 more)

### Community 140 - "password_test.go"
Cohesion: 0.14
Nodes (19): CheckPassword(), FuzzValidatePasswordStrength(), getDummyHash(), TestCheckPassword_CorrectPassword(), TestCheckPassword_EmptyHash(), TestCheckPassword_EmptyHashTimingResistance(), TestCheckPassword_EmptyPassword(), TestCheckPassword_MalformedHash() (+11 more)

### Community 141 - "newPurgeService"
Cohesion: 0.19
Nodes (20): TestAddReaction_RefusedInArchivedChannel(), TestEditMessage_RefusedInArchivedChannel(), TestPurgeMessages_RefusedInArchivedChannel(), TestSendMessage_AllowedAfterUnarchive(), TestSendMessage_RefusedInArchivedChannel(), TestSetMessagePinned_RefusedInArchivedChannel(), MessageService, newPurgeService() (+12 more)

### Community 142 - "handleVoiceTokenRefreshV2"
Cohesion: 0.16
Nodes (17): seedTokenRefreshUser(), seedVoiceOnlyRole(), TestVoiceTokenRefreshV2_GenerateTokenError(), TestVoiceTokenRefreshV2_HappyPath(), TestVoiceTokenRefreshV2_IsKeyHolderReflectedInReply(), TestVoiceTokenRefreshV2_NoEvents(), TestVoiceTokenRefreshV2_NotInVoice(), TestVoiceTokenRefreshV2_PermissionsPassedToTokenGen() (+9 more)

### Community 143 - "pubsub_test.go"
Cohesion: 0.26
Nodes (21): assertChanEmpty(), assertChanMsg(), Client, makeTestClient(), newTestPubSub(), TestPubSub_ConcurrentAccess(), TestPubSub_Publish(), TestPubSub_PublishEmptyTopic() (+13 more)

### Community 144 - "newChannelTestAPI"
Cohesion: 0.25
Nodes (20): channelFlags, newChannel(), newChannelTestAPI(), patchChannelFlags(), TestCreateChannel_AnyTypeUnderAnyCategory(), TestCreateChannel_UnknownTypeRejected(), TestDeleteChannel_RefusesDM(), TestListChannels_ExcludesDMs() (+12 more)

### Community 145 - "handleLogStream"
Cohesion: 0.13
Nodes (13): gapProbeSSEWriter, revokingSSEWriter, lockedBuffer, bytes.Buffer, net/http.Header, TestHandleLogStream_EntryWrittenDuringBackfillIsDelivered(), TestRingBuffer_SnapshotAndSubscribe_NoGap(), TestRingBuffer_SnapshotAndSubscribe_SnapshotExcludedFromChannel() (+5 more)

### Community 146 - "handleSetup"
Cohesion: 0.18
Nodes (18): setupDefaults, SetupOptions, setupRequest, setupResponse, setupStatusResponse, setupWizardRequest, handleSetup(), isSameOrigin() (+10 more)

### Community 147 - "log/slog.Value"
Cohesion: 0.14
Nodes (9): log/slog.Value, logAttrValue(), Config, GIFConfig, GitHubConfig, VoiceConfig, redactSecret(), Session (+1 more)

### Community 148 - "Updater"
Cohesion: 0.16
Nodes (14): tauriPlatformResponse, tauriUpdateResponse, golang.org/x/sync/singleflight.Group, ensureV(), chi.Router, handleClientUpdate(), MountClientUpdateRoute(), Updater (+6 more)

### Community 149 - "Credential storage"
Cohesion: 0.25
Nodes (8): Credential storage, Environment causes that remain possible, From the client, From Windows directly, Root cause of the 2026-07 identity-key regression, The fix, Verifying the credential store on a machine, Write verification and the fallback store

### Community 150 - "dependencies"
Cohesion: 0.09
Nodes (23): dependencies, @jitsi/rnnoise-wasm, livekit-client, @tauri-apps/api, @tauri-apps/plugin-autostart, @tauri-apps/plugin-deep-link, @tauri-apps/plugin-dialog, @tauri-apps/plugin-fs (+15 more)

### Community 151 - "VoiceWidget.ts"
Cohesion: 0.12
Nodes (22): createVoiceWidget(), formatElapsed(), QUALITY_BARS, QUALITY_COLORS, STATUS_LABELS, collectAllStats(), ConnectionStats, ConnectionStatsPoller (+14 more)

### Community 152 - "Config Key Reference"
Cohesion: 0.10
Nodes (21): Backups (`backup`), Config Key Reference, Database (`database`), Environment Variable Overrides, Event Persistence (`event_persistence`), Example config.yaml, First-run setup wizard, GIF Picker (`gif`) (+13 more)

### Community 153 - "newTestPermService"
Cohesion: 0.18
Nodes (18): TestGetMessagesAround_DMNonParticipantIsNotFound(), TestCacheStats_HitsAndMisses(), newTestPermService(), TestHasChannelPerm_Allowed(), TestHasChannelPerm_Denied(), TestHasChannelPerm_OverrideAllow(), TestHasChannelPerm_OverrideDeny(), TestHasChannelPerm_UnknownUserReturnsFalse() (+10 more)

### Community 154 - "markdown.ts"
Cohesion: 0.18
Nodes (19): BlockNode, buildMatches(), codeSpanEnd(), DELIMS, DelimSpec, EMPTY_MATCHES, InlineNode, InlineStyle (+11 more)

### Community 155 - "VideoGrid.ts"
Cohesion: 0.04
Nodes (38): appendModerationSection(), showUserVolumeMenu(), VoiceModMenuOptions, computeGridLayout(), createVideoGrid(), GridLayout, setButtonIcon(), TileConfig (+30 more)

### Community 156 - "Manifest"
Cohesion: 0.22
Nodes (9): Capability, CommandSpec, Resources, UISpec, UITab, Manifest, FuzzValidateRelativePath(), TestValidateRelativePath() (+1 more)

### Community 157 - "rate-limiter.ts"
Cohesion: 0.22
Nodes (12): createChatLimiter(), createPresenceLimiter(), createRateLimiter(), createRateLimiterSet(), createReactionLimiter(), createTypingLimiter(), createVideoCameraLimiter(), createVoiceLimiter() (+4 more)

### Community 158 - "e2e/helpers.ts"
Cohesion: 0.18
Nodes (11): MOCK_INVITES, MOCK_MESSAGES_RICH, MOCK_READY_PAYLOAD, mockTauriConnect(), mockTauriConnectWith2FA(), mockTauriFullSessionWithEcho(), mockTauriFullSessionWithMessagesAndEcho(), mockTauriLoginError() (+3 more)

### Community 159 - "main.test.ts"
Cohesion: 0.27
Nodes (11): createWsClient(), ensureTauriApis(), uuid(), emitTauriEvent(), eventHandlers, mockInvoke, mockListen, capturedConnectCallbacks (+3 more)

### Community 160 - "testing.M"
Cohesion: 0.11
Nodes (11): testing.M, TestMain(), TestMain(), TestMain(), SetCostForTesting(), TestMain(), TestMain(), TestMain() (+3 more)

### Community 161 - "newMockDB"
Cohesion: 0.17
Nodes (15): chanPerm, chanRoleKey, chanUserKey, dmKey, mockDB, newMockDB(), TestHasChannelPerm(), TestHasChannelPermBatch() (+7 more)

### Community 162 - "OwnCord"
Cohesion: 0.10
Nodes (20): Architecture, Build and Test, Build from source, Configuration, Contributing, Core verification commands, Docs Index, How it's built (+12 more)

### Community 163 - "bughunt-fix.js"
Cohesion: 0.11
Nodes (15): allResults, ARGS, byFile, clusters, commits, excluded, FIX_RESULTS, fixed (+7 more)

### Community 164 - "buildTauriMockScript"
Cohesion: 0.13
Nodes (13): buildReadyPayload(), buildTauriMockScript(), chatEchoHandlers(), MOCK_LOGIN_2FA_RESPONSE, MOCK_LOGIN_RESPONSE, MOCK_TOKEN, mockTauriFullSessionWithAutoConnect(), mockTauriFullSessionWithFailingMessages() (+5 more)

### Community 165 - "OwnCord Introspection MCP Server"
Cohesion: 0.08
Nodes (22): 1. Install dependencies, 2. Mint an API token, 3. Put the token in your environment, 4. Enable in Claude Code, `api_request`, API tokens (server side), Authentication, `client_logs` (+14 more)

### Community 166 - "Bug-detection improvements — design"
Cohesion: 0.11
Nodes (18): 1a. `make fuzz`, 1b. Scoped Stryker runs, 1c. Browser-mode vitest, 1d. Prerequisite, 3a. Client model-based tests, 3b. Server hub simulation, 3c. Fault-injected transport, Bug-detection improvements — design (+10 more)

### Community 167 - "New"
Cohesion: 0.47
Nodes (4): New(), TestHandlerAddsReqID(), TestHandlerEnabledDelegates(), TestHandlerSurvivesWithGroup()

### Community 168 - "eslint-rules.js"
Cohesion: 0.12
Nodes (11): containsStrictInequality(), e2eeEpochNeedsKeypairCheck, e2eeVerifiedStatusLiteral, isThisMember(), isThisMethodCall(), noIdentityScopeFallback, noLeaveVoiceWhenSuperseded, noStoreWriteInWsOn (+3 more)

### Community 169 - "DB"
Cohesion: 0.21
Nodes (4): DB, Role, User, roleFromGen()

### Community 170 - "OwnCord — Security Review"
Cohesion: 0.11
Nodes (18): 1. A-2026-08-01 — Missing hierarchy guard on channel role-override delete, 2. A-2026-08-02 — Admin channel handlers operate on DM channels, 3. A-2026-08-03 — `call_ring` / `call_decline` bypass DM block enforcement, 4. Systemic observation, 5. Additional observation — not a vulnerability, 6. Coverage and method, Caveat — this sits on a documented design boundary, Description (+10 more)

### Community 171 - "Plan: Slash command dispatcher in WS"
Cohesion: 0.11
Nodes (17): Built-in commands, Code surface, Concurrency & lifecycle, Failure modes & UX, Files-to-touch checklist (for the implementing agent), Manifest changes, Non-goals, Open questions (+9 more)

### Community 172 - "net/http.Request"
Cohesion: 0.10
Nodes (25): gifMediaFormat, gifResponse, gifResult, PluginAdminHandler, net/http.Request, net/http.ResponseWriter, net/url.URL, TestQueryInt_LimitStillCapped() (+17 more)

### Community 173 - "ChannelTopic"
Cohesion: 0.24
Nodes (8): TestComputeAllowedChannels_DMLookupErrorIsFatal(), TestDeliverBroadcast_ShedFrameLeavesNoSeqGap(), TestEmitEvents_DMChannelOpenForcesFullResyncForOlderClients(), TestFailedHandshake_MarksUserOfflineWhenNoReplacementRemains(), TestKickClient_SubscribeRaceCannotLeaveDeadSubscriber(), TestStaleTick_PrunesIdleTopicLimiterBuckets(), ChannelTopic(), TestChannelTopic()

### Community 174 - "UserService"
Cohesion: 0.07
Nodes (24): createDMResponse, listDMsResponse, github.com/owncord/server/syncutil.Mutex, TestNewDMChannelInfo_EmptyRecipientsIsNotNil(), TestNewDMChannelInfo_ExcludesViewerAndPicksRecipient(), DMChannelInfo, DMUser, NewDMChannelInfo() (+16 more)

### Community 175 - "Blocked — fix attempted, revert-proof failed"
Cohesion: 0.14
Nodes (13): Blocked — fix attempted, revert-proof failed, Declined, OC-0001 — high — Wrapped room keys have no freshness binding, so old offers replay forever, OC-0003 — high — Unverified peers get no safety number, removing TOFU's only out-of-band escape hatch, OC-0012 — low — CleanupVoiceForChannel never clears voiceKeyHolders, OC-0039 — medium — DeleteMessage treats a GetChannel read error as "not a DM", letting a moderator hard-delete another user's private DM message, OC-0058 — low — Unban emits no WS event — *ws.Hub does not implement memberUnbanBroadcaster, OC-0081 — low — voice_max_video cap counts the requester's own camera row, so a user whose server-side camera flag is already 1 can never re-enable (+5 more)

### Community 176 - "handlers_backup.go"
Cohesion: 0.17
Nodes (14): backupEntry, backupFile, MaintainBackups(), pruneExpiredBackups(), runScheduledBackup(), scanBackups(), absOrRaw(), closeDatabase() (+6 more)

### Community 177 - "logger.ts"
Cohesion: 0.05
Nodes (62): buildAppearanceTab(), getDefaultAccent(), hexToRgb(), applyTheme(), THEME_KEYS, ThemeName, THEMES, createLogsTab() (+54 more)

### Community 178 - "fallback_crypto.rs"
Cohesion: 0.25
Nodes (16): creates_and_reuses_the_key_file(), finish_new_key_file(), load_or_create_key(), nonces_are_unique_per_seal(), protect(), rejects_a_corrupt_key_file(), rejects_a_foreign_aad(), rejects_a_wrong_key_and_tampering() (+8 more)

### Community 179 - "Direct Messages"
Cohesion: 0.12
Nodes (17): DELETE /api/v1/dms/{channelId}, Direct Messages, Errors, Errors, Errors, GET /api/v1/dms, PATCH /api/v1/dms/{channelId}, POST /api/v1/dms (+9 more)

### Community 180 - "WebSocket Protocol Reference"
Cohesion: 0.12
Nodes (17): Initial State (ready), Message Envelope, Payload Fields, Rate Limits, reaction_add / reaction_remove (Client -> Server), reaction_update (Server -> Client, broadcast), Reactions, Reconnection with State Recovery (+9 more)

### Community 181 - "command.go"
Cohesion: 0.12
Nodes (7): encoding/json.Number, parseModTarget(), ChannelScoped, PingCmd, VoiceLeaveCmd, VoiceModKickCmd, VoiceTokenRefreshCmd

### Community 182 - "NewRingBuffer"
Cohesion: 0.15
Nodes (22): TestRingBuffer_WriteDoesNotAllocate(), NewRingBuffer(), newTeeLogger(), TestCategorizeSource_AttributesAdminPackage(), TestMultiHandler_Enabled(), TestMultiHandler_ErrorAttr_RecordLevel(), TestMultiHandler_ErrorAttr_WithAttrsLevel(), TestMultiHandler_HandleReturnsNil() (+14 more)

### Community 183 - "ws-load.js"
Cohesion: 0.12
Nodes (14): authTime, broadcastLatency, CHANNEL_ID, handleSummary(), options, textSummary(), wsAcks, wsAuthed (+6 more)

### Community 184 - "newDMFixture"
Cohesion: 0.31
Nodes (10): newDMFixture(), TestDeleteMessage_DMFanoutSurvivesDeleterDisconnectAfterCommit(), TestDeleteMessage_FailsClosedWhenChannelLookupErrors(), TestDeleteMessage_RefusedInArchivedChannel(), TestEditMessage_DMFanoutSurvivesEditorDisconnectAfterCommit(), TestEditMessage_FailsClosedWhenChannelLookupErrors(), TestSendMessage_DMFanoutSurvivesSenderDisconnectAfterCommit(), TestSendMessage_DMReopenSurvivesSenderDisconnectAfterCommit() (+2 more)

### Community 185 - "handler"
Cohesion: 0.13
Nodes (13): multiHandler, ringHandler, log/slog.Attr, log/slog.Handler, log/slog.Level, log/slog.Leveler, log/slog.Record, handler (+5 more)

### Community 186 - "tauri-client/package.json"
Cohesion: 0.25
Nodes (7): name, overrides, qs, test-exclude, private, type, version

### Community 187 - "screen-share-tracks.test.ts"
Cohesion: 0.16
Nodes (8): createLocalScreenTracks, createLocalVideoTrack, fakeAudioTrack(), fakeMediaStreamTrack(), fakeVideoTrack(), loadPref, RoomRig, VideoTrackDeps

### Community 189 - "social.parity.spec.ts"
Cohesion: 0.16
Nodes (14): MENTION_SEEDED_CHANNELS, mockTauriSessionWithChannels(), NSFW_CHANNELS, MOCK_MEMBERS_MULTI_ROLE, MOCK_MESSAGES, MOCK_PINNED_MESSAGES, CapturedCall, captureScript() (+6 more)

### Community 190 - "fakeDirInfo"
Cohesion: 0.13
Nodes (3): fakeDirInfo, fakeFileInfo, io/fs.FileMode

### Community 191 - "Role Management"
Cohesion: 0.12
Nodes (16): DELETE /admin/api/roles/{id}, Errors, Errors, Errors, GET /admin/api/roles, PATCH /admin/api/roles/{id}, PATCH /admin/api/roles/reorder, POST /admin/api/roles (+8 more)

### Community 192 - "User Profile & Sessions"
Cohesion: 0.12
Nodes (16): DELETE /api/v1/users/me/sessions/{id}, Errors, Errors, GET /api/v1/users/me/sessions, PATCH /api/v1/users/me, POST /api/v1/users/me/avatar, PUT /api/v1/users/me/password, Request (+8 more)

### Community 193 - "F3 — Voice E2EE identity keys + TOFU (the remaining work)"
Cohesion: 0.12
Nodes (15): Client session (`livekitSession.ts`), Compatibility posture (transition), F3 status 2026-07-23 (branch `feat/e2ee-identity-tofu`), F3 — Voice E2EE identity keys + TOFU (the remaining work), F6 detail (done, committed `e6a0d87`), Infrastructure (mirror existing patterns), Notes carried from the build, Resume checklist (do these first) (+7 more)

### Community 194 - "run"
Cohesion: 0.23
Nodes (14): log/slog.LevelVar, log/slog.Logger, getOutboundIP(), healthcheckTLSConfig(), isAddrInUse(), loadPinnedCert(), main(), printBanner() (+6 more)

### Community 195 - "newWazeroTestRegistry"
Cohesion: 0.26
Nodes (15): Config, PluginStore, Registry, newWazeroTestRegistry(), TestWazeroActivateCompilesModule(), TestWazeroCloseTearsDownRuntime(), TestWazeroConcurrentDispatchRace(), TestWazeroCPUBudgetOverrunDoesNotBrickPlugin() (+7 more)

### Community 196 - "newUserSvc"
Cohesion: 0.20
Nodes (15): Store, newUserSvc(), TestClearCustomStatus(), TestHandlePresenceUpdate_AcceptsInvisibleAndCarriesCustomStatus(), TestHandlePresenceUpdate_RejectsUnknownStatusAndOverlongText(), TestSetCustomStatus_RoundTripClearAndBound(), TestUpdateProfile_AvatarOnlyPatchDoesNotOverwriteUsername(), TestUpdateProfile_ConcurrentUpdatesSerializePerUser() (+7 more)

### Community 197 - "plugins_handler_test.go"
Cohesion: 0.34
Nodes (15): NewPluginAdminHandler(), buildZipUpload(), newTestPluginRegistry(), newTestPluginRegistryWithStore(), openPluginTestDB(), TestPluginsHandlerEnableDisableUninstallReturn503WhenRegistryNil(), TestPluginsHandlerInstallHappyPath(), TestPluginsHandlerInstallRejectsNonZipContentType() (+7 more)

### Community 198 - "badDirFile"
Cohesion: 0.13
Nodes (5): badDirFile, fakeDir, fakeDirEntry, io/fs.DirEntry, io/fs.FileInfo

### Community 199 - "Contributing"
Cohesion: 0.13
Nodes (15): Active Branches, Available Commands, Branch Naming, Client (Tauri v2), Code Style, Commit Format, Contributing, Dependency Policy (+7 more)

### Community 200 - "User"
Cohesion: 0.14
Nodes (13): adminContextKey, adminMeResponse, adminUserResponse, github.com/coder/websocket.Conn, toAdminUserResponse(), toAdminUserResponseFromUser(), User, UserWithRole (+5 more)

### Community 201 - "mcp-introspect/package.json"
Cohesion: 0.13
Nodes (14): @modelcontextprotocol/sdk, dependencies, @modelcontextprotocol/sdk, zod, description, engines, node, name (+6 more)

### Community 202 - "v1.2.0-alpha.1 — Discord feature parity"
Cohesion: 0.08
Nodes (24): Behavioural changes operators must know about, Changelog, Deferred work, Messaging & mentions, Phase B — Acceleration, Phase C — Differentiation, Roles, permissions & moderation, Security (+16 more)

### Community 203 - "Task Observer — Continuous Skill Discovery & Improvement"
Cohesion: 0.14
Nodes (13): Acting on Observations, Archival on Write, How to Log, Log Structure, Quick Reference, Reference files — load on demand, not up front, Referencing Observations, Session Start Protocol (+5 more)

### Community 204 - "scanPluginDirectory"
Cohesion: 0.24
Nodes (10): foundPlugin, Manifest, rejectSymlinksUnder(), scanPluginDirectory(), TestRejectSymlinksUnderClean(), TestRejectSymlinksUnderFindsNestedSymlink(), TestRejectSymlinksUnderFindsSymlink(), TestScanPluginDirectoryRejectsSymlinkEntrypoint() (+2 more)

### Community 205 - "AuditWriter"
Cohesion: 0.20
Nodes (6): AuditStore, pendingAudit, sync.Once, AuditWriter, DB, waitForPersisted()

### Community 206 - "1. Channel sidebar"
Cohesion: 0.14
Nodes (14): 1.1 Channel type affordances, 1.1a Per-channel notification mutes, 1.2 Channel switching, 1.3 Reorder & CRUD (admin), 1. Channel sidebar, 2.1 Typing indicator, 2.2 Member actions (context menu), 2. Member list (+6 more)

### Community 207 - "Voice, Video & E2EE — target UX"
Cohesion: 0.09
Nodes (20): 1. View-state vocabulary, 2. Feedback primitives, 3. Connection status is a first-class, observable state, 4. Global event → reaction map, 5. Error & permission reaction matrix, 6. Cross-cutting principles, Documents, Maintenance rule (+12 more)

### Community 208 - "NewWAFMiddlewareCRS"
Cohesion: 0.22
Nodes (14): captureSlog(), TestWAFMiddleware_CRSBlockMode_AllowsBenignJSONRequest(), TestWAFMiddleware_CRSBlockMode_BlocksXSSProbe(), TestWAFMiddleware_CRSBlockMode_FalsePositivesOnSQLishChatProse(), TestWAFMiddleware_CRSDetectMode_AggregatesMatchLoggingPerRequest(), TestWAFMiddleware_InlineRulesStillBlockInEveryCRSMode(), TestWAFMiddleware_UploadBodyNotBufferedOrEmptied(), NewWAFMiddlewareCRS() (+6 more)

### Community 209 - "LiveKitProcess"
Cohesion: 0.06
Nodes (16): context.CancelFunc, github.com/livekit/protocol/livekit.ParticipantInfo, github.com/livekit/server-sdk-go/v2.RoomServiceClient, os/exec.Cmd, Store, detachFetch(), LiveKitProcess, Hub (+8 more)

### Community 210 - "migrate.go"
Cohesion: 0.33
Nodes (13): io/fs.FS, applyMigration(), ensureSchemaVersions(), DB, isApplied(), isCommentOnly(), isDuplicateColumn(), isExistingDatabase() (+5 more)

### Community 211 - "sync.Mutex"
Cohesion: 0.18
Nodes (9): fakeAuditStore, slowAuditStore, sync.Mutex, TestAuditWriter_StopDrainsBeforeStoreClose(), TestAuditWriter_StopWaitsForGoroutineExit(), TestPersistAudits_EmptyBatch(), TestPersistAudits_PoisonRowFallsBackPerRow(), TestPersistAudits_SingleTransaction() (+1 more)

### Community 212 - "Messaging — target UX"
Cohesion: 0.14
Nodes (14): 1. Message list — states, 2. Composer — permission & connection gating, 3. Sending — optimistic lifecycle, 4. Edit / delete, 5. Reactions, 6. Attachments, 7. Replies, pins, search, read/unread, 7a. Jumping to a message (+6 more)

### Community 213 - ".handleWebhookParticipantLeft"
Cohesion: 0.27
Nodes (7): github.com/livekit/protocol/livekit.WebhookEvent, FuzzParseParticipantIdentity(), FuzzParseRoomChannelID(), Hub, MountWebhookRoute(), parseParticipantIdentity(), parseRoomChannelID()

### Community 214 - "handleChannelFocusV2"
Cohesion: 0.40
Nodes (10): newFocusTestDeps(), TestChannelFocusV2_ChannelNotFound_SilentDrop(), TestChannelFocusV2_HappyPath_SetsChannelID(), TestChannelFocusV2_InvalidChannelID_SilentDrop(), TestChannelFocusV2_NoEvents(), TestChannelFocusV2_NoPermission_ReturnsForbidden(), TestChannelFocusV2_RateLimited_SilentDrop(), TestMarkReadV2_RateLimited_SkipsReadStateWrite() (+2 more)

### Community 215 - "handlers_channel_perms_test.go"
Cohesion: 0.15
Nodes (10): mockPermInvalidator, TestDeleteChannelPermission_ClearsOverride(), TestDeleteChannelPermission_UnknownRole(), TestGetChannelPermissions_DMRejected(), TestGetChannelPermissions_NotFound(), TestGetChannelPermissions_ReturnsAllRoles(), TestPutChannelPermission_AdministratorCanGrantAnyBit(), TestPutChannelPermission_MasksUnknownBits() (+2 more)

### Community 216 - "knip.json"
Cohesion: 0.15
Nodes (12): entry, ignore, ignoreDependencies, ignoreExportsUsedInFile, public/**, project, $schema, src/lib/protocolTypes.ts (+4 more)

### Community 218 - "Name"
Cohesion: 0.31
Nodes (9): overrideMatrixBits(), permGridBits(), TestAdminPanelOverrideMatrixCoversChannelScopedBits(), TestAdminPanelOverrideMatrixHasSingleDefinedBits(), TestAdminPanelPermGridCoversEveryPermissionBit(), TestAdminPanelPermGridHasNoDuplicateOrCompositeBits(), Name(), TestMentionEveryone_BitIsFreeAndNamed() (+1 more)

### Community 219 - "finish"
Cohesion: 0.38
Nodes (10): empty_out(), finish(), in_blob(), OutBlob, protect(), Vec, unprotect(), CRYPT_INTEGER_BLOB (+2 more)

### Community 220 - "TestHarness"
Cohesion: 0.19
Nodes (3): createTestHarness(), Mountable, TestHarness

### Community 221 - "Connection & Authentication — target UX"
Cohesion: 0.15
Nodes (12): 1. Boot & page model, 2.1 Server profiles & health, 2.2 Login form — state machine, 2.3 Login sequence, 2.4 Register-by-invite, 2. Connect page, 3. The connected handshake, 4. Reconnect UX (+4 more)

### Community 222 - "Settings & Admin — target UX"
Cohesion: 0.15
Nodes (13): 1. Settings overlay, 2.1 Profile edit, 2.2 Change password (with session revocation), 2.3 Two-factor (TOTP), 2.4 Sessions & delete account, 2. Account operations, 3.1 What is *not* in the client (by design), 3. Inline admin surface (client) (+5 more)

### Community 223 - "buildClientUpdateRouter"
Cohesion: 0.41
Nodes (12): buildClientUpdateRouter(), fakeGitHubRelease(), platformEntry(), TestClientUpdate_AlreadyLatest(), TestClientUpdate_DebTargetNoContent(), TestClientUpdate_FutureVersion(), TestClientUpdate_GitHubError(), TestClientUpdate_LinuxArm64TargetGetsAarch64AppImage() (+4 more)

### Community 224 - "Save"
Cohesion: 0.47
Nodes (9): Save(), loadNoEnv(), TestSaveCreatesMissingFileFromTemplate(), TestSaveLeavesUnparseableFileIntact(), TestSavePatchesGeneratedDefaultFile(), TestSavePreservesHandEdits(), TestSaveVoiceAutoDownloadBool(), TestSaveVoiceCredentialsOnlyWhenEmpty() (+1 more)

### Community 225 - "New"
Cohesion: 0.15
Nodes (20): NewDMService(), TestDMService_CreateDM_AllowsLapsedTemporaryBan(), TestDMService_CreateDM_RefusesBannedRecipient(), TestDMService_CreateGroupDM_RefusesBannedRecipient(), Store, NewModerationService(), newTestModerationService(), newTestRoleService() (+12 more)

### Community 226 - "event.go"
Cohesion: 0.02
Nodes (32): TestPresenceEvents_InvisibleBlanksCustomStatusForOthers(), presenceEvents(), BroadcastAllEvent, CallSignalEvent, ChannelEvent, ClientError, DMChannelOpenEvent, Event (+24 more)

### Community 227 - "NewTopicRateLimiter"
Cohesion: 0.24
Nodes (8): TopicRateLimiter, NewTopicRateLimiter(), TopicRateLimiter, TestTopicRateLimiter_Allow_EnforcesQuotaThenRefills(), TestTopicRateLimiter_Cleanup_EmptyMap(), TestTopicRateLimiter_Cleanup_KeepsFreshBuckets(), TestTopicRateLimiter_Cleanup_RemovesStaleBuckets(), tokenBucket

### Community 228 - "Skill Authoring — taxonomy, licensing, confidentiality, editing rules"
Cohesion: 0.17
Nodes (11): Author Attribution Template, Confidentiality layers, Editing skills — always start from the live file, Lean Content, Licensing, New skills, Principle Propagation, Skill Authoring — taxonomy, licensing, confidentiality, editing rules (+3 more)

### Community 229 - ".oxlintrc.json"
Cohesion: 0.17
Nodes (11): categories, correctness, perf, suspicious, ignorePatterns, public, rules, no-map-spread (+3 more)

### Community 230 - "attachment_queries_test.go"
Cohesion: 0.20
Nodes (9): TestGetAttachmentByID_Found(), TestGetAttachmentByID_NotFound(), TestGetAttachmentsByMessageIDs_Empty(), TestGetAttachmentsByMessageIDs_GroupsByMessage(), TestLinkAttachmentsToMessage_Empty(), TestLinkAttachmentsToMessage_LinksUnlinked(), TestLinkAttachmentsToMessage_OwnershipGuard(), TestLinkAttachmentsToMessage_SkipsAlreadyLinked() (+1 more)

### Community 231 - "e2e/dm-system.spec.ts"
Cohesion: 0.23
Nodes (10): MOCK_DM_CHANNELS, MOCK_READY_WITH_DMS, mockTauriSessionWithDms(), navigateToMainPageWithDms(), MOCK_AUTH_OK, MOCK_CHANNELS, MOCK_ROLES, submitLogin() (+2 more)

### Community 232 - "Queries"
Cohesion: 0.21
Nodes (5): BlockUserParams, IsBlockedParams, IsEitherBlockedParams, UnblockUserParams, Queries

### Community 233 - "emoji.sql.go"
Cohesion: 0.23
Nodes (6): CreateEmojiParams, CreateEmojiRow, GetEmojiByIDRow, GetEmojiByShortcodeRow, ListEmojiRow, Queries

### Community 234 - "OwnCord — Architectural Audit & Spec-Conformance Review"
Cohesion: 0.17
Nodes (12): 1. Carried-over items from audit-2026-04-07, 2.1 `docs/api.md`, 2.2 `docs/protocol.md`, 2.3 `docs/schema.md`, 2. Spec-conformance matrix, 3. Server architecture findings, 4. Client architecture findings, 5. Process & CI findings (+4 more)

### Community 235 - "LiveKit Setup Guide"
Cohesion: 0.17
Nodes (12): 1. Get the LiveKit Binary, 2. Server Configuration, 3. Ports and Firewall, 4. How the Companion Process Works, 5. Token Flow, 6. Webhook Integration, 7. Troubleshooting, 8. Production Checklist (+4 more)

### Community 236 - "Voice Signaling"
Cohesion: 0.17
Nodes (12): voice_camera (Client -> Server), voice_config (Server -> Client, direct), voice_join (Client -> Server), voice_leave (Client -> Server), voice_leave (Server -> Client, broadcast), voice_mute / voice_deafen (Client -> Server), voice_screenshare (Client -> Server), Voice Signaling (+4 more)

### Community 237 - "Quick Start Guide"
Cohesion: 0.17
Nodes (12): Choose Your Setup Path, Client Connection Notes, If Remote Users Cannot Connect, Next Steps, Option A: Prebuilt binaries (recommended), Option B: Docker (Linux server), Option C: Build from source, Optional: enable the GIF picker (+4 more)

### Community 238 - "readPump"
Cohesion: 0.22
Nodes (7): TestWritePump_DrainsQueuedFramesAfterCloseSend(), Client, Hub, TestWritePump_DrainsAllNormalBeforeAnyLow(), readPump(), writePump(), TestHandleReconnect_HandshakeWriteFailure_TearsDownOnlyOnce()

### Community 239 - "mockTauriFullSessionWithVoice"
Cohesion: 0.25
Nodes (6): joinVoiceChannelByName(), mockTauriFullSessionWithVoice(), mockTauriFullSessionWithVoiceFailure(), voiceJoinFailureHandler(), NOTE: These tests do NOT exercise real LiveKit/WebRTC connections., VOICE_STATE_EVENT

### Community 240 - "index.mjs"
Cohesion: 0.23
Nodes (6): collectLogs(), httpsAgent(), REPO_ROOT, request(), safeParse(), server

### Community 241 - "countingReadStateStore"
Cohesion: 0.18
Nodes (5): failingMembersStore, sync/atomic.Int64, Store, countingReadStateStore, countingStore

### Community 242 - "bughunt.harness.mjs"
Cohesion: 0.18
Nodes (3): here, none, scenarios

### Community 243 - "voice-audio-tab.test.ts"
Cohesion: 0.18
Nodes (6): mockReapplyAudioProcessing, mockSetInputVolume, mockSetOutputVolume, mockSetVoiceSensitivity, mockSwitchInputDevice, mockSwitchOutputDevice

### Community 244 - "reactions.sql.go"
Cohesion: 0.25
Nodes (6): AddReactionParams, GetReactionCountsRow, GetReactionUsersParams, GetReactionUsersRow, RemoveReactionParams, Queries

### Community 245 - "Channel Permission Overrides"
Cohesion: 0.18
Nodes (11): Audit, Cache and fan-out, Channel Permission Overrides, DELETE /admin/api/channels/{id}/permissions/{roleId}, DELETE /admin/api/channels/{id}/user-permissions/{userId}, Errors, GET /admin/api/channels/{id}/permissions, PUT /admin/api/channels/{id}/permissions/{roleId} (+3 more)

### Community 246 - "Server Stats & User Administration"
Cohesion: 0.18
Nodes (11): DELETE /admin/api/users/{id}/sessions, Errors, GET /admin/api/stats, GET /admin/api/users, PATCH /admin/api/users/{id}, Request, Response 200 OK, Response 200 OK (+3 more)

### Community 247 - ".UpdateUserProfile"
Cohesion: 0.28
Nodes (4): UpdateUserCustomStatusParams, UpdateUserPasswordParams, UpdateUserProfileParams, Queries

### Community 248 - "groupDMFixture"
Cohesion: 0.42
Nodes (8): groupDMFixture(), TestCreateGroupDMChannel_OpensForEveryone(), TestCreateGroupDMChannel_RefusesUnderThree(), TestGetDMParticipants_CollapsesInvisible(), TestGetOrCreateDMChannel_IgnoresShrunkGroup(), TestLeaveGroupDM_DeletesChannelOnLastLeave(), TestLeaveGroupDM_LastLeavePreservesAttachmentsForReclaim(), TestSetDMChannelName_RefusesNonDM()

### Community 249 - "handleChatCommandV2"
Cohesion: 0.13
Nodes (15): getCommandConstructor(), TestCanPluginBroadcast_NilServiceFailsClosed(), TestChatCommandConstructor_Errors(), TestHandleChatCommandV2_NoRegistry(), TestHandleVoiceJoinV2_SignalsJoin(), TestHandleVoiceLeaveV2_RateLimited(), TestHandleVoiceLeaveV2_SignalsLeave(), TestVoiceJoinConstructor_Errors() (+7 more)

### Community 250 - "slashFS"
Cohesion: 0.29
Nodes (4): slashFS, failReadDirFS, io/fs.File, toSlashPath()

### Community 251 - "Running the bughunt pipeline"
Cohesion: 0.20
Nodes (9): 1. Hunt, 2. Gate (human), 3. Fix, 4. Verify the fixes independently — REQUIRED, Composing the batch, Running the bughunt pipeline, Security findings, Testing the workflows themselves (+1 more)

### Community 252 - "MainPage.ts"
Cohesion: 0.03
Nodes (73): DmProfileSidebarComponent, closeActiveLightbox(), clearReactionUsersCache(), setReactionUsersFetcher(), applyConnectionStatus(), createServerBanner(), ServerBannerControl, createToastContainer() (+65 more)

### Community 253 - "reconnectAfterCertAccept"
Cohesion: 0.31
Nodes (3): CertReconnectRouter, CertReconnectWs, reconnectAfterCertAccept()

### Community 255 - "emoji-voicemod.parity.spec.ts"
Cohesion: 0.24
Nodes (8): CapturedCall, getCapturedCalls(), mockSessionWithCustomEmoji(), mockVoiceSessionWithoutModPermission(), SEEDED_CUSTOM_EMOJI, waitForCapturedCall(), emitWsMessageAndWait(), voiceWsHandlers()

### Community 256 - "voice-e2ee-verify.spec.ts"
Cohesion: 0.22
Nodes (6): MOCK_CHANNELS_WITH_CATEGORIES, MOCK_VOICE_STATE, emitPeerAnnounce(), mockE2EEVoiceSession(), PeerCrypto, voiceJoinWithTokenHandler()

### Community 257 - "include"
Cohesion: 0.20
Nodes (9): exclude, extends, include, tests/e2e, ./tsconfig.json, playwright.config.admin.ts, playwright.config.native.ts, playwright.config.prod.ts (+1 more)

### Community 258 - "Queries"
Cohesion: 0.24
Nodes (4): CreateInviteParams, GetInviteRow, ListInvitesRow, Queries

### Community 259 - "Custom Emoji"
Cohesion: 0.20
Nodes (10): Custom Emoji, DELETE /api/v1/emoji/{id}, Errors, Errors, GET /api/v1/emoji, GET /api/v1/emoji/{id}/image, POST /api/v1/emoji, Response 200 OK (+2 more)

### Community 260 - "OwnCord — Test-Coverage Audit"
Cohesion: 0.18
Nodes (10): 1. How coverage was measured (and why the CI number is wrong), 2. Finding closure status, 3. Measured baselines (diff against these next time), 4. Two bugs surfaced by writing the tests, 5. CI gates after this pass, 6. Backlog, Client (`npx vitest run --coverage`), Go — cross-package (`make cover-all`) (+2 more)

### Community 261 - "OriginAcceptOptions"
Cohesion: 0.31
Nodes (8): github.com/coder/websocket.AcceptOptions, OriginAcceptOptions(), TestOriginAcceptOptions_EmptyList(), TestOriginAcceptOptions_ExplicitOrigins(), TestOriginAcceptOptions_MixedWithWildcard(), TestOriginAcceptOptions_NilList(), TestOriginAcceptOptions_ReturnsAcceptOptions(), TestOriginAcceptOptions_WildcardEnablesInsecureSkipVerify()

### Community 262 - "EventRingBuffer"
Cohesion: 0.27
Nodes (3): github.com/owncord/server/syncutil.RWMutex, eventEntry, EventRingBuffer

### Community 263 - "FuzzImageDimensions"
Cohesion: 0.46
Nodes (7): fuzzGIFBytes(), FuzzImageDimensions(), fuzzJPEGBytes(), fuzzPNGBytes(), fuzzWebPVP8(), fuzzWebPVP8L(), fuzzWebPVP8X()

### Community 264 - "newTokenTestDB"
Cohesion: 0.51
Nodes (9): newTokenTestDB(), seedTokenUser(), TestAPIToken_CreateGetRevoke(), TestAPIToken_Expiry(), TestAPIToken_RevokeByLabel(), TestAPIToken_TouchAndList(), TestGetOwnerUser(), TestGetOwnerUser_LapsedTempBanStaysEligible() (+1 more)

### Community 265 - "scripts"
Cohesion: 0.22
Nodes (8): changelogen, devDependencies, changelogen, private, scripts, changelog, hooks:install, release

### Community 266 - "bughunt-fix.harness.mjs"
Cohesion: 0.22
Nodes (4): FOUR_FILES, here, PROVE_FAIL, scenarios

### Community 267 - "router.ts"
Cohesion: 0.36
Nodes (4): createRouter(), NavigateListener, PageId, Router

### Community 268 - "E2E Test Status — 2026-08-05"
Cohesion: 0.22
Nodes (8): CI wiring (`.github/workflows/ci.yml`), Current status: 291 web tests, 291 passed (100%), E2E Test Status — 2026-08-05, Environment notes for local runs, History (dispositions of the old contents of this file), Known issues (open), Resolved (2026-08-04 remediation), Suite inventory

### Community 269 - "render-ledger.mjs"
Cohesion: 0.27
Nodes (6): main(), render(), selftest(), SEV_RANK, VALID_STATUS, validate()

### Community 270 - "newBlockService"
Cohesion: 0.46
Nodes (7): newBlockService(), TestBlockService_BlockUser(), TestBlockService_BlockUser_Idempotent(), TestBlockService_BlockUser_Rejections(), TestBlockService_ListBlocked(), TestBlockService_UnblockUser(), TestBlockService_UnblockUser_Rejections()

### Community 271 - "TestMigrate_UpgradeFromMigration019PreservesData"
Cohesion: 0.36
Nodes (4): migrationCutoffFS, columnExists(), TestMigrate_FullChainSchemaIsCoherent(), TestMigrate_UpgradeFromMigration019PreservesData()

### Community 272 - "Queries"
Cohesion: 0.28
Nodes (4): CreateAttachmentParams, GetAttachmentByIDRow, GetAttachmentWithChannelRow, Queries

### Community 273 - "TestChannelVisibility_RESTWSAgreement"
Cohesion: 0.67
Nodes (6): equalSets(), idSet(), seedVisibilityUser(), sortedKeys(), TestChannelVisibility_RESTWSAgreement(), TestChannelVisibility_UserOverrideAgreement()

### Community 274 - "fuzzOpenMigratedMemory"
Cohesion: 0.60
Nodes (4): fuzzTestHelper, fuzzOpenMigratedMemory(), FuzzSanitizeFTSQuery(), DB

### Community 275 - "Finish the V2 Dispatch Migration (backlog item 11) — Design"
Cohesion: 0.22
Nodes (8): Approach — port the 3, then delete the V1 machinery, As implemented (2026-07-20), Current state — only 3 types remain on V1, Files touched, Finish the V2 Dispatch Migration (backlog item 11) — Design, Non-goals, Problem, Test plan

### Community 276 - "Port Forwarding Guide"
Cohesion: 0.22
Nodes (9): Always required, Before You Start, Connect Address to Share, Dynamic Public IP, Port Forwarding Guide, Required only for voice/video, Required Ports, Router Steps (+1 more)

### Community 277 - "Chat Messages"
Cohesion: 0.22
Nodes (9): chat_bulk_deleted (Server -> Client, broadcast), chat_delete (Client -> Server), chat_deleted (Server -> Client, broadcast), chat_edit (Client -> Server), chat_edited (Server -> Client, broadcast), chat_message (Server -> Client, broadcast), Chat Messages, chat_send (Client -> Server) (+1 more)

### Community 279 - "OwnCord — Comprehensive Project Audit"
Cohesion: 0.22
Nodes (9): 8. Plugin System Governance, 9. Prioritized Top-10 Action List, Bonus (quick wins), CRITICAL Issues, Finding closure status (maintained; last updated 2026-07-20), OwnCord — Comprehensive Project Audit, Plugin Architecture, Strengths (+1 more)

### Community 280 - "RingBuffer"
Cohesion: 0.30
Nodes (5): LogEntry, ticketEntry, ticketStore, RingBuffer, NewMultiHandler()

### Community 281 - "Client HTTP TOFU Proxy (D5) — Design"
Cohesion: 0.10
Nodes (18): Approach — loopback TCP→TLS tunnel (reuse the LiveKit proxy pattern), Client HTTP TOFU Proxy (D5) — Design, Implementation summary (what shipped), Lifecycle & wiring, Non-goals, Problem, Testing, TOFU semantics (must match ws_proxy) (+10 more)

### Community 282 - "create_tray"
Cohesion: 0.61
Nodes (7): create_tray(), emit_status_change(), handle_menu_event(), AppHandle, Error, R, toggle_window_visibility()

### Community 283 - "API Tokens"
Cohesion: 0.25
Nodes (8): API Tokens, DELETE /admin/api/tokens/{id}, GET /admin/api/tokens, POST /admin/api/tokens, Request, Response 200 OK, Response 201 Created, Response 204 No Content

### Community 284 - "Backups"
Cohesion: 0.25
Nodes (8): Backups, DELETE /admin/api/backups/{name}, GET /admin/api/backups, POST /admin/api/backup, POST /admin/api/backups/{name}/restore, Response 200 OK, Response 200 OK, Response 200 OK

### Community 285 - "Plugin Administration"
Cohesion: 0.25
Nodes (8): DELETE /api/v1/admin/plugins/{id}, GET /api/v1/admin/plugins, Plugin Administration, POST /api/v1/admin/plugins/{id}/disable, POST /api/v1/admin/plugins/{id}/enable, POST /api/v1/admin/plugins/install, Response 200 OK, Response 201 Created

### Community 286 - "Invite Endpoints"
Cohesion: 0.25
Nodes (8): DELETE /api/v1/invites/{code}, GET /api/v1/invites, Invite Endpoints, POST /api/v1/invites, Request, Response 200 OK, Response 201 Created, Response 204 No Content

### Community 287 - "2. Code Quality"
Cohesion: 0.25
Nodes (8): 2. Code Quality, Go — Error Handling, Go — Interface Design, Go — Large Files (>800 lines), Go — Security-Relevant TODOs, TypeScript — Error Handling Gaps, TypeScript — Large Components, TypeScript — Type Safety

### Community 288 - "Infrastructure roadmap — design"
Cohesion: 0.25
Nodes (7): Infrastructure roadmap — design, Problem, Suggested sequencing, Track 1 — Raise the single-instance ceiling, Track 2 — Cheap seams for a multi-instance future, Track 3 — Ops hygiene, What not to do

### Community 289 - "Member Updates"
Cohesion: 0.25
Nodes (8): emoji_update (Server -> Client, broadcast), member_ban (Server -> Client, broadcast), member_join (Server -> Client, broadcast), member_leave (reserved), member_update (Server -> Client, broadcast), Member Updates, roles_update (Server -> Client, broadcast), user_update (Server -> Client, broadcast)

### Community 290 - "genprotocol/main.go"
Cohesion: 0.57
Nodes (7): message, schema, header(), main(), renderGo(), renderTS(), validate()

### Community 292 - ".finishVoiceLeave"
Cohesion: 0.50
Nodes (3): Client, Hub, leaveVoiceChannelWithRetry()

### Community 294 - "Environments, Activation Setup, and Handoff-Doc Mode"
Cohesion: 0.29
Nodes (6): Compaction behaviour, Environments, Activation Setup, and Handoff-Doc Mode, Handoff-doc analysis (when one arrives), Handoff-doc mode (no persistent storage), Recommended activation setup, User-facing documentation

### Community 295 - "handlePingV2"
Cohesion: 0.60
Nodes (4): TestPingV2_HappyPath_ReturnsPongReply(), TestPingV2_NoEvents(), TestPingV2_RateLimited_ReturnsEmpty(), handlePingV2()

### Community 296 - "capabilities-scope.test.ts"
Cohesion: 0.29
Nodes (4): Permission, permissions, ScopedPermission, ScopeEntry

### Community 297 - "ParseLevel"
Cohesion: 0.67
Nodes (3): ParseLevel(), TestLoggingLevelFromEnv(), TestParseLevel()

### Community 298 - "GET /admin/api/updates"
Cohesion: 0.29
Nodes (7): Errors, Errors, GET /admin/api/updates, POST /admin/api/updates/apply, Response 200 OK, Response 200 OK, Server Updates

### Community 299 - "Channel-Visibility Unification (backlog item 3) — Design"
Cohesion: 0.29
Nodes (6): Approach — funnel all four through the checker that already exists, Channel-Visibility Unification (backlog item 3) — Design, Files touched, Non-goals, Problem, Test plan

### Community 300 - "sqlc Adoption (D2) — Progress & Plan"
Cohesion: 0.29
Nodes (7): Approach, Deliberately kept raw (no clean sqlc mapping), Out of scope for D2, Phase 1 + 2 — done (2026-07-19), sqlc Adoption (D2) — Progress & Plan, Status, Verification (per phase)

### Community 301 - "Authentication Flow"
Cohesion: 0.29
Nodes (7): Authentication Flow, Periodic Session Revalidation, Step 1: Client Sends auth, Step 2: Success -- auth_ok, Step 3: Failure -- auth_error, Step 4: ready Payload, Step 5: Member Join + Presence

### Community 302 - "Voice Moderation"
Cohesion: 0.29
Nodes (7): voice_disconnected (Server -> Client, direct), voice_mod_deafen (Client -> Server), voice_mod_kick (Client -> Server), voice_mod_move (Client -> Server), voice_mod_mute (Client -> Server), Voice Moderation, voice_moved (Server -> Client, direct)

### Community 303 - "bug_report.md"
Cohesion: 0.29
Nodes (6): Actual Behavior, Description, Environment, Expected Behavior, Screenshots / Logs, Steps to Reproduce

### Community 304 - "Pull Request"
Cohesion: 0.29
Nodes (6): Changes, Pull Request, Related Issues, Screenshots, Summary, Test Plan

### Community 305 - "prettier"
Cohesion: 0.25
Nodes (8): prettier, arrowParens, endOfLine, printWidth, semi, singleQuote, tabWidth, trailingComma

### Community 306 - "openFileDB"
Cohesion: 0.62
Nodes (6): openFileDB(), seedChannelAndUser(), TestFilePool_ConcurrentReadsAndWrites(), TestFilePool_FKViolationRejectedOnFile(), TestFilePool_ForeignKeysOnReaderConnections(), TestFilePool_ReadDuringOpenWriteTx()

### Community 307 - "hello plugin"
Cohesion: 0.29
Nodes (6): Build command, Building the WASM, hello plugin, Manifest, Prerequisites, Tests

### Community 310 - "4. Dependencies & Supply Chain"
Cohesion: 0.29
Nodes (7): 4. Dependencies & Supply Chain, Go Modules — 30 direct deps, ALL exact-pinned ✅, Known Vulnerabilities, License Compliance, Lockfile Status, npm — 13 production deps, ALL floating (^) ⚠️, Overall Posture: **MODERATE RISK** (Go excellent, npm floating)

### Community 311 - "protocol_contract_test.go"
Cohesion: 0.57
Nodes (6): loadGoMsgTypeConstants(), loadProtocolSchema(), TestProtocolSchema_MatchesGeneratedGoConstants(), TestProtocolSchema_NoUndocumentedGoConstants(), protocolSchema, protocolSchemaEntry

### Community 313 - "ci-check"
Cohesion: 0.33
Nodes (5): ci-check, Client (from `Client/tauri-client/`), Hooks, Rust (from `Client/tauri-client/src-tauri/`), Server (from `Server/`)

### Community 314 - "Comprehensive Review (scheduled or fallback)"
Cohesion: 0.33
Nodes (5): Approval policy, Comprehensive Review (scheduled or fallback), Constraints, Delivering updated skills, Steps

### Community 317 - "cert-tofu.spec.ts"
Cohesion: 0.33
Nodes (4): CertTofuPayload, FIRST_USE, MISMATCH, MISMATCH_LIVE_HOST

### Community 320 - "tsconfig.build.json"
Cohesion: 0.33
Nodes (5): exclude, extends, include, src, ./tsconfig.json

### Community 321 - "User Blocks"
Cohesion: 0.33
Nodes (6): DELETE /api/v1/blocks/{userId}, GET /api/v1/blocks, PUT /api/v1/blocks/{userId}, Response 200 OK, Response 200 OK, User Blocks

### Community 322 - "PATCH /admin/api/settings"
Cohesion: 0.33
Nodes (6): Errors, GET /admin/api/settings, PATCH /admin/api/settings, Request, Response 200 OK -- the full settings map after the update., Server Settings

### Community 323 - "GET /api/v1/gif/search"
Cohesion: 0.33
Nodes (6): Errors, GET /api/v1/gif/search, GET /api/v1/gif/trending, GIFs, Query Parameters, Response 200 OK

### Community 324 - "First-Run Setup"
Cohesion: 0.33
Nodes (6): First-Run Setup, GET /admin/api/setup/status, POST /admin/api/setup, Request, Response 200 OK, Response 200 OK

### Community 325 - "LiveKit Endpoints"
Cohesion: 0.33
Nodes (6): GET /api/v1/livekit/health, LiveKit Endpoints, /livekit/* (Reverse Proxy), POST /api/v1/livekit/webhook, Response 200 OK, Response 503 Service Unavailable

### Community 327 - "README.md"
Cohesion: 0.16
Nodes (10): Benefits, Setup, Tailscale Guide (Zero-Config Remote Access), TLS Recommendation, Voice/Video with Tailscale, Why Tailscale, Hardening documentation, Reporting a vulnerability (+2 more)

### Community 329 - "5. Test Coverage & Quality"
Cohesion: 0.29
Nodes (7): 5. Test Coverage & Quality, Go — Critical Coverage Gaps, Go — Package Coverage, Go — Test Quality: GOOD, TypeScript — E2E Coverage: EXCELLENT, TypeScript — Test Files, TypeScript — Unit Coverage: MINIMAL (<10%)

### Community 336 - "GET /api/v1/client-update/{target}/{current_version}"
Cohesion: 0.40
Nodes (5): Client Auto-Update, GET /api/v1/client-update/{target}/{current_version}, Path Parameters, Response 200 OK (update available), Response 204 No Content

### Community 337 - "OwnCord Architecture Blueprints"
Cohesion: 0.40
Nodes (5): Index, Maintenance rule, OwnCord Architecture Blueprints, Relationship to other docs, Structure vs. behavior

### Community 338 - "Voice End-to-End Encryption"
Cohesion: 0.40
Nodes (5): voice_e2ee_announce (Client -> Server), voice_e2ee_announce (Server -> Client, broadcast to voice channel), voice_e2ee_offer (Client -> Server), voice_e2ee_offer (Server -> Client, relay to target), Voice End-to-End Encryption

### Community 339 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Alternatives Considered, Problem, Proposed Solution

### Community 341 - "setupDiagnosticsRouter"
Cohesion: 0.24
Nodes (10): setupDiagnosticsRouter(), TestDiagnosticsConnectivity_MemberForbidden(), TestDiagnosticsConnectivity_ReturnsData(), TestDiagnosticsConnectivity_Unauthenticated(), TestIsPrivateIP(), buildMetricsRouter(), TestHandleMetrics_AdminIPRestrict_AllowsAdmin(), TestHandleMetrics_AdminIPRestrict_BlocksNonAdmin() (+2 more)

### Community 342 - "RunningInContainer"
Cohesion: 0.50
Nodes (3): RunningInContainer(), TestRunningInContainer_BareMetalDefault(), TestRunningInContainer_EnvSemantics()

### Community 361 - "OwnCord"
Cohesion: 0.33
Nodes (5): Bug-hunt ledger, Generated code — never hand-edit, Gotchas, Knowledge graph (graphify), OwnCord

### Community 362 - "OwnCord Client (Tauri v2)"
Cohesion: 0.50
Nodes (3): Gotchas, Layout, OwnCord Client (Tauri v2)

### Community 364 - "log_level_from_env"
Cohesion: 0.67
Nodes (3): log_level_from_env(), run(), LevelFilter

### Community 365 - "TestHandleVoiceCameraV2_RefusedWhenScreenshareSlotFull"
Cohesion: 0.73
Nodes (5): mustCreateVideoCappedChannel(), newOC0023VideoLimitDB(), seedOC0023VideoLimitUser(), TestHandleVoiceCameraV2_RefusedWhenScreenshareSlotFull(), TestHandleVoiceScreenshareV2_RefusedWhenCameraSlotFull()

### Community 367 - "File Upload and Serving"
Cohesion: 0.50
Nodes (4): File Upload and Serving, GET /api/v1/files/{id}, POST /api/v1/uploads, Response 201 Created

### Community 368 - "Server Logs (SSE)"
Cohesion: 0.50
Nodes (4): GET /admin/api/logs/stream?ticket={ticket}, POST /admin/api/logs/ticket, Response 200 OK, Server Logs (SSE)

### Community 373 - "DM Calls"
Cohesion: 0.50
Nodes (4): call_decline (Client -> Server) / call_declined (Server -> Client), call_incoming (Server -> Client), call_ring (Client -> Server), DM Calls

### Community 374 - "Channel Updates"
Cohesion: 0.50
Nodes (4): channel_create (Server -> Client, broadcast), channel_delete (Server -> Client, broadcast), channel_update (Server -> Client, broadcast), Channel Updates

### Community 375 - "Heartbeat and Connection Liveness"
Cohesion: 0.50
Nodes (4): Client Ping, Heartbeat and Connection Liveness, Server Pong, Server Stale Client Sweep

### Community 376 - "Message Type Reference Table"
Cohesion: 0.50
Nodes (4): Client -> Server (27 types), Message Type Reference Table, Plugin command types, Server -> Client (39 types)

### Community 377 - "Direct Messages"
Cohesion: 0.50
Nodes (4): Direct Messages, DM Authorization, dm_channel_close (Server -> Client), dm_channel_open (Server -> Client)

### Community 378 - "OwnCord Server (Go)"
Cohesion: 0.50
Nodes (3): Gotchas, Layout, OwnCord Server (Go)

### Community 379 - "1. Architecture"
Cohesion: 0.40
Nodes (5): 1. Architecture, Anti-patterns, Communication Patterns, Dependency Direction, Layer Map

### Community 407 - "Channel Focus and Read State"
Cohesion: 0.67
Nodes (3): Channel Focus and Read State, channel_focus (Client -> Server), mark_read (Client -> Server)

### Community 408 - "Error Handling"
Cohesion: 0.67
Nodes (3): Error Codes, Error Handling, error (Server -> Client)

### Community 409 - "Presence"
Cohesion: 0.67
Nodes (3): Presence, presence (Server -> Client, broadcast), presence_update (Client -> Server)

### Community 410 - "Transport Layer"
Cohesion: 0.67
Nodes (3): Transport Layer, Transport Limits, WebSocket Endpoint

### Community 413 - "6. CI/CD & DevEx"
Cohesion: 0.40
Nodes (5): 6. CI/CD & DevEx, Build Reproducibility, Gaps, Linting Enforcement, Pipeline Gates

### Community 414 - "7. Observability"
Cohesion: 0.40
Nodes (5): 7. Observability, Client-Side: LIMITED ⚠️, Error Surfacing: GOOD ✅, Logging: STRONG ✅, Metrics & Tracing: PRESENT (build-tag gated)

### Community 449 - "RateLimiter"
Cohesion: 0.20
Nodes (10): entry, lockoutEntry, LockoutPersister, rateLimiterShard, time.Duration, RateLimiter, NewPersistentRateLimiter(), newRateLimiter() (+2 more)

## Knowledge Gaps
- **1822 isolated node(s):** `OC-0012 — low — CleanupVoiceForChannel never clears voiceKeyHolders`, `OC-0058 — low — Unban emits no WS event — *ws.Hub does not implement memberUnbanBroadcaster`, `OC-0081 — low — voice_max_video cap counts the requester's own camera row, so a user whose server-side camera flag is already 1 can never re-enable`, `OC-0086 — low — sweepStaleVoiceStates classifies ghost rows from a snapshot and then deletes them without re-checking, so an in-flight voice_join is ejected from the SFU while the hub still believes the user is in the room`, `OC-0090 — low — channelReadAudience falls through to a server-wide role scan when the channel row is gone, leaking a private group-DM's voice_leave to every connected member` (+1817 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **76 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DB` connect `DB` to `testing.T`, `seedChannel`, `context.Context`, `buildChannelRouter`, `waitRegistered`, `NewAdminAPI`, `net/http.HandlerFunc`, `NewTestClient`, `newHandlerHub`, `drainChanTimeout`, `buildDMRouter`, `newAuthTestDB`, `newMigratedTestDB`, `EventPersister`, `Hub`, `database/sql.Result`, `newUploadTestDB`, `writeJSON`, `HashToken`, `Key`, `livekit_test.go`, `NewChecker`, `net/http.Handler`, `Result`, `NewRouter`, `profileCreateToken`, `openMigratedMemory`, `newServeHub`, `postJSONWithToken`, `newVoiceTestDB`, `itoa`, `Role`, `newEmojiService`, `openAdminTestDB`, `newMentionFixture`, `Channel`, `seedUser`, `Migrate`, `Hub`, `DB`, `newTestMessageService`, `VoiceDeps`, `emoji_handler_test.go`, `handleCreateEmoji`, `doRequest`, `MigrateFS`, `newOverrideFixture`, `NewRegistry`, `voice_moderation_test.go`, `newRoleCRUDService`, `PermissionService`, `newDeafenRaceDB`, `gif_handler_test.go`, `middleware_and_spawn_test.go`, `newPurgeService`, `handleVoiceTokenRefreshV2`, `newChannelTestAPI`, `handleLogStream`, `handleSetup`, `newTestPermService`, `handlers_backup.go`, `newDMFixture`, `run`, `newUserSvc`, `plugins_handler_test.go`, `User`, `AuditWriter`, `New`, `countingReadStateStore`, `groupDMFixture`, `newTokenTestDB`, `newBlockService`, `TestMigrate_UpgradeFromMigration019PreservesData`, `TestChannelVisibility_RESTWSAgreement`, `openFileDB`, `errDMParticipantsStore`, `setupDiagnosticsRouter`, `TestHandleVoiceCameraV2_RefusedWhenScreenshareSlotFull`, `errDMChannelIDsStore`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `installTestPlugin()` connect `newMigratedTestDB` to `testing.T`, `context.Context`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `mustSetSetting()` connect `chdirTemp` to `testing.T`, `context.Context`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Are the 281 inferred relationships involving `waitRegistered()` (e.g. with `TestChannelFocus_AdminBypassesDeny()` and `TestChannelFocus_AllowedByDefault()`) actually correct?**
  _`waitRegistered()` has 281 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `NewTestClientWithUser()` (e.g. with `TestRefreshChannelVisibility_ReconnectDuringFanOutActsOnLiveClient()` and `TestHandleReconnect_VisibilityChangeDuringHandshake_ForcesFullReady()`) actually correct?**
  _`NewTestClientWithUser()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `OC-0012 — low — CleanupVoiceForChannel never clears voiceKeyHolders`, `OC-0058 — low — Unban emits no WS event — *ws.Hub does not implement memberUnbanBroadcaster`, `OC-0081 — low — voice_max_video cap counts the requester's own camera row, so a user whose server-side camera flag is already 1 can never re-enable` to the rest of the system?**
  _1822 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `dispatcher.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.014710957722174288 - nodes in this community are weakly interconnected._