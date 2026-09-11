# Port Forwarding Guide

How to make your OwnCord server reachable from outside your LAN — and how to
recognise the cases where it cannot be made to work at all.

## Before You Start

If you want a simpler remote-access path, use [Tailscale](tailscale.md) and skip
manual forwarding. It works in the CGNAT case below, where port forwarding
cannot.

**A reverse proxy is not required.** OwnCord terminates its own TLS and proxies
LiveKit signalling through its own port. If you want to put nginx or Caddy in
front anyway, see [Reverse Proxy Topology](deployment.md#reverse-proxy-topology)
— but nothing here needs one.

## What the server can and cannot tell you

The server reports the kind of address it is running on, in the startup banner,
every time it starts:

```
    Address  LAN only — this host has no public address. Remote access needs port
             forwarding or a tunnel: see docs/port-forwarding.md.
```

That is as far as it can honestly go. **A server cannot test its own inbound
reachability from inside its own network.** Proving that something outside can
reach you requires something outside to try, and OwnCord contacts no such
service — diagnostics stay local and the server reports no telemetry
(BPR-055). So everything in the table below is yours to check, and the guide
tells you how.

| Limit                          | Can the server detect it? | Why not                                                    |
| ------------------------------ | ------------------------- | ---------------------------------------------------------- |
| Port forwarded correctly       | **No**                    | Needs an outside connection back in                        |
| ISP blocking a port            | **No**                    | Looks identical to a missing forwarding rule from in here  |
| CGNAT                          | **No**                    | This host cannot see your router's WAN address             |
| Hairpin NAT                    | **No**                    | A property of your router, for an address it does not know |
| Public IP changed              | **No**                    | The server never learns its public address                 |
| Which address class it has     | Yes                       | It can read its own interfaces                             |
| Whether voice is misconfigured | Partly                    | It warns when `voice.node_ip` is not a public address      |

An owner who wants that detail as JSON can switch on
`server.reachability_report_enabled` and read
`GET /api/v1/diagnostics/connectivity` as an administrator. It reports the same
facts plus an `undeterminable` list. It is off by default because it enumerates
every address on every interface.

## Required Ports

### Always required

| Port   | Protocol | Purpose                   |
| ------ | -------- | ------------------------- |
| `8443` | TCP      | OwnCord HTTPS + WebSocket |

### Required only for voice/video

| Port          | Protocol | Purpose              |
| ------------- | -------- | -------------------- |
| `7880`        | TCP      | LiveKit signalling   |
| `7881`        | TCP      | LiveKit TCP fallback |
| `50000-60000` | UDP      | LiveKit media        |

**This is where port forwarding actually goes wrong.** Chat needs one TCP port
and is easy to get right. Voice needs a 10,000-port UDP range, and forgetting it
produces the most confusing failure in the whole system: joining a voice channel
**succeeds**, because signalling travels over OwnCord's own port — and then
nobody hears anything, because the media never arrives.

Two things are needed together:

1. Forward `50000-60000/UDP` (and `7880/TCP`, `7881/TCP`) to the server.
2. Set `voice.node_ip` to your **public** address. It is the address LiveKit
   advertises in its ICE candidates, so a private value hands remote clients
   something they cannot route to. The server warns at start-up if it is not a
   public address.

A reverse proxy cannot carry the UDP range. No HTTP proxy can.

## Router Steps

1. Open your router admin page (often `192.168.1.1` or `192.168.0.1`).
2. Find the port forwarding section (sometimes called NAT, virtual server, or
   firewall rules).
3. Set a static/reserved LAN IP for your server machine.
4. Add a forwarding rule for `8443/TCP` to that LAN IP.
5. If using voice/video, add `7880/TCP`, `7881/TCP`, and `50000-60000/UDP`.
6. Save and apply rules.

## Connect Address to Share

Share `https://<your-public-ip>:8443` (or your DNS name) with users.

**Test it from a network that is not yours.** A phone on mobile data with Wi-Fi
switched off is the reliable check. Testing from inside your own LAN proves
nothing, and can fail for a reason that has nothing to do with your forwarding
rules — see hairpin NAT below.

## When It Does Not Work

### Blocked ports

Many residential ISPs block inbound `80` and `443`. High ports like `8443` are
usually left alone, which is why that is the default.

- **Symptom:** everything looks right, nothing connects from outside.
- **Check:** if a high port works and `443` does not, that is your ISP, not your
  configuration.
- **Note:** `tls.mode: acme` needs inbound `80` for the HTTP-01 challenge. If
  your ISP blocks `80`, ACME cannot issue a certificate — the server logs the
  failure at the first connection attempt.

### CGNAT (carrier-grade NAT)

Your ISP puts many customers behind one public address. **You have no public
address of your own, so no port forwarding rule can ever work.** This is common
on mobile broadband, Starlink, and many fibre and cable plans.

- **Check:** compare the WAN address on your router's status page against what a
  what-is-my-IP page reports. If they differ, you are behind CGNAT. A router WAN
  address inside `100.64.0.0/10` is the same conclusion.
- **Fix:** use [Tailscale](tailscale.md), or ask your ISP for a public IP
  address — many offer one on request, sometimes for a fee.
- **The server cannot detect this for you.** It sees only its own LAN address;
  your router's WAN address is not visible from the server. If the server itself
  holds a `100.64.0.0/10` address it says so, but even then it cannot tell you
  whether that is carrier NAT or Tailscale, because both use that range.

### Hairpin NAT (NAT loopback)

Remote users connect fine, but devices on your own LAN cannot reach your public
address. The router will not route a packet back into the network it came from.

- **Symptom:** works on mobile data, fails on your own Wi-Fi.
- **Fix:** give LAN clients the server's local address, or run split-horizon DNS
  so your hostname resolves to the LAN address inside the house and the public
  address outside.
- **The server cannot detect this for you.** It is behaviour of your router,
  for a public address the server does not know.

### Dynamic public IP

Most residential connections get a new public address periodically — after a
reboot, an outage, or on the ISP's own schedule. Every client that saved the old
address stops connecting, all at once, for no visible reason.

- **Fix:** use dynamic DNS and share a hostname rather than an IP literal.
- **The server cannot detect this for you.** It never learns its public address,
  so it cannot notice the address changing.

### Firewalls

There are usually two, and both have to allow the traffic:

- the **router** firewall, which the forwarding rule normally opens; and
- the **host** firewall on the machine running OwnCord (`ufw`, `firewalld`,
  Windows Defender Firewall).

On Windows, the first run often prompts for firewall access — a declined prompt
looks exactly like a bad forwarding rule.

## What this build does not do

Stated plainly so it is not discovered at the worst moment. The certificate work
(B6-3 – B6-5) is deferred to the release, so:

- **No HTTPS on a bare public IP.** `tls.mode: acme` requires a hostname and
  rejects an IP address. Let's Encrypt has issued IP certificates since January
  2026, but this build's ACME client cannot request them. On a raw IP, use
  `tls.mode: manual` with your own certificate, or stay on `self_signed` and
  accept it on each client.
- **Domain ACME is implemented but not qualified at release quality.** It works;
  it has not been exercised against certificate expiry, rotation and restart the
  way the release will require.
- **No guided LAN or offline device-trust install.** Trusting a self-signed
  certificate is a manual, per-device step today.
- **No qualified certificate lifecycle.** Hot reload and renewal-state survival
  across restart are not yet proven.
- **The server never verifies inbound reachability.** By design, not omission —
  see the table at the top.

## Outbound traffic

A default install with voice enabled makes one outbound connection you should
know about: `livekit-server` is configured with `use_external_ip: true` and
queries a public STUN server at start-up to discover its external address. That
is the SFU's own behaviour, not OwnCord reporting anything about you. OwnCord
itself contacts no external service.

## Troubleshooting Checklist

- Confirm the server is listening on `8443`.
- Confirm the router rules point to the correct LAN IP.
- Confirm the **host** firewall allows the forwarded ports, not just the router.
- Confirm your ISP is not blocking the port — try a high port if `443` fails.
- Confirm you are not behind CGNAT — compare the router WAN address with a
  what-is-my-IP page.
- Test from a different network (mobile hotspot), never from the same LAN.
- For voice, confirm `50000-60000/UDP` is forwarded **and** `voice.node_ip` is
  your public address. "Joins but no audio" is almost always one of these two.

## See Also

- [Tailscale Guide](tailscale.md) — works behind CGNAT, no forwarding needed
- [Deployment Guide](deployment.md) — TLS modes, firewall table, reverse proxy
- [LiveKit Setup](livekit-setup.md) — voice configuration in detail
