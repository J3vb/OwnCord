# Voice Channel Optimization — Design Spec

**Date:** 2026-03-15
**Status:** Draft
**Scope:** Server-side Pion SFU, client audio, noise suppression

---

## Problem

P2P voice creates N×(N-1)/2 connections per channel.
Each client uploads N-1 streams.
Limit: 5-8 users before quality degrades.

## Goal

Maximize voice capacity on modest hardware (4-core, 20Mbps).
No external deps — everything in `chatserver.exe`.
Pure Go, no CGO.

---

## Architecture: Hybrid SFU with Top-N Speaker Selection

### Overview

A Pion-based SFU runs inside the server process. Each
participant has one PeerConnection to the server. Two modes:

- **Forwarding mode** (below threshold): all streams forwarded
- **Selective mode** (above threshold): top N speakers only

### Forwarding Mode (Below Threshold)

- Default threshold: 10 users per channel (configurable)
- Server receives one audio track per participant
- Forwards each track to all other participants
- Clients mix audio locally with per-user volume control
- Server CPU: negligible — packet routing only

### Selective Forwarding Mode (Above Threshold)

When occupancy exceeds the threshold:

1. **Speaker detection via RFC 6464**: Clients include
   `ssrc-audio-level` RTP header extension (0-127 dBov).
   Server reads this without decoding media.

2. **Top-N selection**: Top N by audio level (default N=3)
   are forwarded to all others.

3. **Hysteresis**: Speaker must drop below threshold for
   500ms before replacement. Each speaker has a
   `last_active` timestamp for eviction logic.

4. **Remaining streams**: Non-top-N streams are not
   forwarded. Since most are listening, no audible effect.
   New loud speakers enter top-N within 200-300ms.

5. **Client receives N+1 streams max**: N active speakers
   plus 1 placeholder silent track.

6. **Speaker changes**: Broadcast via `voice_speakers`
   WebSocket event for UI updates.

**Why no background mix?** Mixing requires Opus decode/encode
via CGO (`hraban/opus.v2` + libopus). Selective forwarding
caps outbound streams without audio processing. Tradeoff:
only the loudest N are heard. In practice, conversations
naturally have few active speakers.

### Mode Transition

When a channel crosses the threshold:

- **Upward**: Server starts speaker detection. Clients get
  `voice_speakers` with `threshold_mode: "selective"`.
- **Downward**: Server resumes forwarding all tracks.
  Clients get `threshold_mode: "forwarding"`.

**Hysteresis buffer**: ±2 user buffer. Selective at
`threshold`, forwarding at `threshold - 2`.

**During transition**: Server completes the current 20ms
frame, then switches. Pion handles track add/remove
via renegotiation. No audio drops.

---

## Pion SFU Implementation

### Components

All components run inside `chatserver.exe`. Pure Go.

**MediaEngine:**

- Registers Opus codec for audio (always available)
- Registers VP8/VP9 on-demand for video/screenshare
- Registers `ssrc-audio-level` RTP header extension
- No transcoding — codec negotiation via SDP

**InterceptorRegistry:**

- NACK for packet loss recovery
- RTCP receiver reports for quality feedback
- No TWCC initially — add if congestion is an issue

**PeerConnection per participant:**

- One PeerConnection between each voice user and server
- Client sends one audio track (optionally video)
- Client receives up to N or top-N tracks
- PeerConnections stored per-channel in the Hub
- DTLS-SRTP (Pion default), ephemeral certs per connection

**Speaker Detector (selective mode only):**

- Reads RFC 6464 audio level from RTP headers
- Running average over 200ms (10 frames) per participant
- Top-N by lowest dBov (0 = loudest, 127 = silence)
- Updates active speakers with 500ms holdoff
- Lightweight goroutine per channel in selective mode
- Goroutine exits when below threshold or empty

### ICE and Network Configuration

**Server-side ICE candidates**: Configuration:

- **LAN/direct**: Server uses bind address as host candidate
- **Behind NAT**: Operator sets `voice.external_ip`
- **TURN fallback**: Built-in TURN relay serves as relay
  candidate for both client and server connections

