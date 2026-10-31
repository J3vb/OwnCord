# Port Forwarding Guide

This guide is for server owners who want people outside their home network to
reach their OwnCord server. It shows which ports to forward on your router. It
also explains the cases where port forwarding cannot work, and how to spot
them.

## Before You Start

**There is an easier option.** [Tailscale](tailscale.md) gives remote access
without any port forwarding. It also works behind CGNAT (see below), where port
forwarding cannot work at all.

**You do not need a reverse proxy.** OwnCord handles its own HTTPS. It also
passes voice signalling through its own port. If you want nginx or Caddy in
front anyway, see
[Behind a reverse proxy](hosting/tls-and-proxy.md#behind-a-reverse-proxy-off). Nothing on this
page needs one.

## What the server can and cannot tell you

Every time it starts, the server prints what kind of address it is running
on, in the start-up banner. For example:

```
    Address  LAN only — this host has no public address. Remote access needs port
             forwarding or a tunnel: see docs/port-forwarding.md.
```

That is as far as it can honestly go. **A server cannot test, from inside your
network, whether the outside world can reach it.** Only something outside can
prove that. OwnCord does not contact any outside service to test this. Its
diagnostics stay local, and it sends no telemetry. So you have to check the
items below yourself. This guide shows you how.

| What you want to know          | Can the server tell? | Why not                                               |
| ------------------------------ | -------------------- | ----------------------------------------------------- |
| Port forwarded correctly       | **No**               | It needs a connection from outside                    |
| ISP blocking a port            | **No**               | From inside, this looks the same as a missing rule    |
| CGNAT                          | **No**               | It cannot see your router's internet-side address     |
| Hairpin NAT                    | **No**               | It is how your router behaves, for an unknown address |
| Public IP changed              | **No**               | The server never learns its public address            |
| What kind of address it has    | Yes                  | It can read its own network interfaces                |
| Whether voice is misconfigured | Partly               | It warns when `voice.node_ip` is not a public address |

### The connectivity check

In the admin panel, open the **Dashboard**. Under **Connectivity check**,
press **Run check**. Only administrators can do this.

It shows:

- whether the voice server answers
- the voice node IP
- the address your own connection comes from, and what kind of address it is

The same report is available as JSON at
`GET /api/v1/diagnostics/connectivity`, for administrators.

**Optional extra detail.** The Owner can turn on
`server.reachability_report_enabled`. The Dashboard card then also shows the
ports to forward, and a list of what the server cannot work out. The JSON gains
a `reachability` block with an `undeterminable` list. This is off by default,
because it lists every address on every network interface. It does not contact
anything on the network.

## Required Ports

The full list is the main port table in
[Server reference](hosting/reference.md#ports-in-detail). These are the rows this
guide uses.

### Always required

| Port   | Protocol | Purpose                                             |
| ------ | -------- | --------------------------------------------------- |
| `8443` | TCP      | OwnCord HTTPS and WebSocket                         |
| `80`   | TCP      | ACME HTTP-01 challenge (only with `tls.mode: acme`) |

### Required only for voice and video

| Port          | Protocol | Purpose              |
| ------------- | -------- | -------------------- |
| `7881`        | TCP      | LiveKit TCP fallback |
| `50000-60000` | UDP      | LiveKit media        |

**On Docker** (the compose stack or the single image) the media port is
`7882/UDP`, not the range. Compose publishes exactly `8443/TCP`, `7881/TCP` and
`7882/UDP`. If you used to forward `50000-60000/UDP` for compose, forward
`7882/UDP` instead and close the old range.

**Do not forward `7880/TCP`.** Clients reach LiveKit's signalling through
OwnCord's own `:8443/livekit` path (see
[TLS and reverse proxies](hosting/tls-and-proxy.md#behind-a-reverse-proxy-off)). Forwarding 7880 only
exposes LiveKit's API for no reason.

### The voice port is where things go wrong

Chat needs one TCP port, and it is easy to get right. Voice also needs UDP
ports for the sound and video itself ("media"). Forgetting them causes the most
confusing failure in OwnCord:

1. Joining a voice channel **works**, because signalling uses OwnCord's own
   port.
2. Then **nobody hears anything**, because the media never arrives.

### Using one UDP port instead of a range

By default the media uses the range `50000-60000/UDP`, which is 10,000 ports.
If your router or firewall makes a range awkward, use a single UDP port
instead.

**When OwnCord runs LiveKit** (the normal case outside Docker):

1. Set `voice.udp_port` in `config.yaml`, for example `7882`.
2. OwnCord writes `rtc.udp_port: 7882` into the `livekit.yaml` it generates.
3. Forward just that one port.

**On Docker**, you do not need to do anything. The compose stack, the
single-container image and the Unraid template already use one UDP port,
`7882`. Compose pins it with flags, so an older `livekit.yaml` that still names
a port range cannot bring the range back.

On bare LiveKit that you configure yourself, LiveKit prefers a
`port_range_start/end` in `livekit.yaml` to `udp_port`. Delete the range when
you set `udp_port`, and use one form or the other, never both.

### Two things voice needs together

1. **Forward the media ports.** That is `50000-60000/UDP` by default, or your
   single UDP port (`7882/UDP` on Docker). Also forward `7881/TCP`.
2. **Give LiveKit an address that remote clients can reach.** LiveKit tells
   clients this address in its connection offers (ICE candidates).
   - **Best: leave `voice.node_ip` empty.** OwnCord's generated `livekit.yaml`
     then sets `use_external_ip: true`, and LiveKit finds your public address
     itself when it starts. This is the right choice on a changing IP (see
     [Dynamic public IP](#dynamic-public-ip)).
   - **On the Docker stack**, LiveKit reads your own `livekit.yaml`. Keep the
     example's `rtc.use_external_ip: true` there.
   - **Set `voice.node_ip` only when detection cannot work**, for example on a
     Tailscale-only host, or a network that blocks LiveKit's lookup. On Docker,
     replace `rtc.use_external_ip` with `rtc.node_ip`. While detection is on,
     LiveKit overwrites `node_ip` with what it detects.
   - A private address here gives remote clients an address they cannot reach.
     The server warns at start-up if `voice.node_ip` is not a public address.

A reverse proxy cannot carry voice media. No HTTP proxy can.

## Router Steps

1. Open your router's admin page. It is often at `192.168.1.1` or
   `192.168.0.1`.
2. Find the port forwarding section. It may be called NAT, virtual server, or
   firewall rules.
3. Give your server machine a fixed (static or reserved) LAN address.
4. Add a rule that forwards `8443/TCP` to that address.
5. For voice and video, also forward `7881/TCP` and `50000-60000/UDP`. Or
   forward your single UDP port instead of the range. On Docker, forward
   `7881/TCP` and `7882/UDP`.
6. Save and apply the rules.

## Connect Address to Share

Give your users `https://<your-public-ip>:8443`, or your DNS name.

**Test it from a network that is not yours.** A phone on mobile data, with
Wi-Fi turned off, is a reliable test. A test from inside your own network
proves nothing. It can even fail for reasons that have nothing to do with your
rules. See hairpin NAT below.

## When It Does Not Work

### Blocked ports

Many home internet providers block incoming traffic on ports `80` and `443`.
High ports like `8443` are usually left alone. That is why `8443` is the
default.

- **Symptom:** everything looks right, but nothing connects from outside.
- **Check:** if a high port works and `443` does not, your provider is blocking
  it. Your setup is fine.
- **Note:** `tls.mode: acme` needs incoming port `80` for its HTTP-01
  challenge. If your provider blocks `80`, ACME cannot get a certificate. The
  server logs the failure at the first connection attempt.

### CGNAT (carrier-grade NAT)

With CGNAT, your provider puts many customers behind one shared public
address. **You have no public address of your own, so no port forwarding rule
can ever work.** It is common on mobile broadband, Starlink, and many fibre and
cable plans.

- **Check:** compare the internet-side (WAN) address on your router's status
  page with what a "what is my IP" website shows. If they differ, you are
  behind CGNAT. A router WAN address inside `100.64.0.0/10` means the same.
- **Fix:** use [Tailscale](tailscale.md). Or ask your provider for a public IP
  address. Many offer one on request, sometimes for a fee.
- **The server cannot detect this for you.** It only sees its own LAN address,
  not your router's WAN address. If the server itself has an address in
  `100.64.0.0/10`, it says so. But even then it cannot tell whether that is
  carrier NAT or Tailscale, because both use that range.

### Hairpin NAT (NAT loopback)

Remote users connect fine, but devices on your own network cannot reach your
public address. Some routers will not send traffic back into the network it
came from.

- **Symptom:** it works on mobile data, but fails on your own Wi-Fi.
- **Fix:** give users on your network the server's local address. Or use
  split-horizon DNS, so your hostname points to the local address at home and
  the public address everywhere else.
- **The server cannot detect this for you.** It depends on your router, and on
  a public address the server does not know.

### Dynamic public IP

Most home connections get a new public address from time to time: after a
reboot, an outage, or on the provider's own schedule. Two things can break at
once: the address clients type, and the media address LiveKit tells clients.

- **For clients:** use dynamic DNS, and share a hostname rather than an IP
  address.
- **For media (`voice.node_ip`):** leave it **empty** on a changing address.
  - OwnCord's generated `livekit.yaml` then sets `use_external_ip: true`, so
    LiveKit finds its public address itself. But it only does this when it
    starts.
  - **After an IP change, restart the OwnCord server.** LiveKit then picks up
    the new address. Until then it keeps using the old one.
  - A pinned `voice.node_ip` goes out of date silently when the address
    changes. Calls connect, because signalling still works, and then nobody
    hears anything. If you pinned it, clear or update it after an IP change,
    then restart the server so `livekit.yaml` is written again.
- **For media on the Docker stack:** LiveKit uses your own `livekit.yaml` and
  never reads `voice.node_ip`. Use `rtc.use_external_ip: true` there (the
  example's default), not a pinned `rtc.node_ip`. After an IP change, run
  `docker compose restart livekit`.
- **The server cannot detect this for you.** It never learns its public
  address, so it cannot notice a change and will not restart LiveKit for you.
  The restart above is what fixes an address change without editing any
  config.

### Firewalls

There are usually two firewalls, and both must allow the traffic:

- the **router** firewall, which a forwarding rule normally opens
- the **host** firewall on the machine running OwnCord, such as `ufw`,
  `firewalld` or Windows Defender Firewall

On Windows, the first run often asks for firewall access. If you declined that
prompt, it looks exactly like a bad forwarding rule.

## What this build does not do

These limits are stated plainly, so you do not discover them at a bad moment.
The certificate work is planned for a later release. Until then:

- **No HTTPS on a bare public IP.** `tls.mode: acme` needs a hostname and
  refuses an IP address. Let's Encrypt has issued IP certificates since January
  2026, but this build's ACME client cannot request them. On a raw IP, use
  `tls.mode: manual` with your own certificate. Or stay on `self_signed`, and
  accept it once on each client.
- **Domain ACME works, but is not tested at release quality.** It has not been
  tested against certificate expiry, rotation and restart the way the release
  will require.
- **No guided trust setup for LAN or offline devices.** Trusting a self-signed
  certificate is a manual step on each device today.
- **Certificate lifecycle is not fully tested.** Hot reload, and keeping
  renewal state across a restart, are not yet proven.
- **The server never checks whether it can be reached from outside.** This is
  by design, not an oversight. See the table at the top.

## Outbound traffic

OwnCord sends no telemetry. But it does make some outgoing connections. The
full list of outgoing connections, with what triggers each one and what it
sends, is in
[diagnostics.md](architecture/diagnostics.md#egress-inventory). The ones an
offline owner is most likely to meet:

- **LiveKit's STUN lookup at start-up.** With voice on, a default install asks
  a public STUN server for its external address (`use_external_ip: true`).
  That is LiveKit's own behaviour. OwnCord reports nothing about you.
- **The LiveKit download on first start.** Only if
  `voice.auto_download_livekit` is on and no `voice.livekit_binary` is set. It
  is one checksum-checked download from GitHub.
- **`api.github.com` on an update check.** This happens when an admin checks
  for updates, or when a client checks for its own update. It is optional.
  Setting `github.token` only raises the rate limit.

None of this is automatic product telemetry. Each item is a feature you turned
on, an admin action, or LiveKit's own behaviour.

## Troubleshooting Checklist

- Check the server is listening on `8443`.
- Check the router rules point to the right LAN address.
- Check the **host** firewall allows the forwarded ports, not just the router.
- Check your provider is not blocking the port. Try a high port if `443` fails.
- Check you are not behind CGNAT. Compare the router's WAN address with a
  "what is my IP" website.
- Test from a different network, such as a phone hotspot. Never test from the
  same network.
- For voice, check that `50000-60000/UDP` (or your single UDP port, `7882/UDP`
  on Docker) is
  forwarded, **and** that LiveKit advertises your current public address.
  Leave `voice.node_ip` empty, or set it to your current public IP. "Joins but
  no sound" is almost always one of these two.

## See Also

- [Tailscale Guide](tailscale.md) — works behind CGNAT, no forwarding needed
- [Deployment Guide](deployment.md) — TLS modes, port table, reverse proxy
- [LiveKit Setup](livekit-setup.md) — voice configuration in detail
