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