```yaml
voice:
  external_ip: ""   # set if behind NAT
```

If `external_ip` is empty, Pion auto-discovers via STUN.
Same IP works if port forwarding is already configured.

### DTLS-SRTP Security Model

- All PeerConnections use DTLS-SRTP.
- Server is a **trusted media endpoint**. It decrypts
  incoming SRTP, re-encrypts per outbound connection.
- Server operator **can access decrypted audio**.
  Acceptable for self-hosted with trusted operator.
- No media is logged, stored, or inspected.

### Signaling Changes

WebSocket signaling changes from P2P relay to SFU:

**Current flow (P2P):**

1. Client A sends `voice_offer` → server relays to Client B
2. Client B sends `voice_answer` → server relays to Client A
3. ICE candidates exchanged via relay

**New flow (SFU):**

1. Client sends `voice_offer` → server creates
   PeerConnection, generates `voice_answer`
2. Server sends `voice_answer` with DTLS fingerprint
3. ICE candidates exchanged with server
4. Server adds/removes tracks as participants join/leave
5. Renegotiation via Pion's AddTrack/RemoveTrack

**Backward compatibility:** Same message types
(`voice_offer`, `voice_answer`, `voice_ice`). Same payload
structure. Server is the WebRTC peer, not another client.
Clients must include `ssrc-audio-level` in SDP offers.

**SDP validation:** Malformed SDP returns `voice_error`;
PeerConnection is not created. Pion handles most validation.

### New Protocol Messages

**Speaker update (Server → Client):**

```json
{
  "type": "voice_speakers",
  "payload": {
    "channel_id": 10,
    "speakers": [1, 5, 12],
    "threshold_mode": "forwarding"
  }
}
```

- `speakers`: Active speaker user IDs (up to top-N)
- `threshold_mode`: `"forwarding"` or `"selective"`
- Sent on speaker list changes or mode transitions
- In forwarding mode, contains all speaking users
- Rate: at most once per 200ms per channel

**Extended voice state (Server → Client):**

Add `camera` and `screenshare` to `voice_state`:

```json
{
  "type": "voice_state",
  "payload": {
    "channel_id": 10,
    "user_id": 1,
    "username": "alex",
    "muted": false,
    "deafened": false,
    "speaking": false,
    "camera": false,
    "screenshare": false
  }
}
```

New fields are additive — old clients ignore them.
Update PROTOCOL.md for `voice_state` and `voice_speakers`.

**Voice error (Server → Client):**

```json
{
  "type": "voice_error",
  "payload": {
    "code": "CHANNEL_FULL",
    "message": "Voice channel is full (50/50)"
  }
}
```

Error codes: `CHANNEL_FULL`, `FORBIDDEN`,
`INVALID_SDP`, `SERVER_ERROR`

---

## Failure Handling and Recovery

### Server Crash/Restart

- **Startup**: Clear all `voice_states` rows.
- **Planned restart**: Send `server_restart` WebSocket
  message. Tear down PeerConnections. Clients reconnect
  and re-negotiate after restart.
- **Unplanned crash**: PeerConnections die (DTLS timeout).
  Clients detect ICE failure, show "reconnecting."
  On reconnect, client re-sends `voice_join`.

### Participant Disconnect

- **WebSocket disconnect**: `handleVoiceLeave()` fires,
  removes state, broadcasts `voice_leave`, tears down
  PeerConnection and removes tracks.
- **Network blip (WebSocket stays, PC drops)**: Pion
  detects ICE failure. Client can attempt ICE restart
  via new `voice_offer` without re-joining.
- **Stale cleanup**: Goroutine checks PeerConnection state
  every 30s. Cleans up `Failed`/`Closed` connections.

### Mixer/Detector Goroutine Panic

- Uses `defer recover()` to catch panics
- On panic: log error, broadcast empty `voice_speakers`,
  fall back to forwarding mode
- Channel stays functional until re-triggered

### Voice Channel Max Users

When joining a full channel (`voice_max_users`):

