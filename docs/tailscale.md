# Tailscale Guide (Zero-Config Alternative)

Use Tailscale for secure, zero-config networking without port forwarding.

## What is Tailscale

Tailscale is a mesh VPN that creates encrypted tunnels between your devices using WireGuard. No port forwarding, no dynamic DNS, and it works behind CGNAT. Free for personal use.

## Setup

1. **Install Tailscale** on the server machine and each client machine: https://tailscale.com/download
2. **Sign in** with the same Tailscale account (or share the machine using Tailscale's sharing feature)
3. **Find the server's Tailscale IP** -- shown in the Tailscale app, typically `100.x.y.z`
4. **Disable TLS in config** -- set `tls.mode` to `"off"` in `config.yaml` since Tailscale already encrypts all traffic with WireGuard
5. **Connect clients** using the Tailscale IP: `100.x.y.z:8443`

## Benefits

- No port forwarding needed
- Works behind CGNAT and strict firewalls
- Encrypted by default (WireGuard)
- Stable IPs that don't change
- Easy to add/remove friends via the Tailscale admin console
