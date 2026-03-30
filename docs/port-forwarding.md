# Port Forwarding Guide

How to make your OwnCord server accessible to friends outside your local network.

## Why

Friends outside your LAN need a way to reach your server. Port forwarding tells your router to send incoming traffic on a specific port to your server machine.

## Steps

1. **Find your router's admin page** -- usually `192.168.1.1` or `192.168.0.1`. Check your gateway IP with `ipconfig` (Windows) or `ip route` (Linux).
2. **Find the port forwarding section** -- may be listed under "NAT", "Virtual Servers", or "Firewall" depending on your router.
3. **Add a rule for the server:**
   - External port: `8443`
   - Internal IP: your server machine's local IP
   - Internal port: `8443`
   - Protocol: TCP
4. **Add a rule for voice chat** (if using voice/video):
   - External port: `3478`
   - Internal IP: your server machine's local IP
   - Internal port: `3478`
   - Protocol: UDP
5. **Find your public IP** at a site like `whatismyip.com`.
6. **Share your public IP and port** with friends: `your.public.ip:8443`

## Troubleshooting

Windows Firewall may block incoming connections. `chatserver.exe` should prompt on first run to allow access. If not, manually add a firewall rule for port 8443 (TCP) and 3478 (UDP).

## Dynamic IP

If your public IP changes frequently, consider a Dynamic DNS service (e.g., No-IP, DuckDNS) so friends can use a stable hostname instead of a raw IP address.
