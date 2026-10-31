# LiveKit Setup Guide

This guide is for server owners who want voice and video on OwnCord. It
explains how to run LiveKit, the media server OwnCord uses, and how to fix it
when calls fail.

**What LiveKit does.** LiveKit is an open-source SFU (Selective Forwarding
Unit): a server that receives each person's audio and video and forwards it to
everyone else in the call. It handles the hard parts of real-time media:
encryption, connection setup (ICE), codecs and quality layers. OwnCord handles
permissions, voice state and rooms.

**Most people do not need to install anything.** By default, OwnCord downloads
LiveKit and runs it for you. The Docker image even ships with LiveKit inside.

There are two ways to run LiveKit with OwnCord:

| Method                | Best for                                        | Who runs LiveKit                |
| --------------------- | ----------------------------------------------- | ------------------------------- |
| **Docker Compose**    | Linux servers                                   | Docker, as a separate container |
| **Companion process** | Windows, Linux without Docker, the Docker image | OwnCord, started automatically  |

---

## Docker <a name="docker"></a>

**Single container.** The `ghcr.io/j3vb/owncord-server` image already includes
LiveKit and starts it itself. You need nothing from this section. See
[Docker — voice](hosting/docker.md#voice-in-docker).

**Two-container compose stack.** The rest of this section is for
`docker compose`. There, LiveKit runs as its own container on the same
private network. OwnCord reaches it at `ws://livekit:7880` by its container
name. You do not need to forward any port between the two containers.

### Setup

1. **Edit `.env`** (in `Server/`). Set `LIVEKIT_API_KEY` and
   `LIVEKIT_API_SECRET`. This is the only place you type them: compose passes
   the same pair to both containers.

   ```
   LIVEKIT_API_KEY=my-unique-key
   LIVEKIT_API_SECRET=<output of: openssl rand -hex 32>
   ```

   Never use a `'` in either value: LiveKit reads the pair as YAML, and a `'`
   stops it from starting. Letters and digits, for example the output of
   `openssl rand -hex 32`, are safest. Hyphens work. The server refuses the placeholder
   values that `.env.example` ships (anything starting with `change-me`), and
   the `devkey` development defaults. If you leave them, voice stays off and a
   start-up warning says why.

   `docker compose` refuses to run any command (even `down` or `logs`) while
   `.env` is missing either value, and the message names the variable.

2. **Create `livekit.yaml`.** Copy it from `livekit.yaml.example`. This step
   is required: compose mounts `./livekit.yaml`, and if the file is missing
   Docker creates a folder of that name and LiveKit keeps restarting. Editing
   it is optional (for example to set `node_ip`). It holds no key or secret:
   those come from `.env`.

   ```yaml
   port: 7880
   rtc:
     tcp_port: 7881
     udp_port: 7882
     use_external_ip: true # LiveKit detects the public IP on every start
   logging:
     level: info
   ```

   **Media uses one UDP port, `7882`.** `docker-compose.yml` pins it with
   `--udp-port 7882` and publishes it, so there is nothing to change to get a
   single-port setup. It also passes `--rtc.port_range_start 0
--rtc.port_range_end 0`. LiveKit v1.13.7 prefers a `port_range_start/end`
   in the YAML over `udp_port`, so those flags clear any range an older
   `livekit.yaml` still has. Do not add a range to `livekit.yaml`.

   **An older `livekit.yaml` keeps working.** Its range is overridden, and its
   `keys:` are replaced by the `.env` pair. Two things in it can still get in
   the way:
   - A `webhook:` block whose `api_key` is not your `LIVEKIT_API_KEY` makes
     LiveKit fail to start. Change it to the `.env` key.
   - A `key_file:` overrides the `.env` pair. Remove it.

   When OwnCord runs LiveKit itself (see
   [Companion Process](#companion-process-windows--bare-metal-linux)), none of
   this applies: setting `voice.udp_port` in `config.yaml` makes OwnCord write
   `udp_port` into the `livekit.yaml` it generates. If you write `livekit.yaml`
   for a bare LiveKit yourself, note that LiveKit prefers a
   `port_range_start/end` to `udp_port`: delete the range when you set
   `udp_port`.

3. **`config.yaml` needs no voice changes.** Copy it from
   `config.yaml.example`. The compose file already points the server at
   `ws://livekit:7880` and turns auto-download off. Leave
   `voice.livekit_binary` unset. See
   [Docker — settings in a container](hosting/docker.md#settings-in-a-container).

4. **Open these ports** on your host firewall:

   | Port   | Protocol | Purpose                 |
   | ------ | -------- | ----------------------- |
   | `7881` | TCP      | TCP fallback for WebRTC |
   | `7882` | UDP      | WebRTC media            |

   If you used to forward `50000-60000/UDP`, forward `7882/UDP` instead and
   close the old range.

   You do not need to open `7880/TCP`. That is LiveKit's own API port. OwnCord
   passes signalling to clients through `/livekit` on its own port `8443`.

> **LiveKit needs an address that remote clients can reach.** Without
> `use_external_ip: true` or a `node_ip`, LiveKit tells clients its internal
> Docker addresses, which nobody outside can reach.
>
> - **Prefer `use_external_ip: true`.** LiveKit then finds your public address
>   each time it starts. After a changing IP changes, run
>   `docker compose restart livekit` to pick up the new one. No config edit is
>   needed.
> - **Pin `node_ip` only where detection cannot work**, such as a
>   Tailscale-only host. Set it to the `100.x` address. When you do, remove
>   `use_external_ip`: while it is on, LiveKit overwrites `node_ip` with what it
>   detects.
> - A pinned public IP goes out of date silently when your address changes.

---

## Companion Process (Windows / bare-metal Linux)

In this mode, OwnCord starts and manages LiveKit itself.

### 1. Get the LiveKit Binary

**You usually do not have to do anything.** `voice.auto_download_livekit` is
on in a freshly written `config.yaml`, and it is a switch in the first-run
setup wizard. With it on, OwnCord does this in the background at start-up:

1. Downloads a pinned `livekit-server` release from LiveKit's official GitHub
   releases.
2. Checks it against the release's `checksums.txt`.
3. Stores it in `data/livekit/`.
4. Starts and manages it.

To use a different release, set `voice.livekit_version`.

**To provide the binary yourself**, download `livekit-server` for your
platform from one of:

- **GitHub releases:** <https://github.com/livekit/livekit/releases>. For
  Windows, take the `livekit_*_windows_amd64.zip` asset.
- **LiveKit website:** <https://livekit.io/> (Docs > Self Hosting).

Extract the binary somewhere permanent, for example
`C:\livekit\livekit-server.exe`. Then set `voice.livekit_binary` to that path.
A path you set always wins over auto-download.

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

| Key                     | What it does                                                                                 | Default                         |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `livekit_api_key`       | API key shared by OwnCord and LiveKit                                                        | `""` (a random key if unset)    |
| `livekit_api_secret`    | Secret for signing voice tokens (at least 32 characters)                                     | `""` (a random secret if unset) |
| `livekit_url`           | LiveKit's WebSocket address                                                                  | `ws://localhost:7880`           |
| `livekit_binary`        | Path to `livekit-server`. Empty, with auto-download off, means you run LiveKit yourself      | `""`                            |
| `auto_download_livekit` | Download and run a pinned `livekit-server` when `livekit_binary` is empty                    | `true` in a generated config    |
| `livekit_version`       | Use a different auto-download release (for example `"1.13.7"`)                               | `""` (the built-in version)     |
| `node_ip`               | Public IP that LiveKit gives clients. Set it only when detection cannot work                 | `""` (detect automatically)     |
| `advertise_internal_ip` | Also give clients the LAN address. Turn on for a server with both a LAN and a public address | `false`                         |
| `udp_port`              | Carry all media on this one UDP port instead of `50000-60000`                                | `0` (use the range)             |
| `quality`               | Default voice quality: `low`, `medium` or `high`                                             | `"medium"`                      |

Every key can also be set with an environment variable that starts with
`OWNCORD_`, for example `OWNCORD_VOICE_LIVEKIT_API_KEY` and
`OWNCORD_VOICE_LIVEKIT_API_SECRET`.

> **Warning:** the server logs a warning at start-up if you use the default
> development key and secret. Always set your own for real use.

---

## 3. Ports and Firewall

| Port            | Protocol | Purpose                           |
| --------------- | -------- | --------------------------------- |
| **7881**        | TCP      | LiveKit media over TCP (fallback) |
| **50000-60000** | UDP      | Voice and video media (RTP)       |

With `voice.udp_port` set, the media row is that one UDP port instead of the
range. The Docker Compose stack always uses `7882/UDP` (see
[Docker](#docker)), and so does the single image. The range is the default for
the companion process on bare metal and for bare LiveKit. See [port-forwarding.md](port-forwarding.md).

`7880/TCP`, LiveKit's own API port, stays internal. OwnCord reaches it on the
same machine or Docker network, and passes client signalling through
`/livekit`.

These two rows are the ones voice needs. The full list, including the chat
port and the ACME port, is the main table in
[Server reference](hosting/reference.md#ports-in-detail).

- **LAN only:** open these ports in Windows Firewall (or your host firewall).
- **Remote access:** forward them on your router, or use
  [Tailscale](tailscale.md).

---

## 4. How the Companion Process Works

When `livekit_binary` is set, or auto-download provides the binary, OwnCord
manages LiveKit like this:

1. **It writes the config.** OwnCord generates `data/livekit.yaml` with:
   - the API key and secret
   - port 7880
   - the UDP range `50000-60000`, or your single `voice.udp_port`
   - an `audio:` block that tunes speaker detection, so the speaking ring
     lights up promptly (copy it from `livekit.yaml.example` into a file you
     manage yourself)
2. **It starts LiveKit:** `livekit-server --config data/livekit.yaml`.
3. **It restarts LiveKit after a crash.** Waits grow from 3 seconds to 6, 12,
   and so on, up to 60 seconds. It gives up after 10 quick failures in a row.
4. **It checks LiveKit's health** with an HTTP request to the address in
   `voice.livekit_url` (by default `http://localhost:7880/`).
5. **It stops LiveKit when OwnCord shuts down.** On Linux, LiveKit gets 5
   seconds to stop before it is killed.

**To manage `data/livekit.yaml` yourself** (custom `rtc` options, several
network interfaces, and so on), delete the header line that contains the
auto-generated marker. OwnCord then leaves the file alone on future starts.
Your `keys:` entry must still match `voice.livekit_api_key` and
`voice.livekit_api_secret`.

If `livekit_binary` is empty and `auto_download_livekit` is off, OwnCord
assumes you run LiveKit yourself, for example with Docker, systemd or by hand.

---

## 5. Token Flow

How a client joins voice:

```
Client                     OwnCord Server              LiveKit Server
  |                             |                           |
  |-- voice_join (channel_id)-->|                           |
  |                             |-- check READ+CONNECT_VOICE|
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

- Room name: `"channel-{channelID}"`.
- Identity: `"user-{userID}:{joinToken}"`. The join token makes each rejoin a
  separate participant. Without a token it is `"user-{userID}"`.
- Lifetime: 5 minutes. The client asks for a fresh token with
  `voice_token_refresh` every 4 minutes. The server allows one refresh per 60
  seconds.
- What a user may send is set per source with `CanPublishSources`:
  - microphone needs `SPEAK_VOICE`
  - camera needs `USE_VIDEO`
  - screen share needs `SHARE_SCREEN`
- `canSubscribe` is always true.

**How clients connect:**

- **Proxy path (`/livekit`):** the client connects through OwnCord's HTTPS
  server. This avoids mixed-content problems. It is the normal path.
- **Direct URL (`ws://localhost:7880`):** sent only when `voice.livekit_url` is
  itself a local (loopback) address
  ([protocol.md](protocol.md#voice_token-server---client-direct)). The client
  uses it only when it is on the same machine and the URL is a local `ws:` or
  `http:` address. Any other `direct_url` goes through the proxy path. That
  includes a compose-internal name such as `ws://livekit:7880`, which only
  works inside the container network. This rule is the same on every platform,
  including Linux native voice
  ([security.md](security.md#tauri-capabilities-least-privilege)).
  - Linux clients up to 2.0.0-beta.1 used any `direct_url` as-is for a
    `localhost` server. See
    [Linux app cannot join voice](hosting/troubleshooting.md#the-linux-app-cannot-join-voice).

---

## 6. Webhook Integration

**By default, LiveKit sends no webhooks.** Neither shipped LiveKit config
(`Server/livekit.yaml.example`, or the one `Server/ws/livekit_process.go`
writes) turns them on. The server relies on its own LiveKit API calls and on
clients' `voice_leave` messages instead.

**Cleaning up dropped users.** Sometimes a user's LiveKit connection dies
without a `voice_leave`. To catch that, once a minute the server asks LiveKit
who is in each room that has a voice member
(`Server/ws/voice_reconcile.go`):

- A member missing from LiveKit for two checks in a row is removed.
- The same check lists every room LiveKit has open, and removes any
  participant with no matching voice state, even in a room nobody is in voice
  for.

**Optional: turn webhooks on.** If you run LiveKit yourself, it can post
webhooks to `POST /api/v1/livekit/webhook`. This needs LiveKit to reach
OwnCord at a URL whose TLS certificate it trusts. OwnCord's default
self-signed certificate fails LiveKit's check, so the managed LiveKit is never
set up this way.

Add this block to your `livekit.yaml`. A commented copy is in
`Server/livekit.yaml.example`. On compose the key comes from `.env`, and a
webhook that names another key stops LiveKit from starting.

```yaml
webhook:
  api_key: YOUR_API_KEY # your LIVEKIT_API_KEY from .env (compose), or your voice.livekit_api_key / keys: entry when you run LiveKit yourself
  urls:
    - https://chat.example.com/api/v1/livekit/webhook
```

The sender's address must be in `server.livekit_webhook_allowed_cidrs`. By
default that falls back to `server.admin_allowed_cidrs`.

What the endpoint does:

- It checks the webhook's signed token (JWT).
- On `participant_joined`, it removes a participant with no matching voice
  state as soon as it joins.
- On `participant_left`, it cleans up the leftover voice state straight away,
  instead of at the next check.

---

## 7. Troubleshooting

| Symptom                                         | Cause                                         | Fix                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "voice not configured" error                    | LiveKit client failed to start                | Check that `livekit_api_key` and `livekit_api_secret` are set, and the secret is at least 32 characters                                                      |
| "failed to generate voice token"                | API key or secret mismatch                    | Make sure the key and secret in `config.yaml` match what LiveKit uses                                                                                        |
| Voice connects but no audio                     | Firewall blocks the UDP media ports           | Open UDP `50000-60000` (or your single UDP port, `7882/UDP` on Docker) in your firewall, and forward it on your router                                       |
| "backend unavailable" from the `/livekit` proxy | LiveKit is not running on port 7880           | Check the `livekit_binary` path, or start LiveKit by hand                                                                                                    |
| "too many rapid failures, giving up" in the log | LiveKit crashes at start-up                   | Read the `livekit companion output` entries (`component=livekit`, text in `line`) just before it. Or run `livekit-server --config data/livekit.yaml` by hand |
| Mixed content or insecure WebSocket error       | Client uses the direct URL from an HTTPS page | The client should use the `/livekit` proxy path                                                                                                              |
| Voice works on the public IP but not on the LAN | LiveKit only gives clients the public address | Set `voice.advertise_internal_ip: true`. LiveKit then also gives LAN addresses, detects the public one itself, and ignores a pinned `node_ip`                |
| `GET /api/v1/livekit/health` returns degraded   | LiveKit is not reachable                      | Check LiveKit is running: `curl http://localhost:7880`                                                                                                       |

---

## 8. Production Checklist

- [ ] Set `livekit_api_key` and `livekit_api_secret` (in `.env` on compose)
      to your own random values. The setup wizard generates and saves them for you. A random key
      made fresh at every start is only for development: fixed values keep
      voice tokens valid across restarts.
- [ ] Open the firewall ports: `7881/TCP` and `50000-60000/UDP` (or your single
      UDP port, `7882/UDP` on Docker).
- [ ] If you use ACME or manual TLS, check that the `/livekit` proxy works.
- [ ] Test voice by joining a voice channel from two clients.
- [ ] Check that `/api/v1/livekit/health` returns `{"status": "ok"}`.
