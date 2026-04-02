---
date: 2026-04-01
severity: "high"
status: "fixed"
---

# BUG-098: Reconnect leaks manual camera/screenshare tracks

## Description

When an unexpected disconnect triggers auto-reconnect, the `teardownForReconnect()` path only tears down the audio pipeline and token timer. It never stops `manualCameraTrack` or `manualScreenTracks`. The `stopManualCameraTrack` / `stopManualScreenTracks` helpers also early-return when `room === null`, which it is by the time reconnect begins.

## Steps to Reproduce

1. Join a voice channel with camera or screenshare enabled
2. Trigger an unexpected disconnect (e.g. network drop)
3. Auto-reconnect fires

## Expected Behavior

Camera/screenshare local capture stops on disconnect. If reconnect succeeds, user re-enables manually or state is restored.

## Actual Behavior

Old `MediaStreamTrack` objects keep capturing from camera/screen indefinitely. The new room never republishes them. Camera light stays on even though the user appears to have no camera in the new session.

## Environment

- **OS:** Windows
- **Client:** Tauri v2
- **Files:** `roomEventHandlers.ts:160-190`, `livekitSession.ts:221-283`, `screenShare.ts:96-107,174-186`

## Root Cause

`handleDisconnected` → `teardownForReconnect()` only handles audio. Manual video track cleanup is only in `leaveVoice()`, not in the reconnect path. The stop helpers no-op when `room === null`.

## Fix

Add `stopManualCameraTrack` / `stopManualScreenTracks` calls in `teardownForReconnect` (before room is nulled) or at the start of `attemptAutoReconnect`.

## Related

- [[BUG-071-voice-pipeline-cleanup-leaks]] — similar cleanup gap for audio
- Source: Copilot + Claude cross-audit 2026-04-01
