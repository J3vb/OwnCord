# LiveKit Setup Guide

LiveKit is an open-source SFU (Selective Forwarding Unit) that handles real-time voice and video. OwnCord uses it instead of rolling its own WebRTC stack -- LiveKit handles all the hard parts (DTLS, ICE, codec negotiation, simulcast) while OwnCord manages permissions, state, and room lifecycle.

There are two ways to run LiveKit alongside OwnCord:

| Method                | Best for                   | LiveKit managed by          |
| --------------------- | -------------------------- | --------------------------- |
| **Docker Compose**    | Linux servers              | Docker (separate container) |
| **Companion process** | Windows / bare-metal Linux | OwnCord (auto-start)        |

---

## Docker <a name="docker"></a>

When running OwnCord via `docker compose`, LiveKit runs as a separate container on the same internal network. OwnCord reaches it at `ws://livekit:7880` via Docker's internal DNS — no port forwarding needed between containers.

### Setup

1. **Edit `.env`** (in `Server/`) — set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`:

   ```
   LIVEKIT_API_KEY=my-unique-key
   LIVEKIT_API_SECRET=my-secret-at-least-32-characters-long
   ```

   The server refuses the placeholder values `.env.example` ships (anything
   starting with `change-me`) the same way it refuses the `devkey` dev
   defaults: voice stays off and a start-up warning says why.

2. **Edit `livekit.yaml`** (copy from `livekit.yaml.example`) — use the same key/secret:

   ```yaml
   port: 7880
   rtc:
     tcp_port: 7881
     port_range_start: 50000
     port_range_end: 60000
     use_external_ip: true # LiveKit detects the public IP on every start
   keys:
     my-unique-key: my-secret-at-least-32-characters-long
   logging:
     level: info
   ```

   **Single-port option.** To forward one UDP port instead of the 10,000-port
   range, replace `port_range_start`/`port_range_end` with `udp_port: 7882`
   (any free UDP port), and publish that same port in `docker-compose.yml` in
   place of the range. Also uncomment `OWNCORD_VOICE_UDP_PORT` on the
   `owncord` service with the same port, so the admin connectivity report and
   the boot warning name that port rather than the range. LiveKit ignores the
   range once `udp_port` is set. This
   is the easier path through a restrictive firewall or a router with a small
   port-forwarding table. When OwnCord runs LiveKit itself (the
   `livekit_binary`/auto-download path), `voice.udp_port` in `config.yaml`
   generates the same single-port config for you.

3. **In `config.yaml`** (copied from `config.yaml.example`), no voice edit is needed: the compose file already points the server at `ws://livekit:7880` and turns auto-download off. Leave `voice.livekit_binary` unset — see [Deployment — config.yaml for Docker](deployment.md#configyaml-for-docker).

4. **Open firewall ports** on your host:

   | Port          | Protocol | Purpose                 |
   | ------------- | -------- | ----------------------- |
   | `7881`        | TCP      | TCP fallback for WebRTC |
   | `50000-60000` | UDP      | WebRTC media            |

   In single-port mode the second row is your one `udp_port` (for example
   `7882/UDP`) instead of the range.

   `7880/TCP` is LiveKit's own API/signalling endpoint and does not need to be
   opened: OwnCord proxies signalling to clients through `/livekit` on its own
   `8443` port.

> **LiveKit needs a routable media address** for remote clients. Without `use_external_ip: true` or a `node_ip`, it advertises internal Docker IP addresses as ICE candidates, which are unreachable from the internet. Prefer `use_external_ip: true`: it detects the public address when LiveKit starts, so after a dynamic IP changes, `docker compose restart livekit` picks up the new one with no config edit. Pin `node_ip` only where detection cannot work (a tailnet-only host, set to its `100.x` address), and remove `use_external_ip` when you do: while it is on, LiveKit overwrites `node_ip` with the detected address. A pinned public IP goes stale silently when the address changes.

---

## Companion Process (Windows / bare-metal Linux)

### 1. Get the LiveKit Binary

**You usually don't have to do anything.** With `voice.auto_download_livekit`
enabled (the default in a freshly generated `config.yaml`, and offered as a
toggle in the first-run setup wizard), OwnCord downloads a pinned
`livekit-server` release from the official LiveKit GitHub releases in the
background at startup, verifies it against the release's `checksums.txt`,
stores it in `data/livekit/`, and manages it as the companion process. Pin a
different release with `voice.livekit_version`.

