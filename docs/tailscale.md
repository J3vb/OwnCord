# Tailscale Guide (Zero-Config Remote Access)

This guide is for server owners who want remote access without port
forwarding. Tailscale connects your devices into one private network, so
members reach your server as if they were at home.

## Why Tailscale

Tailscale builds an encrypted private network (a "tailnet") between your
devices, using WireGuard. It works behind CGNAT and strict home routers, where
port forwarding cannot. Setup is usually faster than forwarding ports by hand.

## Setup

1. Install Tailscale on the server and on each member's computer:
   <https://tailscale.com/download>.
2. Sign in. Check that every device is in the same tailnet, or that the server
   is shared with them.
3. Find the server's Tailscale IP address in the Tailscale app. It usually
   looks like `100.x.y.z`.
4. Keep OwnCord on port `8443`.
5. Members connect to `https://<tailscale-ip>:8443`.

## Using the admin panel over Tailscale

Chat works over Tailscale straight away. The admin panel may not.

`/admin` only accepts addresses in `server.admin_allowed_cidrs`.
`/api/v1/metrics` and the LiveKit health and webhook routes use the same list,
unless you set their own lists (`server.metrics_allowed_cidrs`,
`server.livekit_webhook_allowed_cidrs`). By default the list covers the
local machine and the private ranges `10.0.0.0/8`, `172.16.0.0/12` and
`192.168.0.0/16` (plus their IPv6 equivalents). Tailscale addresses are in
`100.64.0.0/10`, which is **not** included, so you get a `403` error.

To manage the server over the tailnet, add the range to `config.yaml`:

```yaml
server:
  admin_allowed_cidrs:
    - "127.0.0.0/8"
    - "100.64.0.0/10" # Tailscale tailnet
```

Setting this list replaces the default. So add back any other ranges you still
need, such as your LAN.

## TLS

- **Keep `tls.mode: self_signed`**, the default. This is the recommended
  choice.
- **Do not set `tls.mode: off`** for tailnet-only access. The desktop app only
  connects over `wss://`. So `off` works only behind an HTTPS reverse proxy
  ([TLS and reverse proxies](hosting/tls-and-proxy.md#behind-a-reverse-proxy-off)).

## Voice and video over Tailscale

Tailscale lets devices reach each other, but LiveKit still needs the right
settings. For the LiveKit key, secret and ports, see
[livekit-setup.md](livekit-setup.md).

**Set `voice.node_ip` to the server's Tailscale address** (`100.x.y.z`).

- This is the address LiveKit tells clients to send media to.
- OwnCord's generated `livekit.yaml` then uses it in place of
  `use_external_ip`.
- On the Docker stack, set `rtc.node_ip` in `livekit.yaml` instead, and remove
  `use_external_ip`.
- Leave `voice.advertise_internal_ip` off. It keeps address detection on, and
  then your `node_ip` is ignored.

Without it, LiveKit finds a public address using STUN. That is never the
`100.x` address your members can reach. So the call connects, and then nobody
hears anything.

The server warns at start-up whenever `node_ip` is not a public address. On a
tailnet, that warning is expected, and the `100.x` address is correct.

**Do not forward the media ports.** The tailnet carries voice and video
directly. Keep `7881/TCP` and the UDP media ports closed on your router. The
UDP media ports are the `50000-60000` range, or a single `voice.udp_port`.

## Benefits

- No router port forwarding.
- Works behind CGNAT.
- Fixed private addresses.
- Encrypted by default.
