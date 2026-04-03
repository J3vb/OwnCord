# LiveKit Setup Guide

LiveKit is an open-source SFU (Selective Forwarding Unit) that handles real-time voice and video. OwnCord uses it instead of rolling its own WebRTC stack -- LiveKit handles all the hard parts (DTLS, ICE, codec negotiation, simulcast) while OwnCord manages permissions, state, and room lifecycle.

There are two ways to run LiveKit alongside OwnCord:

| Method | Best for | LiveKit managed by |
|--------|----------|--------------------|
| **Docker Compose** | Linux servers | Docker (separate container) |
| **Companion process** | Windows / bare-metal Linux | OwnCord (auto-start) |

---

## Docker <a name="docker"></a>

When running OwnCord via `docker compose`, LiveKit runs as a separate container on the same internal network. OwnCord reaches it at `ws://livekit:7880` via Docker's internal DNS — no port forwarding needed between containers.

### Setup

1. **Edit `.env`** (in `Server/`) — set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`:

   ```
   LIVEKIT_API_KEY=my-unique-key
   LIVEKIT_API_SECRET=my-secret-at-least-32-characters-long
   ```

2. **Edit `livekit.yaml`** (copy from `livekit.yaml.example`) — use the same key/secret and set your public IP:

   ```yaml
   port: 7880
   rtc:
     tcp_port: 7881
     port_range_start: 50000
     port_range_end: 60000
     node_ip: "YOUR_SERVER_PUBLIC_IP"   # required for remote clients
   keys:
     my-unique-key: my-secret-at-least-32-characters-long
   logging:
     level: info
   ```

3. **Leave `voice.livekit_binary` unset** in your `config.yaml`. The `voice.livekit_url` should be `ws://livekit:7880` (Docker DNS).

4. **Open firewall ports** on your host:

   | Port | Protocol | Purpose |
   |------|----------|---------|
   | `7880` | TCP | LiveKit signaling |
   | `7881` | TCP | TCP fallback for WebRTC |
   | `50000-60000` | UDP | WebRTC media |

> **`node_ip` is required** for remote clients. Without it, LiveKit advertises internal Docker IP addresses as ICE candidates, which are unreachable from the internet. If your cloud VM has a metadata service (AWS, GCP, DigitalOcean) you can use `use_external_ip: true` instead.

---

## Companion Process (Windows / bare-metal Linux)

### 1. Get the LiveKit Binary

Download `livekit-server` for your platform from one of:

- **GitHub releases**: <https://github.com/livekit/livekit/releases>
  - Grab the `livekit-server_*_windows_amd64.zip` asset
- **LiveKit website**: <https://livekit.io/> (Docs > Self Hosting)

Extract the binary somewhere permanent (e.g. `C:\livekit\livekit-server.exe`).

---

## 2. Server Configuration

LiveKit settings live in the `voice:` section of `config.yaml`:

```yaml
voice:
  livekit_api_key: "devkey"
  livekit_api_secret: "owncord-dev-secret-key-min-32chars"
  livekit_url: "ws://localhost:7880"
  livekit_binary: "C:/livekit/livekit-server.exe"
  quality: "medium"
```

| Field | Purpose | Default |
|-------|---------|---------|
| `livekit_api_key` | Shared API key between OwnCord and LiveKit | `"devkey"` |
| `livekit_api_secret` | Shared secret for JWT signing (min 32 chars) | `"owncord-dev-secret-key-min-32chars"` |
| `livekit_url` | LiveKit WebSocket URL | `ws://localhost:7880` |
| `livekit_binary` | Path to `livekit-server` binary. Empty = assume externally managed | `""` (disabled) |
| `quality` | Default voice quality preset | `"medium"` |

Environment variable overrides use the `OWNCORD_` prefix: `OWNCORD_VOICE_LIVEKIT_API_KEY`, `OWNCORD_VOICE_LIVEKIT_API_SECRET`, etc.

> **Warning**: The server logs a warning at startup if you use the default dev key/secret. Always change these for production.

---

## 3. Ports and Firewall

