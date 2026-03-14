---
name: webrtc-voice
description: Patterns for implementing WebRTC voice chat, video calls, screen sharing, and the Pion SFU/TURN relay. Use this skill when working on anything related to voice channels, video, screen sharing, the Pion media server, TURN relay, audio processing, noise suppression, soundboard, or WebRTC signaling. Trigger when the user mentions voice, audio, video, call, screen share, SFU, TURN, STUN, Pion, Opus, DTLS, SRTP, or RNNoise. Also use for debugging audio device issues or WebRTC connection problems.
---

# WebRTC Voice & Video Patterns

## Architecture Overview

```
Client A                    Server (Pion SFU)              Client B
   │                            │                             │
   │── voice_join ─────────────►│◄──────────── voice_join ────│
   │                            │                             │
   │── voice_offer (SDP) ──────►│                             │
   │◄── voice_answer (SDP) ─────│                             │
   │◄─► voice_ice (candidates) ─│                             │
   │                            │── voice_offer (SDP) ───────►│
   │                            │◄── voice_answer (SDP) ──────│
   │                            │◄─► voice_ice (candidates) ──│
   │                            │                             │
   │══ DTLS-SRTP audio ═══════►│═══ DTLS-SRTP audio ════════►│
   │◄══ DTLS-SRTP audio ═══════│◄═══ DTLS-SRTP audio ════════│
```

The server is an SFU (Selective Forwarding Unit):
- Each client sends ONE audio/video stream to the server.
- The server forwards that stream to every other client in the channel.
- The server never decodes or inspects media — it forwards encrypted packets.
- Much more efficient than mesh (where every client connects to every other client).

## Server Side (Go + Pion)

### SFU Setup

```go
import (
    "github.com/pion/webrtc/v4"
    "github.com/pion/turn/v3"
)

// One PeerConnection per client per voice channel.
// Track forwarding: when Client A adds a track, create a new track
// on every other client's PeerConnection and forward RTP packets.

type VoiceChannel struct {
    ID      int
    Clients map[int]*VoiceClient // user_id -> client
    mu      sync.RWMutex
}

type VoiceClient struct {
    UserID         int
    PeerConnection *webrtc.PeerConnection
    AudioTrack     *webrtc.TrackLocalStaticRTP // outgoing track to this client
}
```

### Signaling Flow (server handles via WebSocket)

```
1. Client sends "voice_join" with channel_id
2. Server creates a PeerConnection for this client
3. Server sends "voice_offer" (SDP) to client
4. Client responds with "voice_answer" (SDP)
5. Both exchange ICE candidates via "voice_ice"
6. Media flows once ICE completes

When a new client joins an existing channel:
- Create PeerConnection for new client
- For each existing client's audio track:
  → Add a forwarding track to the new client's PC
- Add new client's audio track forwarding to all existing clients
- Renegotiate with all affected clients (send new offers)
```

### TURN Relay (built into the server binary)

```go
// Embedded TURN server using pion/turn
// Listens on the same port as the main server or a configurable port

func startTURN(cfg config.Config) {
    // Generate time-limited credentials
    // Shared secret between HTTP API and TURN server
    // Client requests credentials via GET /api/voice/credentials
    // Credentials are HMAC(timestamp:userid, sharedSecret)
    // TURN server validates credentials using the same shared secret
    // Credentials expire after 24 hours
}
```

### TURN Credential Generation (REST endpoint)

```go
// GET /api/voice/credentials
func (h *Handler) VoiceCredentials(w http.ResponseWriter, r *http.Request) {
    user := auth.UserFromContext(r.Context())
    
    timestamp := time.Now().Add(24 * time.Hour).Unix()
    username := fmt.Sprintf("%d:%d", timestamp, user.ID)
    
    mac := hmac.New(sha1.New, []byte(h.turnSecret))
    mac.Write([]byte(username))
    credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
    
    respondJSON(w, 200, map[string]interface{}{
        "ice_servers": []map[string]interface{}{
            {"urls": "stun:" + h.cfg.PublicAddr + ":3478"},
            {"urls": "turn:" + h.cfg.PublicAddr + ":3478",
             "username": username, "credential": credential},
        },
        "expires_in": 86400,
    })
}
```

### Voice Quality Presets

```
low:    Opus 32kbps mono   — minimal bandwidth, acceptable quality
medium: Opus 64kbps mono   — good balance (default)
high:   Opus 128kbps stereo — best quality, more bandwidth

Configured in server config.yaml, applied when creating PeerConnections.
Set via SDP codec preferences or Opus parameters.
```

## Client Side

### WebRTC Connection

```
1. Request TURN credentials from GET /api/voice/credentials
2. Create RTCPeerConnection with ICE servers from response
3. Get user media (microphone): 
   - Use selected audio device from settings
   - Apply noise suppression (RNNoise) if enabled
4. Add audio track to PeerConnection
5. Handle signaling via existing WebSocket connection
6. On remote track received: play through selected output device
```

### Audio Pipeline (client)

```
Microphone (WASAPI)
    ↓
Noise Suppression (RNNoise, if enabled)
    ↓
Voice Activity Detection (energy-based threshold)
    ↓ (if voice detected OR push-to-talk held)
Opus Encoder (via WebRTC)
    ↓
Send to Server (DTLS-SRTP)

Received Audio (DTLS-SRTP from server)
    ↓
Opus Decoder (via WebRTC)
    ↓
Per-user Volume Adjustment (client-side mixer)
    ↓
Speaker Output (WASAPI)
```

### Push-to-Talk Logic

```
if mode == "push_to_talk":
    mic_track.enabled = ptt_key_held
    
if mode == "voice_activation":
    mic_track.enabled = audio_level > sensitivity_threshold
    
// Send voice_mute WebSocket event when mic state changes
// so other clients see the mute indicator
```

### Screen Sharing

```
1. User clicks "Share Screen"
2. Capture screen via DXGI Desktop Duplication
3. Encode as video track (H.264 or VP8)
4. Add video track to PeerConnection
5. Server forwards video track to all other clients in the channel
6. Receiving clients display in a video panel

Cap at 720p by default. Lower resolution if bandwidth is constrained.
Show "X is sharing their screen" indicator.
Only one screen share per channel at a time.
```

### Soundboard

```
1. User triggers a soundboard sound (button click or hotkey)
2. Client sends "soundboard_play" WebSocket message
3. Server validates: user has permission, cooldown not active
4. Server loads audio file, encodes as RTP packets
5. Server mixes into the voice channel audio (or sends as separate track)
6. All clients in the channel hear the sound

Alternative (simpler): 
- Client plays the sound locally AND sends the audio via their mic track
- Requires temporarily mixing the soundboard audio into the mic stream
```

## Debugging Tips

### ICE Connection Fails
- Most common cause: NAT traversal failure
- Check TURN server is reachable: `turnutils_uclient -t -u user -w pass server:3478`
- Check firewall allows UDP on TURN port
- Check TURN credentials are valid (not expired)
- Client should log ICE connection state changes

### Audio Not Working
- Check selected audio device is valid (devices can be unplugged)
- Check mic permissions (Windows may block mic access)
- Check audio track is enabled (not muted)
- Check Opus codec is negotiated in SDP
- Verify audio levels: add a meter before and after the pipeline

### High Latency
- Prefer UDP (TURN over UDP, not TCP)
- Check if traffic is being relayed through TURN when direct P2P is possible
- Reduce Opus frame size for lower latency (at cost of bandwidth)
- Check server CPU — SFU forwarding should be near-zero CPU
