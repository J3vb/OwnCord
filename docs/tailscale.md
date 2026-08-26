# Tailscale Guide (Zero-Config Remote Access)

Use Tailscale when you want remote access without port forwarding.

## Why Tailscale

Tailscale creates an encrypted private network between your devices using WireGuard.
It works behind CGNAT and strict home routers, so setup is usually faster than manual forwarding.

## Setup

1. Install Tailscale on the server machine and client machines: https://tailscale.com/download
2. Sign in and confirm all devices are in the same tailnet (or shared access is granted).
3. Get the server Tailscale IP (usually `100.x.y.z`) from the Tailscale app.
4. Keep OwnCord on port `8443`.
5. Connect clients to `https://<tailscale-ip>:8443`.

> **Admin panel over Tailscale:** chat works out of the box, but `/admin`,
> `/api/v1/metrics`, and the LiveKit health/webhook routes are gated by
> `server.admin_allowed_cidrs`, whose default covers only loopback and
> RFC1918 private ranges — Tailscale's `100.x.y.z` addresses (CGNAT range
> `100.64.0.0/10`) are **not** included and will get a 403. To administer
> over the tailnet, add it to your `config.yaml`:
>
> ```yaml
> server:
>   admin_allowed_cidrs:
>     - "127.0.0.0/8"
>     - "100.64.0.0/10" # Tailscale tailnet
> ```

## TLS Recommendation

- Recommended: keep `tls.mode: self_signed` (default).
- Optional advanced setup: set `tls.mode: off` only if every client is strictly inside trusted Tailscale access and you accept plaintext inside the tailnet.

## Voice/Video with Tailscale

- Tailscale handles device-to-device reachability, but LiveKit still needs correct runtime config.
- Follow [livekit-setup.md](livekit-setup.md) for LiveKit key/secret and port behavior.

## Benefits

- No router port forwarding.
- Works behind CGNAT.
- Stable private IPs.
- Encrypted transport by default.
