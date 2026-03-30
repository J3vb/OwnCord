<!-- Generated: 2026-03-30 | Files scanned: 203 | Token estimate: ~800 -->

# TypeScript Frontend Codemap

## Source Stats
- 110 source files, ~25,451 lines
- Vanilla TypeScript (no framework), imperative DOM

## Page Tree
```
main.ts (463 lines) -- entry point, router setup
  ConnectPage.ts (290)
    connect-page/LoginForm.ts (642)
    connect-page/ServerPanel.ts (345)
  MainPage.ts (468)
    main-page/SidebarArea.ts (919) -- unified 240px sidebar
    main-page/SidebarDmSection.ts (151)
    main-page/SidebarDmHelpers.ts (138)
    main-page/SidebarMemberSection.ts (176)
    main-page/ChatArea.ts (142)
    main-page/ChatHeader.ts (80)
    main-page/ChannelController.ts (298)
    main-page/MessageController.ts (132)
    main-page/ReactionController.ts (134)
    main-page/VoiceCallbacks.ts (140)
    main-page/VideoModeController.ts (189)
    main-page/OverlayManagers.ts (329)
    main-page/MemberPickerModal.ts (105)
```

## Stores (stores/)
| File | Lines | Key Exports |
|------|-------|-------------|
| messages.store.ts | 358 | addMessage, editMessage, deleteMessage, updateReaction, confirmSend |
| voice.store.ts | 312 | joinVoiceChannel, leaveVoiceChannel, setVoiceStates, updateVoiceState, setSpeakers |
| channels.store.ts | 216 | setChannels, addChannel, updateChannel, removeChannel, setActiveChannel, incrementUnread |
| ui.store.ts | 199 | setTransientError, UI flags and layout state |
| members.store.ts | 193 | setMembers, addMember, removeMember, updatePresence, setTyping |
| dm.store.ts | 102 | setDmChannels, addDmChannel, removeDmChannel, updateDmLastMessage |
| auth.store.ts | 70 | setAuth, clearAuth |
| roles.store.ts | 29 | role list state |

## Core Services (lib/)
| File | Lines | Purpose |
|------|-------|---------|
| livekitSession.ts | 1171 | LiveKit facade: connect, disconnect, device switch, token refresh |
| api.ts | 573 | REST client (fetch wrapper, all /api/v1/* calls) |
| ws.ts | 498 | WS client: connect, send, reconnect with last_seq |
| audioPipeline.ts | 398 | AudioWorklet VAD, gain, noise gate |
| dispatcher.ts | 396 | WS message -> store action mapping (all 27 server msg types) |
| profiles.ts | 448 | Server profile CRUD, auto-login, credential storage |
| types.ts | 632 | Shared TypeScript interfaces and type guards |
| media-visibility.ts | 324 | Intersection Observer for lazy media loading |
| connectionStats.ts | 234 | WebRTC stats polling (2s), quality indicator |
| audioElements.ts | 221 | Audio element pool for participant playback |
| noise-suppression.ts | 274 | RNNoise WASM integration |
| icons.ts | 277 | SVG icon library |
| deviceManager.ts | ~200 | Mic/speaker enumeration, hot-swap fallback |
| themes.ts | ~180 | Theme manager: built-in + custom JSON import/export |
| notifications.ts | ~170 | Desktop notifications + taskbar flash |
| ptt.ts | ~150 | Push-to-talk wiring (delegates to Rust PTT) |
| credentials.ts | ~120 | IPC bridge to Rust Windows Credential Manager |
| tenor.ts | ~100 | GIF picker (Tenor API v2) |
| toast.ts | ~80 | Toast notification system |
| store.ts | ~60 | Generic reactive store pattern (subscribe/getState) |
| disposable.ts | ~50 | Resource cleanup pattern |
| rate-limiter.ts | ~50 | Client-side rate limiting |
| router.ts | ~40 | Simple page router |

## Components (components/)
| File | Lines | Purpose |
|------|-------|---------|
| ChannelSidebar.ts | 836 | Legacy sidebar (superseded by SidebarArea) |
| MessageList.ts | 629 | Virtual scroll message list |
| MessageInput.ts | 517 | Rich input: replies, attachments, GIF/emoji picker |
| VoiceWidget.ts | 386 | Voice controls, timer, connection quality |
| EmojiPicker.ts | 326 | Emoji grid with search |
| SettingsOverlay.ts | 322 | Settings panel shell + tab routing |
| VideoGrid.ts | 292 | Video tile layout |
| VoiceChannel.ts | 243 | Voice channel user list with states |
| SearchOverlay.ts | 229 | Full-text search UI |
| settings/AccountTab.ts | 662 | Account, 2FA, avatar, delete |
| settings/VoiceAudioTab.ts | 447 | Audio device config, noise suppression |
| settings/AdvancedTab.ts | 282 | Cache clear, devtools, diagnostics |
| settings/LogsTab.ts | 281 | Log viewer + export |
| settings/AppearanceTab.ts | 227 | Theme, accent color, compact mode |
| message-list/renderers.ts | 284 | Message DOM rendering |
| message-list/attachments.ts | 387 | File attachment display |
| message-list/embeds.ts | 345 | URL preview embeds |
| message-list/media.ts | 479 | Image/video inline display |

## WS Dispatch Flow (dispatcher.ts)
```
ws.on("ready")         -> channels/members/voice/dm bulk load
ws.on("chat_message")  -> messages.addMessage() + notifications.ts
ws.on("voice_state")   -> voice.updateVoiceState()
ws.on("voice_token")   -> livekitSession.handleVoiceToken()
ws.on("presence")      -> members.updatePresence()
ws.on("channel_*")     -> channels.add/update/remove
ws.on("member_*")      -> members.add/update/remove
ws.on("dm_channel_*")  -> dm.add/remove
```