To provide the binary yourself instead, download `livekit-server` for your
platform from one of:

- **GitHub releases**: <https://github.com/livekit/livekit/releases>
  - Grab the `livekit_*_windows_amd64.zip` asset
- **LiveKit website**: <https://livekit.io/> (Docs > Self Hosting)

Extract the binary somewhere permanent (e.g. `C:\livekit\livekit-server.exe`)
and set `voice.livekit_binary` to that path — a configured path always wins
over auto-download.

---

## 2. Server Configuration

LiveKit settings live in the `voice:` section of `config.yaml`:

```yaml
voice:
  livekit_api_key: "my-unique-key"
  livekit_api_secret: "my-secret-at-least-32-characters-long"
  livekit_url: "ws://localhost:7880"
  livekit_binary: "C:/livekit/livekit-server.exe"
  quality: "medium"
```

| Field                   | Purpose                                                                                              | Default                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `livekit_api_key`       | Shared API key between OwnCord and LiveKit                                                           | `""` (random key generated if unset)    |
| `livekit_api_secret`    | Shared secret for JWT signing (min 32 chars)                                                         | `""` (random secret generated if unset) |
| `livekit_url`           | LiveKit WebSocket URL                                                                                | `ws://localhost:7880`                   |
| `livekit_binary`        | Path to `livekit-server` binary. Empty + auto-download off = assume externally managed               | `""`                                    |
| `auto_download_livekit` | Download and manage a pinned `livekit-server` release automatically when `livekit_binary` is empty   | `true` in generated config              |
| `livekit_version`       | Override the pinned auto-download release (e.g. `"1.13.7"`)                                          | `""` (built-in pin)                     |
| `node_ip`               | Public IP for WebRTC ICE candidates; pin only when auto-detection cannot work                        | `""` (auto-detect)                      |
| `advertise_internal_ip` | Also advertise LAN IPs — enable on dual-homed servers (LAN + public IP) so local clients can connect | `false`                                 |
| `quality`               | Default voice quality preset                                                                         | `"medium"`                              |

Environment variable overrides use the `OWNCORD_` prefix: `OWNCORD_VOICE_LIVEKIT_API_KEY`, `OWNCORD_VOICE_LIVEKIT_API_SECRET`, etc.

> **Warning**: The server logs a warning at startup if you use the default dev key/secret. Always change these for production.

---

## 3. Ports and Firewall

| Port            | Protocol | Purpose                                  |
| --------------- | -------- | ---------------------------------------- |
| **7881**        | TCP      | LiveKit internal RTC (TURN/TCP fallback) |
| **50000-60000** | UDP      | Media transport (RTP audio/video)        |

