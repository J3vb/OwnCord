# Port Forwarding Guide

How to make your OwnCord server reachable from outside your LAN.

## Before You Start

If you want a simpler remote-access path, use [Tailscale](tailscale.md) and skip manual forwarding.

## Required Ports

### Always required

| Port   | Protocol | Purpose                   |
| ------ | -------- | ------------------------- |
| `8443` | TCP      | OwnCord HTTPS + WebSocket |

### Required only for voice/video

| Port          | Protocol | Purpose              |
| ------------- | -------- | -------------------- |
| `7880`        | TCP      | LiveKit signaling    |
| `7881`        | TCP      | LiveKit TCP fallback |
| `50000-60000` | UDP      | LiveKit media        |

## Router Steps

1. Open your router admin page (often `192.168.1.1` or `192.168.0.1`).
2. Find the port forwarding section (sometimes called NAT, virtual server, or firewall rules).
3. Set static/reserved LAN IP for your server machine.
4. Add forwarding rule for `8443/TCP` to that LAN IP.
5. If using voice/video, add `7880/TCP`, `7881/TCP`, and `50000-60000/UDP`.
6. Save and apply rules.

## Connect Address to Share

Share `https://<your-public-ip>:8443` (or your DNS name) with users.

## Troubleshooting Checklist

- Confirm the server is listening on `8443`.
- Confirm router rules point to the correct LAN IP.
- Confirm OS firewall allows forwarded ports.
- Confirm ISP is not blocking inbound ports.
- Test from a different network (mobile hotspot), not from the same LAN.

## Dynamic Public IP

If your public IP changes, use dynamic DNS so users connect with a stable hostname.