| Port | Protocol | Purpose |
|------|----------|---------|
| **7880** | TCP (HTTP/WS) | LiveKit signaling (WebSocket + REST API) |
| **7881** | TCP | LiveKit internal RTC (TURN/TCP fallback) |
| **50000-60000** | UDP | Media transport (RTP audio/video) |

For LAN-only setups, ensure these ports are open on Windows Firewall. For remote access, forward these through your router or use [Tailscale](tailscale.md).

---

## 4. How the Companion Process Works

When `livekit_binary` is set, OwnCord manages LiveKit as a companion process:

1. **Config generation**: OwnCord auto-generates `data/livekit.yaml` with the API key/secret, port 7880, and UDP range 50000-60000
2. **Process launch**: `livekit-server --config data/livekit.yaml`
3. **Crash recovery**: Exponential backoff restart (3s -> 6s -> 12s ... up to 60s), gives up after 10 consecutive rapid failures
4. **Health checks**: `GET http://localhost:7880/` verifies LiveKit is responding
5. **Graceful shutdown**: Stops the process when OwnCord shuts down (5s timeout before kill)

If `livekit_binary` is empty, OwnCord assumes LiveKit is managed externally (e.g. Docker, systemd, or manual start).

---

## 5. Token Flow

How a client joins voice:

```
Client                     OwnCord Server              LiveKit Server
  |                             |                           |
  |-- voice_join (channel_id)-->|                           |
  |                             |-- check CONNECT_VOICE     |
  |                             |-- persist to voice_states |
  |                             |-- GenerateToken()         |
  |<-- voice_token ------------|                           |
  |    { token, url,           |                           |
  |      direct_url }          |                           |
  |                             |                           |
  |-- connect with JWT --------|-------------------------->|
  |<--- media streams ----------|--------------------------|
```

**Token details:**
- Room name: `"channel-{channelID}"`
- Identity: `"user-{userID}"`
- TTL: 24 hours (refresh at 23h)
- `canPublish` is derived from the `SPEAK_VOICE` permission
- `canSubscribe` is always true
- Client can request refresh via `voice_token_refresh` (rate limited to 1/60s)

**Client connection paths:**
- **Proxy path** (`/livekit`): Client connects through OwnCord's HTTPS server. Avoids mixed-content issues.
- **Direct URL** (`ws://localhost:7880`): Used when the client is on localhost.

---

## 6. Webhook Integration

LiveKit sends webhooks to `POST /api/v1/livekit/webhook`. The endpoint verifies the JWT and handles `participant_left` to clean up ghost voice states when a user disconnects from LiveKit without sending a `voice_leave` message.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "voice not configured" error | LiveKit client failed to initialize | Check `livekit_api_key` and `livekit_api_secret` are set and secret is >= 32 chars |
| "failed to generate voice token" | API key/secret mismatch | Ensure `config.yaml` key/secret match what LiveKit is using |
| Voice connects but no audio | Firewall blocking UDP 50000-60000 | Open UDP port range in Windows Firewall |
| "backend unavailable" from `/livekit` proxy | LiveKit not running on port 7880 | Check `livekit_binary` path or start LiveKit manually |
| "too many rapid failures, giving up" in logs | LiveKit binary crashes on startup | Run `livekit-server --config data/livekit.yaml` manually to see errors |
| Mixed content / insecure WS error | Client using direct URL over HTTPS page | Client should use the `/livekit` proxy path |
| `GET /api/v1/livekit/health` returns degraded | LiveKit server not reachable | Verify LiveKit is running: `curl http://localhost:7880` |

---

## 8. Production Checklist

- [ ] Change `livekit_api_key` from `"devkey"` to a random string
- [ ] Change `livekit_api_secret` to a random 32+ character string
- [ ] Open firewall ports: 7880/TCP, 50000-60000/UDP
- [ ] If using ACME/manual TLS, ensure LiveKit proxy at `/livekit` is working
- [ ] Test voice by joining a voice channel from two clients
- [ ] Check `/api/v1/livekit/health` returns `{"status": "ok"}`
