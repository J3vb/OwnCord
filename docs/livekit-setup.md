# Voice and video (LiveKit)

OwnCord uses [LiveKit](https://livekit.io) for calls. LiveKit receives each
person's sound and video and passes it on to everyone else in the call.

**Most people do not need to install anything.** The server downloads LiveKit
and runs it for you, and the Docker image has it built in. You only need to
open the voice ports ([Port forwarding](port-forwarding.md)).

## Pick your setup

| You run the server                  | Who runs LiveKit              | Read                                  |
| ----------------------------------- | ----------------------------- | ------------------------------------- |
| On Windows, or Linux without Docker | OwnCord, by itself            | [Without Docker](#without-docker)     |
| As one Docker container             | OwnCord, inside the container | Nothing to do                         |
| With the Docker compose stack       | Its own container             | [Docker](#docker)                     |
| Next to a LiveKit you already have  | You                           | [Your own LiveKit](#your-own-livekit) |

## Without Docker

Voice is on by default. On first start the server downloads a fixed LiveKit
version from LiveKit's GitHub releases, checks it, keeps it in
`data/livekit/` and starts it. The setup wizard has a switch for this.

Open `7881/TCP` and `50000-60000/UDP` in your firewall, and forward them on your
router for people outside your home. For a single UDP port instead of the
range, set:

```yaml
voice:
  udp_port: 7882
```

**Keep the voice keys fixed.** The setup wizard creates and saves a key and
secret. If you write `config.yaml` by hand, set them yourself, or voice breaks
on every restart:

```yaml
voice:
  livekit_api_key: "my-unique-key"
  livekit_api_secret: "at-least-32-characters-of-random-text"
```

You can also set them as `OWNCORD_VOICE_LIVEKIT_API_KEY` and
`OWNCORD_VOICE_LIVEKIT_API_SECRET`.

## Docker <a name="docker"></a>

**One container:** nothing to do. See [Docker in detail](hosting/docker.md#voice-in-docker).

**Compose stack:** LiveKit runs as its own container next to the server.

1. Set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `.env`. Letters, digits
   and hyphens only, never a `'`. Make the secret at least 32 characters
   (`openssl rand -hex 32`). The example values starting with `change-me` are
   refused, and voice stays off until you change them.
2. Copy `livekit.yaml.example` to `livekit.yaml`. You must create it: if it is
   missing, Docker makes a folder in its place and LiveKit keeps restarting.
   You usually do not need to edit it.
3. Leave the voice settings in `config.yaml` alone. The compose file sets them.
4. Open `7881/TCP` and `7882/UDP`. If you used to forward `50000-60000/UDP`,
   switch to `7882/UDP` and close the range.

**An older `livekit.yaml`** still works, with two catches: a `webhook:` block
must use the same key as `.env`, and a `key_file:` line must go.

**Voice needs your public address.** Keep `use_external_ip: true` in
`livekit.yaml`. LiveKit looks up your address each time it starts, so after
your public address changes, run `docker compose restart livekit`. Only on a
Tailscale-only host, replace it with `node_ip: <your 100.x address>`.

## Your own LiveKit

Turn off the download and point the server at your LiveKit:

```yaml
voice:
  auto_download_livekit: false
  livekit_url: "ws://localhost:7880"
  livekit_api_key: "same key as LiveKit"
  livekit_api_secret: "same secret as LiveKit"
```

Or keep the server in charge but use your own copy of the program: set
`voice.livekit_binary` to its path.

## All voice settings

| Setting                 | What it does                                                     | Default               |
| ----------------------- | ---------------------------------------------------------------- | --------------------- |
| `livekit_api_key`       | Key shared by OwnCord and LiveKit                                | random if unset       |
| `livekit_api_secret`    | Secret for voice sign-in, at least 32 characters                 | random if unset       |
| `livekit_url`           | Where LiveKit listens                                            | `ws://localhost:7880` |
| `livekit_binary`        | Path to your own `livekit-server` program                        | empty                 |
| `auto_download_livekit` | Download and run LiveKit when no program is set                  | on in a new config    |
| `livekit_version`       | A different LiveKit version to download                          | built-in version      |
| `node_ip`               | Fixed public address for voice. Only when detection cannot work. | empty (detect)        |
| `advertise_internal_ip` | Also offer the local address, for people on your network         | off                   |
| `udp_port`              | One UDP port for all media instead of the range                  | range                 |
| `quality`               | Default voice quality: `low`, `medium` or `high`                 | `medium`              |

All of them live under `voice:` in `config.yaml`. Full list:
[Server configuration](server-configuration.md).

## When calls do not work

| What you see                                    | Likely cause and fix                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| You join, but nobody hears anything             | The UDP port is not open or forwarded. See [Port forwarding](port-forwarding.md). |
| Works from outside, not on your own network     | Set `voice.advertise_internal_ip: true`.                                          |
| "Voice not configured"                          | The key or secret is missing, or the secret is under 32 characters.               |
| "Failed to generate voice token"                | The key or secret in `config.yaml` does not match LiveKit's.                      |
| "Voice is temporarily unavailable"              | LiveKit is not running or not reachable. Check the log for `livekit` lines.       |
| "Too many rapid failures, giving up" in the log | LiveKit crashes on start. Read the `livekit` lines just before it.                |

More symptoms: [Troubleshooting](hosting/troubleshooting.md#voice-cannot-join-at-all).

## Checklist

- [ ] Fixed key and secret (the wizard does this for you).
- [ ] Voice ports open and forwarded.
- [ ] Two people can join a voice channel and hear each other.
- [ ] `/api/v1/livekit/health` says `{"status": "ok"}`.

How the server runs LiveKit, how sign-in to a call works and the optional
webhook: [Server reference](hosting/reference.md#voice-livekit-internals).
