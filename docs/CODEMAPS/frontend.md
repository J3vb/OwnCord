<!-- Generated: 2026-03-20 | Files scanned: 75 TS + 9 Rust | Token estimate: ~900 -->

# Frontend Codemap (Tauri v2 Client)

## Page Flow
```
main.ts → router("connect")
  ConnectPage → login/register → wirePostAuth() → ws.connect()
    → dispatcher wires events → "ready" received
    → router.navigate("main")
  MainPage → compose sidebar + chat + voice + modals
    → logout → router.navigate("connect")
```

## Component Tree & Store Subscriptions
```
MainPage
  ├─ ChannelSidebar ── channels.store, voice.store, auth.store, ui.store
  ├─ ChatHeader ────── channels.store
  ├─ MessageList ───── messages.store, members.store
  ├─ TypingIndicator ─ members.store
  ├─ MessageInput ──── messages.store, rate-limiter
  ├─ VoiceWidget ───── voice.store, channels.store
  ├─ VideoGrid ─────── voice.store (camera-filtered subscription)
  ├─ MemberList ────── members.store
  ├─ UserBar ───────── auth.store
  └─ SettingsOverlay ─ auth.store, ui.store, voice.store
```

## WS Dispatch Flow (dispatcher.ts)
```
ws.on("ready")         → channels/members/voice bulk load
ws.on("chat_message")  → messages.addMessage() + notifications.ts
ws.on("voice_state")   → voice.updateVoiceState()
ws.on("voice_token")   → livekitSession.handleVoiceToken()
ws.on("voice_leave")   → voice.removeVoiceUser()
ws.on("presence")      → members.updatePresence()
ws.on("channel_*")     → channels.add/update/remove
ws.on("member_*")      → members.add/update/remove
```

## LiveKit Voice Flow (livekitSession.ts)
```
handleVoiceToken(token, url, channelId)
  → Room.connect(wss://host/livekit, token)
  → publishMic (optional RNNoise WASM)
  → startSpeakingPoll (100ms, Web Audio AnalyserNode)
  → onTrackSubscribed → <audio> elements (remote audio)
  → onTrackSubscribed → VideoGrid callback (remote video)

enableCamera() → setCameraEnabled(true) [optimistic UI]
disableCamera() → setCameraEnabled(false)
leaveVoice() → room.disconnect() + cleanup
```

## State Stores (lib/store.ts pattern)

| Store | Key Fields |
|-------|------------|
| auth | token, user, serverName, isAuthenticated |
| channels | channels: Map, activeChannelId |
| messages | messagesByChannel: Map, pendingSends, hasMore |
| members | members: Map, typingBy: Set |
| voice | currentChannelId, voiceUsers: Map<ch, Map<uid, VoiceUser>>, localMuted/Deafened/Camera |
| ui | theme, connectionStatus, collapsedCategories, activeModal |

## Rust Backend (src-tauri/src/)

| File | Tauri Commands |
|------|----------------|
| commands.rs | get_settings, save_settings (key allowlist), store/get_cert_fingerprint, open_devtools |
| credentials.rs | save/load/delete_credential (Windows Credential Manager) |
| ws_proxy.rs | ws_connect, ws_send, ws_disconnect, accept_cert_fingerprint |
| ptt.rs | ptt_start/stop/set_key/get_key, ppt_listen_for_key (GetAsyncKeyState) |
| update_commands.rs | check_client_update, download_and_install_update |