- Server returns `voice_error` with `CHANNEL_FULL`
- Client shows "Voice channel is full (N/N)"
- Join rejected — user stays in current state

---

## Audio Input Modes (Client-Side)

Three user-selectable modes. Determines when audio is sent.
The SFU treats all modes identically.

### Voice Activity Detection (Default)

- Opus built-in VAD + audio energy threshold
- Sensitivity: low/medium/high (configurable)
- Silence stops RTP packets entirely (no data sent)
- Reduces bandwidth 60-80% in typical channels

### Push-to-Talk

- Global hotkey (default: grave/tilde key)
- Registered via `SetWindowsHookEx` for fullscreen games
- Audio only while key is held
- Best for server bandwidth
- Visual indicator in UI

### Open Mic

- Always transmitting while in voice channel
- No VAD gate, no PTT requirement
- Highest bandwidth usage
- For continuous transmission (music, commentary)

---

## Noise Suppression (Client-Side)

Three tiers, user-selectable. Processing before Opus
encoding. Server has no involvement.

### Off

- Raw mic input to Opus encoder
- Zero additional CPU usage
- For low-end hardware or external suppression

### Standard (Default)

- Windows Audio Processing: echo cancellation + suppression
- Built into OS via WASAPI audio processing objects
- Zero binary size impact
- Adequate for most environments

### Enhanced

- RNNoise ML-based noise suppression
- Bundled with installer (~2MB added)
- Inference on raw PCM frames before Opus encoding
- CPU cost: ~2-3% on modern hardware (single core)
- Best for keyboard clicks, fan noise, chatter
- Pre-trained weights, no user training needed

---

## Audio Quality Configuration

### Per-Server Default

Configured in `config.yaml` under `voice`:

| Preset | Opus Bitrate | BW/User | Use Case |
| ------ | ------------ | ------- | -------- |
| `low` | 32 kbps | ~5 KB/s | Max capacity |
| `medium` | 64 kbps | ~9 KB/s | Balanced (default) |
| `high` | 128 kbps | ~17 KB/s | Music, high fidelity |

### Per-Channel Override

Admins can override per voice channel via admin panel
or REST API.

### How It Works

- Server sends quality in `voice_config` after `voice_join`
- Client configures Opus encoder to specified bitrate
- SFU does not transcode — forwards as-is
- Clients must include RFC 6464 `ssrc-audio-level` header

---

## Configuration

### Server-Side (`config.yaml`)

```yaml
voice:
  quality: medium          # low | medium | high
  mixing_threshold: 10     # selective forwarding threshold
  top_speakers: 3          # active speakers in selective
  external_ip: ""          # set if behind NAT
  turn_enabled: true
  turn_secret: ""          # auto-generated on first run
  stun_port: 3478
  turn_port: 3478
```

### Per-Channel Override (Admin Panel / REST API)

Stored as columns on the channels table:

```json
{
  "voice_quality": "high",
  "voice_max_users": 50,
  "mixing_threshold": 5
}
```

Only voice channels use these fields.

### Client-Side Settings (Persisted Locally)

```text
audio_input_mode: vad | push_to_talk | open_mic
vad_sensitivity: low | medium | high
ptt_keybind: "VK_GRAVE"
noise_suppression: off | standard | enhanced
input_device: <device_id>
output_device: <device_id>
input_volume: 1.0
output_volume: 1.0
per_user_volumes: { "5": 0.8 }
```

No server APIs needed for client settings — they stay
local. New server-to-client: `voice_speakers` event and
`voice_config` on join.

---

## Capacity Estimates

Assumes: 4-core CPU, 20 Mbps upload, 64kbps Opus,
VAD reducing active streams ~70%.

### Per Channel

| Size | Mode | CPU | Upload |
| ---- | ---- | --- | ------ |
| 5 | Forwarding | ~1% | 5 × 4 × 9 KB/s = 180 KB/s |
| 10 | Forwarding | ~2% | 10 × 9 × 9 KB/s = 810 KB/s |
| 20 | Selective | ~3-5% | 20 × 4 × 9 KB/s = 720 KB/s |
| 50 | Selective | ~5-8% | 50 × 4 × 9 KB/s = 1.8 MB/s |
| 100 | Selective | ~8-12% | 100 × 4 × 9 KB/s = 3.6 MB/s |

