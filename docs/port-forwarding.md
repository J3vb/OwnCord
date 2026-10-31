# Port forwarding

Let people outside your home reach your server by opening ports on your
router.

**Easier option:** [Tailscale](tailscale.md) needs no router changes, and also
works where port forwarding never can (CGNAT, below).

You do not need a reverse proxy for this. If you want one anyway, see
[TLS and reverse proxies](hosting/tls-and-proxy.md#behind-a-reverse-proxy-off).

## Which ports

| Port              | Needed for                           |
| ----------------- | ------------------------------------ |
| `8443/TCP`        | Chat. Always.                        |
| `7881/TCP`        | Voice and video.                     |
| `7882/UDP`        | Voice and video, **with Docker**.    |
| `50000-60000/UDP` | Voice and video, **without Docker**. |
| `80/TCP`          | Only for built-in Let's Encrypt.     |

**Do not forward `7880`.** Voice sign-in already goes through `8443`.

Want one UDP port instead of 10,000 without Docker? Set `voice.udp_port: 7882`
in `config.yaml` and forward just that.

## Router steps

1. Open your router's admin page (often `192.168.1.1` or `192.168.0.1`).
2. Give the server machine a fixed (reserved) local address.
3. Find **port forwarding** (sometimes called NAT, virtual server or firewall
   rules).
4. Forward the ports above to that address.
5. Save.
6. Also allow the ports in the server machine's own firewall (`ufw`,
   `firewalld` or Windows Defender Firewall). On Windows, the first start
   often asks; if you said no, it looks just like a bad router rule.

Give your friends `https://<your-public-ip>:8443`, or a hostname.

## Test it from outside

**Test from a different network.** A phone on mobile data with Wi-Fi off is
best. A test from your own network proves nothing.

The server cannot test this for you: only something outside your network can.
It does not contact any outside service to check. What it can show is in the
admin panel under **Dashboard → Connectivity check**: whether voice answers,
the voice address and where your own connection comes from.

## Voice joins, but nobody hears anything

This is the most common problem. Joining works through `8443`, but the sound
travels over the UDP port, so a missing UDP rule only shows once people talk.
Check two things:

1. **The UDP port is forwarded**, and `7881/TCP` too.
2. **Voice knows your public address.** Leave `voice.node_ip` empty so it
   finds the address itself. In Docker, keep `use_external_ip: true` in
   `livekit.yaml`. Only set a fixed address when detection cannot work, such
   as on a Tailscale-only machine. The server warns at start-up if the address
   you set is not a public one.

## When it still does not work

### Your provider blocks the port

Many home providers block incoming `80` and `443`. High ports like `8443`
usually work, which is why it is the default. If you use built-in Let's
Encrypt and port 80 is blocked, it cannot get a certificate.

### CGNAT (no public address of your own)

Your provider shares one public address between many customers. **No
forwarding rule can ever work.** Common on mobile broadband, Starlink and many
fibre and cable plans.

- **Check:** compare the internet (WAN) address on your router's status page
  with what a "what is my IP" website says. Different means CGNAT. A router
  address starting `100.64` to `100.127` means the same.
- **Fix:** use [Tailscale](tailscale.md), or ask your provider for a public
  address.

### It works on mobile data but not at home (hairpin NAT)

Some routers will not send traffic to your own public address from inside.
People at home should use the server's local address instead.

### Dynamic public IP

Most home connections get a new public address now and then.

- **For people connecting:** use a dynamic DNS name instead of the address.
- **For voice:** leave `voice.node_ip` empty, and **restart the server** after
  the address changes (in Docker: `docker compose restart livekit`). Voice only
  looks up the address when it starts. A fixed `voice.node_ip` goes stale
  silently: calls connect and nobody hears anything.

## What this build does not do

- **No HTTPS on a bare public IP** with a public certificate. Built-in Let's
  Encrypt needs a hostname. On a raw IP, keep the default certificate (people
  accept it once) or use your own files.
- **Let's Encrypt renewal across restarts is not fully tested.**
- **No guided way to trust a certificate** on LAN or offline devices.
- **The server never checks whether it can be reached from outside.** That is
  on purpose.

## Outgoing connections

OwnCord sends no telemetry. It does connect out for a few things you turned
on:

- **Voice start-up:** LiveKit asks a public STUN server for your address.
- **First start:** the voice server download from GitHub, if the server runs
  voice itself.
- **Update checks:** `api.github.com`, when an admin or an app checks for
  updates.

The full list is in [diagnostics.md](architecture/diagnostics.md#egress-inventory).

## Checklist

- [ ] The server is running and listening on `8443`.
- [ ] Router rules point at the right local address.
- [ ] The server machine's own firewall allows the ports.
- [ ] You are not behind CGNAT.
- [ ] You tested from another network.
- [ ] For voice: the UDP port is forwarded and `voice.node_ip` is empty.
