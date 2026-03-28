# Voice Chat Implementation -- LiveKit Architecture

**Date:** 2026-03-20 (LiveKit migration)
**Updated:** 2026-03-28
**Status:** Active
**Branch:** feature/livekit-migration

**Related specs:**
- [[PROTOCOL]] -- WebSocket message types for voice signaling
- [[CLIENT-ARCHITECTURE]] -- Client-side component and store structure
- [[CHATSERVER]] -- Server configuration and security

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [LiveKit Server Integration](#livekit-server-integration)
3. [Voice Join Flow End-to-End](#voice-join-flow-end-to-end)
4. [LiveKit TLS Proxy](#livekit-tls-proxy)
5. [Token Management](#token-management)
6. [Audio Pipeline](#audio-pipeline)
7. [Push-to-Talk](#push-to-talk)
8. [Voice Activity Detection (VAD)](#voice-activity-detection-vad)
9. [Noise Suppression](#noise-suppression)
10. [Video Support](#video-support)
11. [Screen Sharing](#screen-sharing)
12. [Connection Quality Monitoring](#connection-quality-monitoring)
13. [Voice Widget UI](#voice-widget-ui)
14. [Voice Store State Management](#voice-store-state-management)
15. [Speaking Indicators](#speaking-indicators)
16. [Audio Device Selection](#audio-device-selection)
17. [Volume Control](#volume-control)
18. [Error Handling and Recovery](#error-handling-and-recovery)
19. [Voice Leave and Cleanup](#voice-leave-and-cleanup)
20. [LiveKit Webhooks](#livekit-webhooks)
21. [Complete Session Data Flow](#complete-session-data-flow)

---

## Architecture Overview

OwnCord uses **LiveKit** as a companion SFU (Selective Forwarding
Unit) process running alongside `chatserver.exe`. The OwnCord
server handles signaling (join/leave/state) over WebSocket, while
LiveKit handles all WebRTC media transport.

```
+-------------------+       WSS (via Rust proxy)       +------------------+
|   Tauri Client    |<-------------------------------->| OwnCord Server   |
|                   |                                  |   (chatserver)   |
|  +-----------+    |                                  |                  |
|  | WebView2  |    |   WS/WSS (LiveKit signal)        |  +-----------+  |
|  | (TS/HTML) |<---|--------------------------------->|  | LiveKit   |  |
|  |           |    |   (via TLS proxy on remote,      |  | Server    |  |
|  | livekit-  |    |    or direct on localhost)        |  | (SFU)     |  |
|  | client SDK|    |                                  |  +-----------+  |
|  +-----------+    |   UDP (RTP media)                |                  |
|                   |<-------------------------------->|  Ports 50000-    |
|  +-----------+    |                                  |  60000           |
|  | Rust      |    |                                  |                  |
|  | Backend   |    |                                  +------------------+
|  | - PTT     |    |
|  | - TLS     |    |
|  |   proxy   |    |
|  +-----------+    |
+-------------------+
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| SFU | LiveKit (not custom Pion) | Production-grade, handles scaling, speaker detection, simulcast natively |
| Signaling | OwnCord WS + LiveKit token | Server generates JWT, client connects directly to LiveKit |
| TLS for LiveKit | Local Rust TCP proxy | WebView2 rejects self-signed certs on LiveKit's WS |
| Speaker detection | Client-side (LiveKit SDK) | Lower latency than server-side webhooks |
| Audio pipeline | Web Audio API GainNode chain | Input volume, VAD gating, and sender replacement |
| Noise suppression | RNNoise WASM (optional) | LiveKit TrackProcessor API |
| PTT | Rust GetAsyncKeyState | Global, non-consuming key detection |
| Video quality | Configurable presets (low/medium/high/source) | User preference, stored in `streamQuality` pref |

### Component Map

```
Server (Go)                          Client (TypeScript/Rust)
-----------                          -----------------------
ws/livekit.go        LiveKitClient   lib/livekitSession.ts   LiveKitSession
  - GenerateToken()                    - handleVoiceToken()
  - RemoveParticipant()                - leaveVoice()
  - HealthCheck()                      - setMuted/Deafened()
  - RoomName()                         - enableCamera/Screenshare()
                                       - audio pipeline
ws/livekit_process.go LiveKitProcess   - VAD polling
  - Start/Stop()                       - token refresh
  - generateConfig()
  - runLoop() + restart              lib/connectionStats.ts  StatsPoller
  - HealthCheck()                      - poll WebRTC stats
                                       - quality from RTT
ws/livekit_webhook.go
  - participant_joined               lib/noise-suppression.ts
  - participant_left                   - RNNoise WASM processor
    (crash recovery)
                                     src-tauri/src/ptt.rs
ws/voice_join.go                       - GetAsyncKeyState polling
ws/voice_leave.go                      - ptt-state events
ws/voice_controls.go
ws/voice_broadcast.go                src-tauri/src/livekit_proxy.rs
                                       - TCP-to-TLS proxy
stores/voice.store.ts                  - header rewriting
  - voiceUsers                         - bidirectional copy
  - voiceConfigs
  - localMuted/Deafened
  - joinedAt (timer)
```

---

## LiveKit Server Integration

### Companion Process (livekit_process.go)

The `LiveKitProcess` struct manages a `livekit-server` binary
running as a child process of `chatserver.exe`. If
`voice.livekit_binary_path` is empty in config, LiveKit is
assumed to be managed externally.

#### Auto-Generated Config

The process manager generates a minimal `livekit.yaml` in the
data directory:

```yaml
# Auto-generated by OwnCord -- do not edit manually.
port: 7880

rtc:
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
  pli_throttle:
    low_quality: 500ms
    mid_quality: 1s
    high_quality: 1s

keys:
  "api-key-here": "api-secret-here"

logging:
  level: info
```

Config security: credentials are validated for unsafe YAML
characters (`:`, `#`, `{`, `}`, newlines, quotes, backslashes)
before interpolation.

#### Process Lifecycle

```
Start()
  |
  v
runLoop(ctx, cfgPath)
  |
  +---> exec.Command("livekit-server", "--config", cfgPath)
  |       |
  |       v
  |     cmd.Run() blocks until process exits
  |       |
  |       v
  |     Exit reason?
  |       |
  |       +--> ctx cancelled or stopped -> return
  |       |
  |       +--> rapid failure (exited < 30s)
  |       |      rapidFailures++
  |       |      if >= 10 -> give up permanently
  |       |      wait: 3s -> 6s -> 12s -> ... -> 60s (exp backoff)
  |       |
  |       +--> stable exit (ran > 30s)
  |              reset rapidFailures, delay = 3s
  |              restart immediately after delay
  +---> loop
```

| Parameter | Value |
|-----------|-------|
| Base restart delay | 3 seconds |
| Max restart delay | 60 seconds |
| Max rapid failures | 10 (gives up permanently) |
| Stable threshold | 30 seconds |
| WaitDelay (Windows) | 6 seconds |

#### Health Checks

Two health check mechanisms:
1. **SDK-level** (`LiveKitClient.HealthCheck`): Lists rooms via
   LiveKit's REST API. 3-second timeout.
2. **HTTP probe** (`LiveKitProcess.HealthCheck`): HTTP GET to
   LiveKit's port. 3-second timeout.

### LiveKit Client (livekit.go)

The `LiveKitClient` wraps the `livekit-server-sdk-go` for:

- **Token generation** (`GenerateToken`)
- **Participant removal** (`RemoveParticipant`)
- **Room listing** (`ListParticipants`)
- **Video track counting** (`CountVideoTracks`)

#### Room Naming Convention

```go
func RoomName(channelID int64) string {
    return fmt.Sprintf("channel-%d", channelID)
}
```

Channel 10 -> LiveKit room `"channel-10"`.

#### Participant Identity Convention

```go
identity := fmt.Sprintf("user-%d", userID)
```

User 42 -> LiveKit identity `"user-42"`. The client parses this
back with:

```typescript
function parseUserId(identity: string): number {
  const match = identity.match(/^user-(\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : 0;
}
```

#### Credential Validation

The `NewLiveKitClient` constructor rejects:
- Empty `api_key` or `api_secret`
- Empty `url`
- Default dev credentials (`config.IsDefaultVoiceCredentials`)

---

## Voice Join Flow End-to-End

### Sequence Diagram

```
User clicks     Client (TS)           WS (Go)              LiveKit
"Join Voice"        |                    |                     |
    |               |                    |                     |
    +-- ws.send({   |                    |                     |
    |   type:"voice_join",               |                     |
    |   payload:{channel_id:10}          |                     |
    |   }) --------->|                   |                     |
    |               |--- voice_join ---->|                     |
    |               |                    |-- check CONNECT_VOICE perm
    |               |                    |-- validate channel exists
    |               |                    |-- check LiveKit running
    |               |                    |-- if in other channel: leave
    |               |                    |-- check capacity
    |               |                    |-- db.JoinVoiceChannel()
    |               |                    |                     |
    |               |                    |-- GenerateToken() ->|
    |               |                    |   (canPublish based |
    |               |                    |    on SPEAK_VOICE)   |
    |               |                    |<-- JWT token --------|
    |               |                    |                     |
    |               |<-- voice_token ----|                     |
    |               |    {token, url,    |                     |
    |               |     direct_url}    |                     |
    |               |                    |                     |
    |               |<-- voice_state ----|  (broadcast to all) |
    |               |    (joiner's state)|                     |
    |               |                    |                     |
    |               |<-- voice_state x N-|  (existing users,   |
    |               |    (per existing   |   direct to joiner) |
    |               |     participant)   |                     |
    |               |                    |                     |
    |               |<-- voice_config ---|  (direct to joiner) |
    |               |    {quality,       |                     |
    |               |     bitrate,       |                     |
    |               |     max_users}     |                     |
    |               |                    |                     |
    |               |-- resolve URL ---->|                     |
    |               |   (localhost?      |                     |
    |               |    use direct_url  |                     |
    |               |    remote?         |                     |
    |               |    start TLS proxy)|                     |
    |               |                    |                     |
    |               |-- Room.connect(url, token) ------------>|
    |               |                    |                     |
    |               |<-- connected ------|---------------------|
    |               |                    |                     |
    |               |-- setMicrophoneEnabled(true) ---------->|
    |               |   (publishes audio track)               |
    |               |                    |                     |
    |               |-- setupAudioPipeline()                  |
    |               |   (GainNode chain for volume + VAD)     |
    |               |                    |                     |
    |               |-- startTokenRefreshTimer()              |
    |               |   (3.5h timer)     |                     |
```

### Client-Side Join (livekitSession.ts handleVoiceToken)

1. **Concurrency guard:** If `connecting` is true, queue the
   join request in `pendingJoin` and return.
2. **Cleanup:** If a room already exists, call `leaveVoice(false)`.
3. **Create room:** `new Room({...options})` with quality presets.
4. **Resolve URL:** Localhost -> `directUrl`, remote -> TLS proxy.
5. **Connect with retry:** Up to 3 attempts, 2s delay between.
6. **Check for stale join:** If `pendingJoin` has a different
   channel, discard current connection and dispatch pending.
7. **Post-connect setup:**
   - `startAudio()` (optimistic autoplay unlock)
   - `restoreLocalVoiceState("join")` (mic, mute, deafen)
   - Switch to saved audio devices
   - `setupAudioPipeline()` (GainNode chain)
   - `startTokenRefreshTimer()`

---

## LiveKit TLS Proxy

### Problem

The LiveKit JS SDK opens its own WebSocket from WebView2 directly.
WebView2's native WS implementation rejects self-signed TLS
certificates, causing `"could not establish signal connection:
Failed to fetch"` on remote servers using self-signed certs.

### Solution: Rust-Side TCP-to-TLS Proxy

`src-tauri/src/livekit_proxy.rs` starts a plain TCP listener on
`127.0.0.1:0` (OS-assigned port). The LiveKit SDK connects to
`ws://127.0.0.1:{port}/livekit/...` (trusted, no TLS). The proxy
tunnels bytes to the remote server over TLS (accepting self-signed
certs via `InsecureVerifier`).

### Architecture

```
LiveKit SDK (WebView2)
    |
    | ws://127.0.0.1:{port}/livekit/...
    v
+----------------------------+
| TCP Listener (loopback)    |
| livekit_proxy.rs           |
|                            |
| 1. Read HTTP headers       |
| 2. Rewrite Host/Origin     |
|    to remote_host           |
| 3. TLS connect to remote   |
|    (InsecureVerifier)       |
| 4. Forward rewritten       |
|    request                  |
| 5. io::copy_bidirectional  |
+----------------------------+
    |
    | TLS (rustls, self-signed OK)
    v
Remote OwnCord Server :8443
    |
    | /livekit/* reverse proxy
    v
LiveKit Server :7880
```

### State Management

```rust
pub struct LiveKitProxyState {
    inner: Mutex<ProxyInner>,
}

struct ProxyInner {
    port: Option<u16>,      // Listening port (None if not running)
    remote_host: String,    // Current remote host:port
    shutdown_tx: Option<Sender<()>>,  // Shutdown signal
}
```

### Tauri Commands

| Command | Signature | Behavior |
|---------|-----------|----------|
| `start_livekit_proxy` | `(remote_host: String) -> u16` | Start proxy, return port. Reuses existing for same host. Replaces for different host. |
| `stop_livekit_proxy` | `() -> ()` | Stop proxy, clear state. |

### Header Rewriting

The proxy reads HTTP headers up to `\r\n\r\n` (max 16KB) and
rewrites:
- `Host:` -> `Host: {remote_host}`
- `Origin:` -> `Origin: https://{remote_host}`

This allows the remote server's WebSocket origin check to accept
the proxied connection.

### Security Considerations

- `InsecureVerifier` accepts ALL server certificates. This is the
  same trust model as the WS proxy but WITHOUT TOFU fingerprint
  pinning. A MitM attacker could intercept LiveKit signaling.
- Only one proxy instance per client (per remote host).
- Proxy is localhost-only, not exposed to network.

---

## Token Management

### Token Generation (Server)

```go
at := auth.NewAccessToken(apiKey, apiSecret)
grant := &auth.VideoGrant{
    RoomJoin:       true,
    Room:           "channel-{channelID}",
    CanPublish:     &canPublish,      // based on SPEAK_VOICE perm
    CanSubscribe:   &canSubscribe,    // always true
    CanPublishData: &canPublish,      // follows publish perm
}
at.SetVideoGrant(grant)
  .SetIdentity("user-{userID}")
  .SetName(username)
  .SetValidFor(4 * time.Hour)  // tokenTTL
```

### Token Refresh Cycle

```
0h         Connect with initial token
3.5h       Client sends voice_token_refresh
           Server generates new token, sends voice_token
           Client stores latestToken, restarts timer
3.5h+3.5h  Next refresh cycle...

4h         Original token would expire
           (but latestToken was refreshed at 3.5h)
```

The LiveKit SDK does NOT support rotating tokens on an active
connection. The refreshed token is stored for use on reconnection.
Active sessions survive past token expiry because LiveKit keeps
alive connections running.

### Token Refresh Rate Limit

Server: 1 per 60 seconds per user
(`voice_token_refresh:{userId}`).

---

## Audio Pipeline

### Architecture

The client builds a Web Audio API pipeline on the microphone
track to control input volume and VAD gating:

```
Raw Mic Track (MediaStreamTrack)
    |
    v
AudioContext.createMediaStreamSource()
    |
    +-----> AnalyserNode (VAD reads time-domain data here)
    |         - fftSize: 2048
    |         - smoothingTimeConstant: 0.3
    |
    +-----> GainNode (inputVolume * vadGate)
              |
              v
            MediaStreamAudioDestinationNode
              |
              v
            Adjusted Track -> replaceTrack() on WebRTC sender
```

### Key Properties

- **Always active** while in voice (not torn down on volume change).
- **VAD reads raw audio** from the AnalyserNode tap (before gain).
- **GainNode controls both** input volume and VAD gating.
- **On mute:** Pipeline is torn down entirely, mic track
  unpublished from SFU via `setMicrophoneEnabled(false)`.
- **On unmute:** Mic re-published, pipeline rebuilt.
- **On camera/screenshare publish:** Pipeline rebuilt (WebRTC
  renegotiation can reset the sender).

### Gain Calculation

```typescript
// Normal: gain = inputVolume (0-2.0)
// VAD gated: gain = 0
// Input volume: loadPref("inputVolume", 100) / 100
gainNode.gain.setTargetAtTime(effectiveGain, ctx.currentTime, 0.015);
```

### Mute Implementation

OwnCord uses "nuclear mute" -- fully unpublishing the mic track:

```typescript
async applyMicMuteState(muted: boolean) {
  if (muted) {
    this.teardownAudioPipeline();
    await this.room.localParticipant.setMicrophoneEnabled(false);
    // Track fully removed from SFU -- no audio forwarded
  } else {
    await this.room.localParticipant.setMicrophoneEnabled(true);
    this.setupAudioPipeline();
    // Track re-published, pipeline rebuilt
  }
}
```

This guarantees the SFU has no audio track to forward, unlike
`track.mute()` which may still send silence frames.

### Deafen Implementation

Deafened state:
1. Mutes local mic (same as mute).
2. Unsubscribes from all remote audio tracks:

```typescript
for (const participant of room.remoteParticipants.values()) {
  for (const publication of participant.audioTrackPublications.values()) {
    publication.setSubscribed(!deafened);
  }
}
```

WebRTC connection stays alive -- only audio subscription is affected.

---

## Push-to-Talk

### Rust Implementation (ptt.rs)

PTT uses `GetAsyncKeyState` polling on a background thread. This
is non-consuming -- other applications and the chat input continue
to receive the key normally.

```rust
// 20ms polling loop
fn is_key_down(vk: i32) -> bool {
    let state = GetAsyncKeyState(vk);
    (state as u16 & 0x8000) != 0
}
```

### State

```rust
static PTT_VKEY: AtomicI32 = AtomicI32::new(0);    // 0 = disabled
static PTT_RUNNING: AtomicBool = AtomicBool::new(false);
```

### Tauri Commands

| Command | Description |
|---------|-------------|
| `ptt_start` | Start polling loop. Emits `ptt-state` (bool) events on press/release. |
| `ptt_stop` | Stop polling loop. |
| `ptt_set_key` | Set the virtual key code. 0 = disabled. |
| `ptt_get_key` | Get current virtual key code. |
| `ptt_listen_for_key` | Wait for any non-modifier key press (10s timeout). Returns VK code or 0. |

### Key Capture Flow

```
User opens Keybinds settings
    |
    +-- Click "Record PTT Key" button
    |
    v
ptt_listen_for_key()  (Rust, blocks thread)
    |
    +-- Polls all VK codes 1-254 (excluding modifiers: 0x10-0x12, 0x5B-0x5C)
    |   20ms poll interval, 10s timeout
    |
    v
Key detected -> wait for release (5s timeout) -> return VK code
    |
    v
ptt_set_key(vk_code)  -> stored in AtomicI32
    |
    v
ptt_start()  -> spawns polling thread
    |
    +-- On press:  emit("ptt-state", true)  -> client unmutes mic
    +-- On release: emit("ptt-state", false) -> client mutes mic
```

### Modifier Keys Excluded

VK codes 0x10 (Shift), 0x11 (Ctrl), 0x12 (Alt),
0x5B/0x5C (Windows keys) are skipped during key capture to
prevent binding to modifier-only presses.

---

## Voice Activity Detection (VAD)

### Client-Side VAD (Web Audio API)

VAD is implemented as an `requestAnimationFrame` polling loop that
reads from the pipeline's `AnalyserNode`:

```typescript
private startVadPolling(): void {
  const sensitivity = loadPref("voiceSensitivity", 50);
  if (sensitivity >= 100) return;  // VAD disabled

  // Convert sensitivity to RMS threshold:
  // sensitivity 0  -> threshold 0.10 (aggressive gate)
  // sensitivity 50 -> threshold 0.05
  // sensitivity 99 -> threshold 0.001 (barely gates)
  const threshold = ((100 - sensitivity) / 100) * 0.10;

  const poll = () => {
    analyser.getFloatTimeDomainData(dataArray);
    const rms = Math.sqrt(sum(v^2) / length);

    if (rms < threshold) {
      silentFrames++;
      if (!vadGated && silentFrames >= 12) {  // ~200ms
        vadGated = true;
        gainNode.gain -> 0
      }
    } else {
      speechFrames++;
      if (vadGated && speechFrames >= 2) {  // ~33ms
        vadGated = false;
        gainNode.gain -> inputVolume
      }
    }
    requestAnimationFrame(poll);
  };
}
```

### VAD Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| AnalyserNode fftSize | 2048 | Samples per read |
| smoothingTimeConstant | 0.3 | Analyser smoothing |
| Gate-on threshold | 12 frames (~200ms) | Silent frames before muting |
| Gate-off threshold | 2 frames (~33ms) | Speech frames before unmuting |
| Startup grace | 30 frames (~500ms) | Don't gate during initial setup |
| GainNode ramp time | 0.015s | `setTargetAtTime` constant |

### Sensitivity Control

```typescript
setVoiceSensitivity(sensitivity: number): void {
  // sensitivity 0-100 stored in prefs
  // 100 = no VAD polling (disabled)
  // < 100 = restart polling with new threshold
}
```

---

## Noise Suppression

### RNNoise WASM (Optional Enhanced Mode)

OwnCord supports two noise suppression modes:

1. **Browser-native** (`noiseSuppression: true` in
   `getUserMedia` constraints) -- always on by default.
2. **Enhanced (RNNoise)** -- optional WASM-based processor via
   LiveKit's `TrackProcessor` API.

```typescript
// Enable RNNoise
const processor = createRNNoiseProcessor();
await micPub.track.setProcessor(processor);

// Disable RNNoise
await micPub.track.stopProcessor();
```

RNNoise is toggled via the `enhancedNoiseSuppression` preference.
When switching audio input devices, the processor is re-applied or
removed based on the current setting.

---

## Video Support

### Camera

The client manually creates and publishes video tracks (not using
LiveKit's `setCameraEnabled`) for full control over quality:

```typescript
async enableCamera(): Promise<void> {
  const quality = getStreamQuality();
  const videoTrack = await createLocalVideoTrack({
    ...CAMERA_PRESETS[quality],
    ...(savedVideoDevice ? { deviceId: savedVideoDevice } : {}),
  });
  this.manualCameraTrack = videoTrack;
  await room.localParticipant.publishTrack(videoTrack, {
    source: Track.Source.Camera,
    simulcast: quality !== "source",
    videoEncoding: { maxBitrate, maxFramerate },
  });
  ws.send({ type: "voice_camera", payload: { enabled: true } });
}
```

### Camera Quality Presets

| Preset | Resolution | Max Bitrate | Max FPS | Simulcast |
|--------|-----------|-------------|---------|-----------|
| low | 360p | 600 kbps | 15 | Yes |
| medium | 720p | 1.7 Mbps | 30 | Yes |
| high | 1080p | 4 Mbps | 30 | Yes |
| source | 1080p | 8 Mbps | 30 | No |

### Server-Side Video Limits

When enabling camera, the server checks `voice_max_video` on the
channel. If exceeded, returns `VIDEO_LIMIT` error. The count is
done via SQLite (`CountActiveCameras`) for race-free enforcement.

### Remote Video Handling

```typescript
handleTrackSubscribed(track, publication, participant) {
  if (track.kind === Track.Kind.Video) {
    const stream = new MediaStream([track.mediaStreamTrack]);
    const isScreenshare = publication.source === Track.Source.ScreenShare;
    onRemoteVideoCallback(userId, stream, isScreenshare);
  }
}
```

The `onRemoteVideoCallback` is set by the `VideoGrid` component
to render remote video streams.

---

## Screen Sharing

### Implementation

```typescript
async enableScreenshare(): Promise<void> {
  const quality = getStreamQuality();
  const screenTracks = await createLocalScreenTracks(
    SCREENSHARE_PRESETS[quality]
  );
  // screenTracks may include both video and audio tracks
  for (const track of screenTracks) {
    const isVideo = track.kind === Track.Kind.Video;
    await room.localParticipant.publishTrack(track, {
      source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
      simulcast: false,  // Full quality for screenshare
      ...(isVideo ? { videoEncoding: { maxBitrate, maxFramerate } } : {}),
    });
  }
  ws.send({ type: "voice_screenshare", payload: { enabled: true } });
}
```

### Screenshare Quality Presets

| Preset | Resolution | Audio | Max Bitrate | Content Hint |
|--------|-----------|-------|-------------|-------------|
| low | 720p@5fps | Yes | 1.5 Mbps | -- |
| medium | 1080p@15fps | Yes | 3 Mbps | detail |
| high | 1080p@30fps | Yes | 6 Mbps | detail |
| source | native | Yes | 10 Mbps | detail |

### Screenshare Audio

Screenshare audio tracks are managed separately from microphone
audio. They use `HTMLAudioElement` volume (not
`participant.setVolume`) and have independent mute state tracked
per user:

```typescript
private screenshareAudioElements = new Map<number, Set<HTMLAudioElement>>();
private screenshareAudioMutedByUser = new Map<number, boolean>();
```

---

## Connection Quality Monitoring

### connectionStats.ts

Polls WebRTC stats from the LiveKit Room's peer connections every
2 seconds.

```typescript
const POLL_INTERVAL_MS = 2000;

interface ConnectionStats {
  rtt: number;           // Round-trip time in ms
  quality: QualityLevel; // "excellent" | "fair" | "poor" | "bad"
  outRate: number;       // Outbound bytes/sec
  inRate: number;        // Inbound bytes/sec
  outPackets: number;    // Total outbound packets
  inPackets: number;     // Total inbound packets
  totalUp: number;       // Total bytes uploaded
  totalDown: number;     // Total bytes downloaded
}
```

### Quality Levels

| Level | RTT Range | Color (UI) |
|-------|-----------|-----------|
| excellent | < 100ms | Green |
| fair | 100-199ms | Yellow |
| poor | 200-399ms | Orange/Red |
| bad | >= 400ms | Red |

### Stats Collection

Accesses LiveKit SDK internals to get raw `RTCPeerConnection` objects:

```typescript
async function collectAllStats(room: Room): Promise<RTCStatsReport[]> {
  const engine = room.engine;
  const pcManager = engine.pcManager;
  // Collect from both publisher and subscriber PeerConnections
  const reports = [];
  if (pcManager?.publisher?.pc) reports.push(await pc.getStats());
  if (pcManager?.subscriber?.pc) reports.push(await pc.getStats());
  return reports;
}
```

Extracts from WebRTC stats:
- `candidate-pair.currentRoundTripTime` -> RTT
- `candidate-pair.bytesSent/bytesReceived` -> session totals
- `outbound-rtp.packetsSent/bytesSent` -> outbound metrics
- `inbound-rtp.packetsReceived/bytesReceived` -> inbound metrics

### Rate Calculation

```typescript
outRate = (currentOutBytes - prevOutBytes) / elapsedSeconds;
inRate = (currentInBytes - prevInBytes) / elapsedSeconds;
```

### UI Integration

The `VoiceWidget` header shows a signal-bars icon with ping text.
Clicking expands a transport statistics pane showing outgoing/
incoming rates, packets, RTT, and session totals.

---

## Voice Widget UI

The `VoiceWidget` component (in the sidebar) shows:

```
+------------------------------------------+
| # voice-chat  | [signal bars] 45ms       |
+------------------------------------------+
| @alex (you)  [speaking indicator]        |
| @jordan                                  |
| @morgan      [muted icon]               |
+------------------------------------------+
| [Mic] [Deafen] [Camera] [Screen] [Leave] |
+------------------------------------------+
| Connected | 05:23                         |
+------------------------------------------+
```

### Voice Call Duration Timer

Stored as `joinedAt: number | null` (epoch ms) in
`voice.store.ts`. Set on `joinVoiceChannel()`, cleared on
`leaveVoiceChannel()`.

Rendered by a 1-second `setInterval` in the VoiceWidget:

```
Elapsed = Date.now() - joinedAt
Format: MM:SS (under 1 hour) or HH:MM:SS (1 hour+)
```

Timer is local-only (each user sees their own elapsed time).
Resets on leave or disconnect.

---

## Voice Store State Management

### Store Shape (voice.store.ts)

```typescript
interface VoiceState {
  currentChannelId: number | null;
  voiceUsers: Map<number, Map<number, VoiceUser>>;  // channelId -> userId -> VoiceUser
  voiceConfigs: Map<number, VoiceConfig>;            // channelId -> VoiceConfig
  localMuted: boolean;
  localDeafened: boolean;
  localCamera: boolean;
  localScreenshare: boolean;
  joinedAt: number | null;  // epoch ms for timer
}

interface VoiceUser {
  userId: number;
  username: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  camera: boolean;
  screenshare: boolean;
}
```

### Store Actions

| Action | Trigger | Description |
|--------|---------|-------------|
| `setVoiceStates(states)` | `ready` payload | Bulk set from initial state |
| `updateVoiceState(payload)` | `voice_state` event | Add/update single user |
| `removeVoiceUser(payload)` | `voice_leave` event | Remove user from channel |
| `joinVoiceChannel(channelId)` | `voice_config` received | Set current channel + timestamp |
| `leaveVoiceChannel()` | Leave button, disconnect | Clear current channel + timer |
| `setLocalMuted(bool)` | Mic button, PTT | Toggle local mute |
| `setLocalDeafened(bool)` | Deafen button | Toggle local deafen |
| `setLocalCamera(bool)` | Camera enable/disable | Toggle camera state |
| `setLocalScreenshare(bool)` | Screen enable/disable | Toggle screenshare state |
| `setSpeakers(payload)` | `ActiveSpeakersChanged` | Update speaking flags for all users |
| `setVoiceConfig(payload)` | `voice_config` event | Store quality/bitrate/max_users |

All updates are immutable (new Map instances via spread).

---

## Speaking Indicators

### LiveKit-Based Detection

Speaker detection uses LiveKit SDK's built-in
`RoomEvent.ActiveSpeakersChanged`:

```typescript
private handleActiveSpeakersChanged = (speakers: Participant[]): void => {
  const speakerIds = speakers
    .map(s => parseUserId(s.identity))
    .filter(id => id > 0)
    .sort();
  setSpeakers({ channel_id: this.currentChannelId, speakers: speakerIds });
};
```

This replaces the old server-side RFC 6464 audio level parsing.
Client-side detection has lower latency (no round-trip to server).

### Store Update

`setSpeakers` iterates ALL users in the channel and sets
`speaking = true` for those in the speaker list, `false` for
others. This is a complete replacement, not a delta.

---

## Audio Device Selection

### Input/Output Device Switching

```typescript
async switchInputDevice(deviceId: string): Promise<void> {
  await room.switchActiveDevice("audioinput", deviceId);
  // Rebuild audio pipeline (source track changed)
  this.setupAudioPipeline();
  // Re-apply RNNoise if enabled
}

async switchOutputDevice(deviceId: string): Promise<void> {
  await room.switchActiveDevice("audiooutput", deviceId);
}
```

### Saved Preferences

| Preference Key | Default | Used By |
|----------------|---------|---------|
| `audioInputDevice` | `""` (system default) | Mic selection |
| `audioOutputDevice` | `""` (system default) | Speaker/headphone selection |
| `videoInputDevice` | `""` (system default) | Camera selection |

On voice join, saved devices are applied via
`room.switchActiveDevice`.

### Audio Processing Settings

| Preference | Default | Description |
|-----------|---------|-------------|
| `echoCancellation` | true | Browser echo cancellation |
| `noiseSuppression` | true | Browser noise suppression |
| `autoGainControl` | true | Browser auto gain control |
| `enhancedNoiseSuppression` | false | RNNoise WASM processor |

Changes applied via `reapplyAudioProcessing()` which calls
`track.restartTrack(newConstraints)` without unpublishing.

---

## Volume Control

### Input Volume

```typescript
setInputVolume(volume: number): void {
  // volume: 0-200 (stored as preference)
  this.currentInputGain = volume / 100;  // 0.0-2.0
  this.updatePipelineGain();  // updates GainNode
}
```

### Output Volume

```typescript
setOutputVolume(volume: number): void {
  // volume: 0-200 (stored as preference)
  this.outputVolumeMultiplier = volume / 100;  // 0.0-2.0
  this.applyAllVolumes();  // updates all participant volumes
}
```

### Per-User Volume

```typescript
setUserVolume(userId: number, volume: number): void {
  // volume: 0-200
  savePref(`userVolume_${userId}`, volume);
  participant.setVolume((volume / 100) * outputVolumeMultiplier);
}
```

Effective volume = `(perUserVolume / 100) * outputVolumeMultiplier`.
LiveKit's `participant.setVolume()` uses a `GainNode` internally
and supports 0-2.0 range.

### Screenshare Audio Volume

Managed separately via `HTMLAudioElement.volume` (0.0-1.0 range):

```typescript
setScreenshareAudioVolume(userId, volume);  // 0-1
muteScreenshareAudio(userId, muted);        // independent per-user
```

---

## Error Handling and Recovery

> The LiveKit auto-reconnect flow is also documented in
> [[RECONNECTION]] section 7. That spec is the canonical reference
> for reconnection logic; this section focuses on the broader
> error handling context.

### Microphone Errors

| Error | Behavior |
|-------|----------|
| `NotAllowedError` | "Microphone permission denied -- joined in listen-only mode" |
| `NotFoundError` | "No microphone found -- joined in listen-only mode" |
| Other DOMException | "Microphone unavailable -- joined in listen-only mode" |

Listen-only mode: user hears others but doesn't transmit audio.
The LiveKit connection works normally, just without a published
mic track.

### Camera Errors

| Error | Behavior |
|-------|----------|
| `NotAllowedError` | "Camera permission denied" |
| `NotFoundError` | "No camera found" |
| Server `VIDEO_LIMIT` | "maximum N video streams reached" |
| Other | "Failed to start camera" |

Camera state is rolled back on error (`setLocalCamera(false)`).

### Connection Errors

| Scenario | Behavior |
|----------|----------|
| LiveKit connect fails (up to 3 retries) | 2s delay between retries, then error toast |
| Unexpected disconnect | Auto-reconnect (2 attempts, 3s delay each) |
| Auto-reconnect exhausted | Send `voice_leave` to server, show error toast |
| User leaves during auto-reconnect | AbortController cancels reconnect loop |

### Auto-Reconnect Flow

```
handleDisconnected(reason)
  |
  +-- reason === CLIENT_INITIATED? -> leaveVoice() -> done
  |
  +-- unexpected disconnect
       |
       +-- has latestToken, currentChannelId, lastUrl?
       |     |
       |     v
       |   teardown current room (keep WS alive)
       |   reconnectAc = new AbortController()
       |   attemptAutoReconnect(token, url, channelId)
       |     |
       |     v
       |   for attempt 1..2:
       |     wait 3s (abort if user leaves)
       |     create new Room
       |     Room.connect(url, token)
       |     on success:
       |       restoreLocalVoiceState("reconnect")
       |       setupAudioPipeline()
       |       requestTokenRefresh()
       |       return
       |     on failure:
       |       cleanup room, continue loop
       |
       |   all attempts failed:
       |     leaveVoice(sendWs=true)  // tell server
       |     onError("Voice connection lost -- failed to reconnect")
       |
       +-- no stored state? -> leaveVoice() -> error toast
```

### LiveKit Process Crash

If the managed LiveKit process crashes:
- The `runLoop` restarts it with exponential backoff.
- After 10 rapid failures, it gives up.
- `voice_join` checks `lkProcess.IsRunning()` and returns
  `VOICE_ERROR` if LiveKit is down.

---

## Voice Leave and Cleanup

### leaveVoice(sendWs = true)

```typescript
leaveVoice(sendWs = true): void {
  // 1. Cancel pending auto-reconnect
  reconnectAc?.abort();

  // 2. Clear timers
  clearTokenRefreshTimer();
  teardownAudioPipeline();
  removeAutoplayUnlock();
  pendingJoin = null;

  // 3. Stop manually published tracks
  manualCameraTrack?.stop();
  for (const t of manualScreenTracks) t.stop();

  // 4. Send voice_leave to server (if sendWs=true)
  ws.send({ type: "voice_leave", payload: {} });

  // 5. Clean up remote audio elements
  for (const el of remoteMicAudioElements.values()) el.remove();
  for (const audioEls of screenshareAudioElements.values())
    for (const el of audioEls) el.remove();

  // 6. Disconnect LiveKit room
  room.removeAllListeners();
  room.disconnect();
  room = null;

  // 7. Reset state
  currentChannelId = null;
  latestToken = null;
  setLocalCamera(false);
  setLocalScreenshare(false);
}
```

### Server-Side Leave (voice_leave.go)

```go
func (h *Hub) handleVoiceLeave(c *Client) {
  oldChID := c.clearVoiceChID()
  if oldChID == 0 { return }  // no-op

  db.LeaveVoiceChannel(c.userID)       // DB cleanup
  BroadcastToAll(buildVoiceLeave(...)) // Notify all clients
  livekit.RemoveParticipant(...)       // Best-effort SFU cleanup
}
```

Also called automatically in `readPump` defer (on disconnect).

### cleanupAll()

Full cleanup on logout:

```typescript
cleanupAll(): void {
  leaveVoice(false);       // don't send WS (connection may be gone)
  onErrorCallback = null;
  ws = null;
  serverHost = null;
  liveKitProxyPort = null;
  invoke("stop_livekit_proxy");  // fire-and-forget
}
```

---

## LiveKit Webhooks

### Purpose

Webhook handler (`livekit_webhook.go`) synchronizes LiveKit room
state back to OwnCord's `voice_states` DB. Primarily for crash
recovery when a participant disconnects from LiveKit without
sending a WS `voice_leave`.

### Endpoint

```
POST /api/v1/livekit/webhook
```

### Authentication

LiveKit sends `Authorization: Bearer <JWT>` in the webhook
request. The handler:
1. Parses the API token from the header.
2. Verifies the API key matches.
3. Verifies the HMAC signature and expiry via
   `verifier.Verify(apiSecret)`.

### Handled Events

| Event | Behavior |
|-------|----------|
| `participant_joined` | Log only. State already persisted by `handleVoiceJoin`. |
| `participant_left` | Clean up stale voice state if client didn't send `voice_leave`. |

### participant_left Cleanup

```
participant_left webhook fires
  |
  +-- Parse userID from identity "user-{id}"
  +-- Parse channelID from room "channel-{id}"
  |
  +-- Client still connected to WS?
  |     |
  |     +-- Yes: check if still in same channel
  |     |     +-- Same channel: clear voiceChID, db.LeaveVoiceChannel, broadcast voice_leave
  |     |     +-- Different channel: skip (already moved)
  |     |
  |     +-- No: db.LeaveVoiceChannel (ensure DB is clean)
```

---

## Complete Session Data Flow

### Connect to Disconnect

```
1. USER CLICKS "JOIN VOICE" on channel 10
   |
   v
2. CLIENT sends { type: "voice_join", payload: { channel_id: 10 } }
   |
   v
3. SERVER validates permissions, capacity, LiveKit health
   |
   v
4. SERVER persists: db.JoinVoiceChannel(userId, 10)
   SERVER generates: LiveKit JWT (room "channel-10", identity "user-42")
   |
   v
5. SERVER sends: voice_token, voice_state (broadcast), voice_config
   |
   v
6. CLIENT resolves LiveKit URL:
   - Localhost: ws://localhost:7880
   - Remote: start Rust TLS proxy, ws://127.0.0.1:{port}/livekit/...
   |
   v
7. CLIENT connects: Room.connect(url, token)
   LiveKit SDK establishes WebSocket + WebRTC connections
   |
   v
8. CLIENT publishes mic: setMicrophoneEnabled(true)
   Builds audio pipeline (GainNode chain)
   Starts VAD polling (if sensitivity < 100)
   Starts token refresh timer (3.5h)
   |
   v
9. VOICE SESSION ACTIVE
   - Audio flows: Client -> LiveKit SFU -> Other clients
   - Speaking detection: LiveKit SDK -> setSpeakers() -> UI
   - Stats polling: every 2s -> RTT, bitrate, quality
   - Token refresh: every 3.5h -> voice_token_refresh -> new token
   |
   v
10. USER CLICKS "LEAVE" (or disconnect/server restart)
    |
    v
11. CLIENT sends: { type: "voice_leave", payload: {} }
    CLIENT disconnects LiveKit room
    CLIENT tears down audio pipeline
    CLIENT stops timers
    |
    v
12. SERVER receives voice_leave:
    - clearVoiceChID
    - db.LeaveVoiceChannel
    - BroadcastToAll(voice_leave)
    - livekit.RemoveParticipant (best-effort)
    |
    v
13. All clients update UI: remove user from voice user list
```

### Room Configuration

```typescript
new Room({
  adaptiveStream: !isSource,    // Adaptive quality (off for "source" preset)
  dynacast: !isSource,          // Dynamic SVC (off for "source" preset)
  audioCaptureDefaults: {
    echoCancellation: loadPref("echoCancellation", true),
    noiseSuppression: loadPref("noiseSuppression", true),
    autoGainControl: loadPref("autoGainControl", true),
  },
  videoCaptureDefaults: CAMERA_PRESETS[quality],
  publishDefaults: {
    videoEncoding: { maxBitrate, maxFramerate },
    screenShareEncoding: { maxBitrate, maxFramerate },
  },
});
```

### LiveKit Room Events Wired

| Event | Handler | Purpose |
|-------|---------|---------|
| `TrackSubscribed` | `handleTrackSubscribed` | Attach remote audio/video |
| `TrackUnsubscribed` | `handleTrackUnsubscribed` | Detach and cleanup |
| `Disconnected` | `handleDisconnected` | Auto-reconnect or leave |
| `ActiveSpeakersChanged` | `handleActiveSpeakersChanged` | Update speaking indicators |
| `AudioPlaybackStatusChanged` | `handleAudioPlaybackChanged` | Autoplay unlock |
| `LocalTrackPublished` | `handleLocalTrackPublished` | Re-enforce mute on republish |

### Debug Info

Available in browser DevTools console:

```javascript
JSON.stringify(__owncord.lkDebug(), null, 2)
```

Returns: room state, participant list with volumes, track
publications, audio pipeline status, VAD state, RNNoise
processor status.