CPU is low because selective forwarding does no audio
decoding — only RTP header inspection and packet routing.
Primary cost: PeerConnection management and SRTP.

Forwarding BW scales as N×(N-1). Selective scales as
N×(top_speakers+1). With VAD, real-world BW is 60-80%
lower.

### Total Server Capacity

| Scenario | Feasibility |
| -------- | ----------- |
| 3 ch × 50 users | ~15-24% CPU, ~5.4 MB/s |
| 1 ch × 100 users | ~8-12% CPU, ~3.6 MB/s |
| 5 ch × 30 users | ~15-25% CPU, ~5.4 MB/s |
| 200+ total users | Depends on active speakers |

100 users at 3.6 MB/s (~29 Mbps) exceeds 20 Mbps ref.
Primary target: 50 users/channel at ~14.4 Mbps.

### Video/Screenshare

Video/screenshare tracks are always forwarded, never
mixed or selectively dropped:

- VP8 720p @ 30fps: ~1-2 Mbps per stream
- Screen share: ~0.5-3 Mbps (varies by content)
- Limit: 5-10 simultaneous video streams per channel
- Independent of audio selective forwarding

---

## Schema Changes

New migration: `Server/migrations/003_voice_optimization.sql`

### Voice States Table

Add camera and screenshare tracking:

```sql
ALTER TABLE voice_states ADD COLUMN camera INTEGER NOT NULL DEFAULT 0;
ALTER TABLE voice_states ADD COLUMN screenshare INTEGER NOT NULL DEFAULT 0;
```

### Channels Table

Add voice configuration columns:

```sql
ALTER TABLE channels ADD COLUMN voice_max_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN voice_quality TEXT;
ALTER TABLE channels ADD COLUMN mixing_threshold INTEGER;
```

- `voice_max_users`: 0 = unlimited
- `voice_quality`: NULL = server default
- `mixing_threshold`: NULL = server default

### Startup Cleanup

On startup, clear stale voice states:

```sql
DELETE FROM voice_states;
```

Runs before accepting connections.

---

## Protocol Updates Required

PROTOCOL.md must include:

1. **`voice_speakers`** message with payload and rate limit
2. **`voice_state`** extended with `camera`/`screenshare`
3. **`voice_config`** sent after `voice_join` acceptance
4. **`voice_error`** with codes: `CHANNEL_FULL`,
   `FORBIDDEN`, `INVALID_SDP`, `SERVER_ERROR`
5. **Note**: `voice_offer`/`voice_answer`/`voice_ice`
   now go to/from server SFU, not relayed
6. **Note**: Clients must include RFC 6464
   `ssrc-audio-level` in SDP offers

---

## Gap Resolutions

### Gap 1: `voice_config` Payload Definition

Sent server → client after `voice_join` acceptance, before signaling begins.

```json
{
  "type": "voice_config",
  "payload": {
    "channel_id": 10,
    "quality": "medium",
    "bitrate": 64000,
    "threshold_mode": "forwarding",
    "mixing_threshold": 10,
    "top_speakers": 3,
    "max_users": 50
  }
}
```

- `quality`: string — `"low"` | `"medium"` | `"high"`
  (channel override or server default)
- `bitrate`: integer — Opus bitrate in bps, from quality
  preset (32000/64000/128000)
- `threshold_mode`: string — `"forwarding"` | `"selective"`
  at time of join
- `mixing_threshold`: integer — the threshold at which selective mode activates
- `top_speakers`: integer — N for top-N selection in selective mode
- `max_users`: integer — channel capacity (0 = unlimited)

Client uses `bitrate` for Opus encoder. Other fields
are informational for UI
(e.g., showing "Selective mode — top 3 speakers" indicator).

