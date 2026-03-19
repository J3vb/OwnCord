# Client Code Review Findings

Date: 2026-03-16

Scope: `Client/tauri-client/src`

## High

- Auth token is never set in `authStore` after login. The `auth_ok` handler calls `setAuth(authStore.getState().token ?? "", ...)`, so the store token becomes an empty string. Any future logic that relies on `authStore.token` (re-auth, API helpers, telemetry) will be wrong. File: `Client/tauri-client/src/lib/dispatcher.ts`.
- If Tauri APIs are unavailable, `ws.connect` logs an error and returns early but leaves the connection state as `connecting` and never schedules a retry or notifies the UI. This can hang the client in a pseudo-connecting state in browser/test contexts. File: `Client/tauri-client/src/lib/ws.ts`.

## Medium

- Server-driven voice disconnects do not clear `currentChannelId`. The dispatcher handles `voice_leave` by removing users only; it does not call `leaveVoiceChannel()` when the current user is removed, so the voice widget can stay visible after kicks/disconnects. Files: `Client/tauri-client/src/lib/dispatcher.ts`, `Client/tauri-client/src/stores/voice.store.ts`, `Client/tauri-client/src/components/VoiceWidget.ts`.
- Theme/font-size/compact-mode preferences are applied only when the Settings overlay is opened. On app start, stored preferences are not applied, causing UI to render in default theme until the user opens Settings. File: `Client/tauri-client/src/components/SettingsOverlay.ts`.

## Low

- Infinite scroll throttling in the message list uses a fixed `500ms` timeout to reset `loadingOlder`, independent of the fetch completion. On slow responses this can trigger overlapping loads or repeated requests. File: `Client/tauri-client/src/components/MessageList.ts`.