With `voice.udp_port` set, the media row is that one UDP port instead of the
range (see step 2's single-port option and `docs/port-forwarding.md`).

`7880/TCP` (LiveKit's own HTTP/WS API) stays internal: OwnCord reaches it on
the host or Docker network and proxies client signalling through `/livekit`.

These two rows are the ones voice needs; the complete list, including the
chat port and the ACME port, is the canonical table in
[deployment.md](deployment.md#firewall-and-ports).

For LAN-only setups, ensure these ports are open on Windows Firewall. For remote access, forward these through your router or use [Tailscale](tailscale.md).

---

## 4. How the Companion Process Works

When `livekit_binary` is set, OwnCord manages LiveKit as a companion process:

1. **Config generation**: OwnCord auto-generates `data/livekit.yaml` with the API key/secret, port 7880, and UDP range 50000-60000 (or the single `voice.udp_port` when set). To manage the file yourself (custom `rtc` options, multiple interfaces, ...), delete the header line containing the auto-generated marker — OwnCord then leaves the file untouched on future starts. Your `keys:` entry must still match `voice.livekit_api_key` / `voice.livekit_api_secret`.
2. **Process launch**: `livekit-server --config data/livekit.yaml`
3. **Crash recovery**: Exponential backoff restart (3s -> 6s -> 12s ... up to 60s), gives up after 10 consecutive rapid failures
4. **Health checks**: `GET http://localhost:7880/` verifies LiveKit is responding
5. **Graceful shutdown**: Stops the process when OwnCord shuts down (5s timeout before kill)

If `livekit_binary` is empty and `auto_download_livekit` is off, OwnCord assumes LiveKit is managed externally (e.g. Docker, systemd, or manual start).

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
- Identity: `"user-{userID}:{joinToken}"` (the join instance token is appended, so a rejoin creates a distinct participant; `"user-{userID}"` when no token is present)
- TTL: 5 minutes; the client refreshes via `voice_token_refresh` every 4 minutes (rate limited to 1/60s)
- Publish is scoped per track source via `CanPublishSources`: microphone from `SPEAK_VOICE`, camera from `USE_VIDEO`, screen share from `SHARE_SCREEN`, each independently
- `canSubscribe` is always true

**Client connection paths:**

- **Proxy path** (`/livekit`): Client connects through OwnCord's HTTPS server. Avoids mixed-content issues.
- **Direct URL** (`ws://localhost:7880`): Sent only when `voice.livekit_url` is loopback ([protocol.md](protocol.md#voice_token-server---client-direct)). Used when the client is on localhost and the URL is itself loopback `ws:`/`http:`; any other `direct_url` — including a compose-internal name such as `ws://livekit:7880` that resolves only inside the container network — goes through the proxy path, on Linux desktop native voice as on every other platform ([security.md](security.md#tauri-capabilities-least-privilege)). Linux clients up to 2.0.0-beta.1 used any `direct_url` as-is for a `localhost` server — see [Linux desktop voice](deployment.md#linux-desktop-voice).

---

## 6. Webhook Integration

Neither shipped LiveKit config (`Server/livekit.yaml.example`, the managed
`Server/ws/livekit_process.go`) defines a `webhook:` block, so LiveKit sends no
webhooks by default and the server relies on its own server SDK plus client
`voice_leave` frames. To catch a user whose LiveKit connection died without a
`voice_leave`, the server polls LiveKit's participant list for every room with
a voice member once a minute and removes a membership whose participant has
been missing for two consecutive checks (`Server/ws/voice_reconcile.go`). The
same poll also lists every room LiveKit has open and removes any participant
with no matching voice state, including in a room nobody is in voice for. If
you configure LiveKit to post webhooks to `POST /api/v1/livekit/webhook`
(operator opt-in), the endpoint verifies the JWT and handles
`participant_left` to clean up such ghost voice states immediately.

---

## 7. Troubleshooting

| Symptom                                                          | Cause                                        | Fix                                                                                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "voice not configured" error                                     | LiveKit client failed to initialize          | Check `livekit_api_key` and `livekit_api_secret` are set and secret is >= 32 chars                                                                                         |
| "failed to generate voice token"                                 | API key/secret mismatch                      | Ensure `config.yaml` key/secret match what LiveKit is using                                                                                                                |
| Voice connects but no audio                                      | Firewall blocking UDP 50000-60000            | Open UDP port range in Windows Firewall                                                                                                                                    |
| "backend unavailable" from `/livekit` proxy                      | LiveKit not running on port 7880             | Check `livekit_binary` path or start LiveKit manually                                                                                                                      |
| "too many rapid failures, giving up" in logs                     | LiveKit binary crashes on startup            | Read the `livekit companion output` entries (`component=livekit`, text in `line`) before it in the server log, or run `livekit-server --config data/livekit.yaml` manually |
| Mixed content / insecure WS error                                | Client using direct URL over HTTPS page      | Client should use the `/livekit` proxy path                                                                                                                                |
| Voice works via public IP but not on the LAN (dual-homed server) | LiveKit only advertises the public `node_ip` | Set `voice.advertise_internal_ip: true` so LAN host candidates are advertised too; LiveKit then detects the public address itself and ignores a pinned `node_ip`           |
| `GET /api/v1/livekit/health` returns degraded                    | LiveKit server not reachable                 | Verify LiveKit is running: `curl http://localhost:7880`                                                                                                                    |

---

## 8. Production Checklist

- [ ] Set `livekit_api_key` and `livekit_api_secret` to your own random values
      (the setup wizard generates them, but a random key regenerated at every
      start is only a dev convenience; a fixed key/secret keeps voice tokens valid)
- [ ] Open firewall ports: 7881/TCP, 50000-60000/UDP
- [ ] If using ACME/manual TLS, ensure LiveKit proxy at `/livekit` is working
- [ ] Test voice by joining a voice channel from two clients
- [ ] Check `/api/v1/livekit/health` returns `{"status": "ok"}`