Rate: sent once on join. Not re-sent unless channel config changes mid-session
(future: `voice_config_update` if admin changes quality live).

### Gap 2: `voice_error` Uses Existing Error Envelope

**Decision**: Voice errors use the existing `error` message type from PROTOCOL.md,
extended with voice-specific codes. No separate `voice_error` type.

```json
{
  "type": "error",
  "id": "original-req-uuid",
  "payload": {
    "code": "CHANNEL_FULL",
    "message": "Voice channel is full (50/50)"
  }
}
```

Additional error codes added to the existing set:

| Code | When |
| ------ | ------ |
| `CHANNEL_FULL` | `voice_join` when at `voice_max_users` capacity |
| `INVALID_SDP` | `voice_offer` with malformed/unparseable SDP |
| `VOICE_ERROR` | Generic SFU failure (PeerConnection creation, track setup) |

Existing codes that apply to voice unchanged:

- `FORBIDDEN` — missing `CONNECT_VOICE` permission
- `NOT_FOUND` — channel doesn't exist
- `RATE_LIMITED` — voice signaling rate exceeded

The `id` field enables request/response correlation (client sends `voice_join`
with an `id`, server returns `error` with the same `id`).

**Spec update**: All references to `voice_error` in this document should be read
as `error` with voice-specific codes. The JSON examples above in "New Protocol
Messages" section are updated accordingly.

### Gap 3: Media Port Range Configuration

Pion requires UDP ports for WebRTC media (DTLS-SRTP, ICE). Without explicit
configuration, Pion uses OS-assigned ephemeral ports, which makes firewall
rules unpredictable for self-hosted operators.

**Config additions** (`config.yaml`):

```yaml
voice:
  # ... existing fields ...
  media_port_min: 10000    # UDP port range start for WebRTC media
  media_port_max: 10100    # UDP port range end for WebRTC media
```

- Default range: `10000-10100` (101 ports, supports ~50 concurrent PeerConnections)
- Each PeerConnection uses 1 UDP port (Pion muxes DTLS+SRTP+RTCP on one port)
- Self-hosted operators must open `media_port_min:media_port_max/udp` in their firewall
- Range can be widened for higher capacity (e.g., `10000-10500` for 500 connections)

**Implementation**: Pass to Pion via
`SettingEngine.SetEphemeralUDPPortRange(min, max)`.

**Documentation requirement**: The setup guide must include:

```text
Firewall ports to open:
  - TCP 8443        (HTTPS + WebSocket)
  - UDP 3478        (STUN/TURN)
  - UDP 10000-10100 (WebRTC media)
```

### Gap 4: TURN Role in SFU Topology

**Decision**: The built-in TURN server is for **client-side ICE only**. The server's
own Pion ICE agent does NOT use the local TURN server.

**Rationale**: In an SFU topology, the server is a direct WebRTC endpoint. It binds
to its configured IP/ports and accepts connections. TURN is needed when *clients*
are behind symmetric NATs that prevent direct UDP connectivity to the server.
Having the server relay packets to itself via its own TURN server is circular
and unnecessary.

**ICE configuration per topology**:

| Scenario | Server ICE Config | Client ICE Config |
| -------- | ----------------- | ----------------- |
| LAN (direct) | Host candidate on bind address | STUN only |
| Port-forwarded | `external_ip` as server reflexive | STUN + TURN fallback |
| Behind NAT (no port forward) | `external_ip` required | TURN required |

**Server-side Pion ICE settings**:

- `SetNAT1To1IPs([external_ip])` when `voice.external_ip` is set
- `SetNetworkTypes([NetworkTypeUDP4])` — UDP only, no TCP ICE
- No TURN servers configured on the server's ICE agent

**Client-side ICE servers** (returned by `GET /api/v1/voice/credentials`):

- STUN: `stun:<server_host>:3478`
- TURN (if enabled): `turn:<server_host>:3478` with time-limited HMAC credentials

**Updated REST response** (`GET /api/v1/voice/credentials`):

