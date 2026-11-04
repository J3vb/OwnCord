# TLS and reverse proxies

TLS is the encryption between the apps and your server. The server handles it
itself by default, so you can skip this page unless you want your own domain or
already run a web server in front.

## Pick a mode

Set `tls.mode` in `config.yaml`:

| Mode          | Use it when                                                 |
| ------------- | ----------------------------------------------------------- |
| `self_signed` | The default. Works anywhere, even on a bare IP address.     |
| `acme`        | You have a domain and want the server to get Let's Encrypt. |
| `manual`      | You already have certificate files.                         |
| `off`         | Only behind a reverse proxy that does HTTPS for you.        |

**For a public domain, a reverse proxy is the recommended setup.** Caddy, nginx
or Traefik renew certificates reliably. The built-in `acme` mode works, but its
renewals have not been tested as thoroughly.

What each mode means for the people who connect: [trust-model.md](../trust-model.md).

## How the apps trust your server

The desktop app remembers your server's certificate the first time it connects
(this is called pinning). If the certificate changes later, the app shows a
**Certificate Changed** warning.

- A normal Let's Encrypt renewal does **not** warn, as long as the first
  certificate was a public one for your domain.
- A new self-signed certificate, or any change on a server reached by IP
  address, **does** warn.

## Self-signed (the default)

```yaml
tls:
  mode: "self_signed"
```

The server makes a certificate on first start, valid for two years. It never
renews it. An expired one keeps working, because the app trusts the
fingerprint, not the dates. Still, replace it before two years are up. The
admin Dashboard warns you three weeks ahead.

### Replacing the self-signed certificate

1. Stop the server.
2. Move `data/cert.pem` and `data/key.pem` somewhere else. Do not delete them
   yet.
3. Start the server. It makes a new pair.
4. Copy the new fingerprint from the admin Dashboard.
5. Tell every member. Each app shows the certificate warning once. Ask people
   to compare the fingerprint **character for character** before they accept.

Post the fingerprint somewhere members already trust, such as another chat app
or a call. Not inside OwnCord: they cannot read it until they have accepted.

## Let's Encrypt (acme)

```yaml
tls:
  mode: "acme"
  domain: "chat.example.com"
```

You need a domain that points at the server, and port `80` open to the
internet. An IP address does not work. On Linux under systemd, also allow port
80 (see [Linux service](../deployment.md#running-as-a-linux-service-systemd)).

## Your own files (manual)

```yaml
tls:
  mode: "manual"
  cert_file: "path/to/cert.pem"
  key_file: "path/to/key.pem"
```

The files are read once at start. Restart after you replace them. Keep the key
private (file mode `0600`).

## Behind a reverse proxy (off)

Set `tls.mode: "off"` and let the proxy do HTTPS. Then three things:

1. **Keep port 8443 private.** With TLS off, 8443 is plain, unencrypted HTTP.
   Only the proxy may reach it.
   - Docker: publish it as `127.0.0.1:8443:8443`. The shipped compose file
     publishes it to everyone, so change it.
   - Without Docker: allow 8443 only from the proxy in your firewall, and do not
     forward it on your router.
   - Check from another machine: `curl --max-time 5 http://<host>:8443/api/v1/health`
     must fail.
2. **Tell OwnCord where the proxy is.** Set `server.trusted_proxies` to the
   proxy's address, for example `["127.0.0.1/32", "::1/128"]` for a proxy on
   the same machine. Without it, every visitor looks like the proxy, and rate
   limits hit everyone at once. List only proxies, never client networks.
3. **Voice does not go through the proxy.** Chat, the admin panel, uploads and
   voice sign-in all go over 8443. The voice media ports (`7881/TCP` and the UDP
   port or range) must still reach the server directly.

A working nginx example:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8443;    # https:// if OwnCord keeps its own TLS
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;             # chat connections stay open
        proxy_send_timeout 300s;
        client_max_body_size 101m;           # your upload limit plus 1 MB
    }
}
```

To get the fingerprint members need when the proxy holds the certificate:

```sh
openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr 'A-F' 'a-f'
```

## Cloudflare or another CDN in front

Now there are two hops, and OwnCord must know both. Pick one:

- **List the CDN too.** Add Cloudflare's published ranges
  ([cloudflare.com/ips](https://www.cloudflare.com/ips/)) to
  `server.trusted_proxies`, next to your proxy. Update them when Cloudflare
  changes its list.
- **Let the proxy fix the address.** In nginx (or Nginx Proxy Manager's
  Advanced tab), and keep `trusted_proxies` at your proxy alone:

  ```nginx
  real_ip_header CF-Connecting-IP;
  set_real_ip_from 173.245.48.0/20;   # one line per Cloudflare range
  ```

Without either, many users share one CDN address and rate limits lock them out
together.

## Known gaps

- No HTTPS with a public certificate on a bare IP address.
- No guided way to trust a certificate on a LAN or offline device.
- Renewal across restarts is not fully tested for `acme`.

Details: [what this build does not do](../port-forwarding.md#what-this-build-does-not-do).