```json
{
  "ice_servers": [
    { "urls": ["stun:chat.example.com:3478"] },
    {
      "urls": ["turn:chat.example.com:3478"],
      "username": "timestamp:userid",
      "credential": "hmac"
    }
  ],
  "quality": "medium",
  "bitrate": 64000
}
```

Added `quality` and `bitrate` so clients can pre-configure Opus before signaling.

### Gap 5: Video/Screenshare Lifecycle

**Signaling**: Video and screenshare are controlled via **explicit WebSocket messages**,
not by detecting track types. This keeps the protocol explicit and allows permission
checks before track negotiation.

**New messages (Client → Server)**:

```json
{ "type": "voice_camera", "payload": { "enabled": true } }
{ "type": "voice_screenshare", "payload": { "enabled": true } }
```

**Server behavior on `voice_camera`/`voice_screenshare`**:

1. **Permission check**: Verify `USE_VIDEO` (bit 11)
   for camera, `SHARE_SCREEN` (bit 12) for screenshare
2. **Capacity check**: Count active video streams. If
   ≥ limit (default 10, via `voice_max_video`), return
   `error` with code `VIDEO_LIMIT`
3. **Update DB**: Set `camera`/`screenshare` boolean in `voice_states`
4. **Broadcast**: Send updated `voice_state` to all channel members
5. **Renegotiation**: Server signals readiness for the
   client to add the video track via WebRTC
   renegotiation (`AddTransceiverFromKind`, client adds
   track and sends new `voice_offer`)

**Disabling**: Client sends `{ "enabled": false }`.
Server removes the track reference, broadcasts updated
`voice_state`, Pion handles track removal on next
renegotiation.

**Track type mapping**:

- Camera → `video` track with `streamId` = `"camera"`
- Screenshare → `video` track with `streamId` = `"screen"`
- Server distinguishes by stream ID, not by inspecting content

**Additional schema** (add to migration 003):

```sql
ALTER TABLE channels ADD COLUMN voice_max_video INTEGER NOT NULL DEFAULT 10;
```

**Additional error code**:

| Code | When |
| ------ | ------ |
| `VIDEO_LIMIT` | At max simultaneous video streams |

**Rate limit**: `voice_camera`/`voice_screenshare` —
2/sec per user (prevents toggle spam).

---

## What This Design Does NOT Include

- **Audio mixing**: No Opus decode/encode on server.
  Pure packet forwarding. Preserves no-CGO builds.
- **Background mix**: Non-top-N silenced, not mixed.
- **Echo cancellation**: Client-side only.
- **Recording**: No server-side recording. Out of scope.
- **Spatial audio**: Standard stereo only.
- **Adaptive bitrate**: Fixed bitrate, no dynamic
  adjustment (could add via RTCP feedback later).
- **LiveKit**: Excluded for single-binary architecture.
- **E2E encryption**: DTLS-SRTP only. Server is trusted
  endpoint. No Insertable Streams / SFrame.

---

## Dependencies

### Server (Go) — All Pure Go

- `pion/webrtc/v4` — WebRTC stack
- `pion/interceptor` — NACK, RTCP reports
- `pion/rtp` — RTP parsing, RFC 6464 header reading
- `pion/sdp/v3` — SDP parsing and validation

No CGO. No libopus. Server reads RTP headers and
forwards encrypted packets only.

### Client (Windows Native)

- RNNoise (~2MB) for Enhanced noise suppression
- Opus codec (bundled via WebRTC library)
- WASAPI for audio device management
- WebRTC client with RFC 6464 support

---

## Success Criteria

1. 50+ users per channel on 4-core desktop without
   quality degradation for active speakers
2. Forwarding mode: full per-user volume control
3. Selective mode: top-N with per-user volume;
   non-speakers silenced
4. VAD reduces bandwidth by 60%+ in typical usage
5. Mode transitions are seamless — no audio drops
6. All voice in `chatserver.exe` — no external deps
7. Client noise suppression ≤3% CPU on quad-core
8. Graceful crash recovery — stale states cleared,
   clients reconnect automatically
9. Per-user volume for all forwarded streams
