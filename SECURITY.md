# Security Policy

This page tells you how to report a security problem in OwnCord. It also
sets out OwnCord's security model and the security rules every contributor
must follow.

## Supported versions

OwnCord is in beta. Only the **latest release** gets security fixes. Older
releases do not get backported fixes.

| Version                                                                   | Supported |
| ------------------------------------------------------------------------- | --------- |
| Latest release (see [Releases](https://github.com/J3vb/OwnCord/releases)) | Yes       |
| Anything older                                                            | No        |

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Report it privately with a GitHub Security Advisory:

1. Go to the
   [OwnCord security advisories page](https://github.com/J3vb/OwnCord/security/advisories/new).
2. Choose **Report a vulnerability**.

An advisory stays private until it is published. So this channel is safe,
even though the repository is public.

Please include:

- the affected part: server, desktop client, admin panel or plugin host
- steps to reproduce it, or a proof of concept
- the release version (or source snapshot) you tested

You will get a first reply within 7 days. Please give us time to fix it before
you share it publicly. The fix ships in the next release. We credit you unless
you would rather we did not.

## Hardening guide for operators

Notes on running a server safely are in [docs/security.md](docs/security.md).

---

## Security model and rules for contributors

This section is a short summary of the sources listed at the end. It was
written against commit `7732f969` (2026-09-25) and spot-checked against `dev`
on 2026-10-13. If it disagrees with the code, the code wins, then the source
documents. Any disagreement is a bug in this page.

### Trust model

- **The server operator can read everything the server stores or relays in
  plain form.** This covers channel messages, direct messages, uploaded files,
  the search index, names, timestamps, and who is where. This is by design:
  delivery, replay, search, moderation and backup all need it. Text chat is
  **not** end-to-end encrypted.
- **Voice, video and screen share are end-to-end encrypted (E2EE)** between
  the people in the call. The server relays wrapped keys and encrypted media
  as bytes it cannot read. It never holds the room key. An operator who only
  reads what the server stores or relays learns nothing about the call.
- **The server still controls who is in a call.** It decides who may join a
  voice channel. A client accepts and pins a new participant's identity key
  the first time it sees it. So a modified server could add a participant it
  controls and receive the room key. E2EE media protects against an operator
  who reads, not one who modifies the server. Pinning catches a known person's
  key changing. It does not catch an unknown person joining.
- **Passwords, session tokens and API tokens are never stored in plain
  form.**
  - Passwords are hashed with bcrypt (cost 12).
  - Session and API tokens are stored as SHA-256 hashes, never the token
    itself.
  - TOTP secrets are encrypted with a server-local AES-256 key. Secrets saved
    before that encryption existed are a known exception: they are read as
    they are, with a warning logged, and never rewritten in place.
- **Each server stands alone.** There is no federation, no messaging between
  servers, no directory or discovery, and no global identity. An account is a
  row in one server's database. The same username on two servers is two
  unrelated people.
  - Three tests in `Server/api/absence_contract_test.go` fail if a route, a
    WebSocket message type or a config key uses words like federation,
    directory, discovery or listing.
  - They check words, not behaviour. A feature that makes the server talk to
    another server must first update [docs/trust-model.md](docs/trust-model.md)
    ("What OwnCord does not have") and its outbound-connection table.
- **No control here protects against a hostile operator with shell access,
  E2EE media included.** Someone with root on the machine can edit the binary,
  the database or the configuration, and defeat any of these controls.

### Authentication and sessions

- Passwords are hashed with bcrypt (cost 12). TOTP codes are compared in
  constant time (`subtle.ConstantTimeCompare`).
- **One shared budget for bcrypt.** Every bcrypt computation on a sign-in
  route goes through one process-wide limit. This covers password checks,
  password hashes and recovery-code matching.
  - Login, registration and recovery-code checks over the limit wait in a
    queue for up to 10 seconds.
  - A refused attempt gets `429 AUTH_BUSY`. That happens when the queue is
    full, the wait runs out, or a password confirmation is over the limit. A
    refused attempt runs no bcrypt and does not count as a failed attempt.
- **Two-factor sign-in (TOTP).** Users enrol with a QR code and get backup
  codes. Admins can require 2FA for the whole server.
  - Second-factor state survives a restart: the login challenge, a pending
    enrolment and the 90-second replay window.
  - It is stored as SHA-256 digests (the challenge token and used codes) and
    as AES-256-GCM ciphertext under the TOTP key (a pending enrolment's
    secret). A token, code or secret is never stored in plain form.
- **Rate limits per IP address.**

  | Route                 | Limit       |
  | --------------------- | ----------- |
  | Login                 | 5 a minute  |
  | Registration          | 3 a minute  |
  | 2FA verification      | 10 a minute |
  | Account recovery      | 5 a minute  |
  | WebSocket connections | 60 a minute |

  `security.auth_rate_limit_multiplier` scales each limit (default 1.0).

- **Lockouts.** Ten failed logins within 15 minutes lock that username for 15
  minutes, whatever IP they came from. This count is never scaled, because it
  is the only defence that works across IP addresses. The same count, scaled,
  also locks the source IP.
- **How long things last.**
  - A session expires 30 days after it was last used, and never more than a
    year after sign-in. REST requests, the WebSocket handshake and the
    WebSocket heartbeat all count as use, at most once a minute.
  - A 2FA login challenge (`partial_token`) lasts 10 minutes. Five wrong codes
    revoke it.
  - A LiveKit access token lasts 5 minutes.
  - An API token lasts as long as its creator chose. One created without a
    lifetime never expires.
- **Sessions.**
  - A user can have up to 25 sessions. Past that, the oldest is removed.
  - Users can list and revoke their own sessions, and sign out everywhere.
    Signing out everywhere also revokes their API tokens.
  - Changing a password revokes every other session.
  - An admin can force-log-out a user, which revokes all their sessions.
- **Account recovery.** There are two ways: a recovery kit the user keeps, or
  recovery by the owner after checking the person's identity outside the app.
  - Both replace the password and revoke every session and API token, in one
    transaction.
  - Both then sign the person in without the second factor. This is by
    design: recovery exists for lost devices.
  - The kit is stored only as an argon2id verifier. The server cannot recover
    a used or lost kit.
  - The owner-issued credential works once and expires in 15 minutes.
  - Five failed attempts, per account or per address, lock recovery for 15
    minutes.
  - No administrator below the owner can reset another account's
    credentials.
- **First-run setup.** The setup endpoint creates the first Owner account. It
  cannot require a login, because no account exists yet. Instead it needs the
  one-time setup token that the server prints to its own console at start-up.
  It is also gated by a `setup_completed` flag. The server writes that flag
  once and never clears it. So emptying the users table (by account deletion
  or erasure) does not reopen setup to the next caller on an allowed network.

### Authorization

- **One check per rule.** Channel-level permission checks go through one
  function per property in `Server/permissions/predicates.go`
  (`CanViewChannel`, `CanSendMessage`, `CanJoinVoice`, `CanModerateVoice`, …).
  Each one takes a resolved `permissions.Subject`. So a caller cannot rebuild
  half a rule by hand.
- **Raw permission helpers are fenced off.** Outside `Server/permissions`, the
  raw bit helpers (`HasPerm`, `HasAnyPerm`, `HasServerPerm`, `HasAdmin`,
  `EffectivePerms`, `EffectiveChannelPerms`) may appear only in symbols listed
  in `AuthzResidueAllow` (`Server/invariants/authz_chokepoint.go`), with their
  exact call counts. Those are server-wide gates such as
  `api.RequirePermission` and `admin.requirePerm`, and administrator
  short-cuts. The `authz-chokepoint` invariant fails any other raw call. That
  list only shrinks.
- **Voice permission is checked twice.**
  1. At `voice_join`: the channel's `CONNECT_VOICE`, plus `READ_MESSAGES`
     outside a DM.
  2. Inside the LiveKit JWT itself: `CanPublishSources`, limited by role
     permission.

  The client is never the only check.

- **The admin panel is limited by IP address.** Only addresses in
  `admin_allowed_cidrs` can reach it. This is separate from the bearer-token
  admin auth on its API.
- **Rule for contributors:** never trust a permission or role the client
  claims. Every decision is checked again on the server, through the owning
  check function or route permission gate.

### Secrets and credentials

- **Server key files.** The data directory holds `totp.key`, `erasure.key` and
  `push_vapid.key`. An `OWNCORD_*` environment variable can override each.
  - All three use one loader: `loadOrGenerateKeyFile` in
    `Server/auth/totp_encrypt.go`.
  - A key is generated only when the file is confirmed missing. Any other read
    error stops the server from starting. Silently replacing the key would
    orphan every secret encrypted or named under it.
  - Writes are atomic.
  - A new key file must use the same loader.
- **Logs.** Values that carry secrets redact themselves when logged (see
  [Logging and redaction](#logging-and-redaction)). User IDs, usernames,
  session IDs, devices and IP addresses are logged on purpose. No `slog` call
  in server code logs message content.
- **Desktop credentials** go in the OS keyring (Windows Credential Manager,
  macOS Keychain or Secret Service). This covers the login token or password,
  the voice-E2EE identity private key and unsent message drafts.
  - Every write is read back and checked.
  - If the keyring refuses the write, or the check fails, the client uses an
    encrypted file instead. On Windows that is DPAPI with
    `CRYPTPROTECT_UI_FORBIDDEN`. Elsewhere it is ChaCha20-Poly1305 under a
    per-install key. Credentials are never stored as plain text.
- **A remembered password never goes back to JavaScript.** The field is
  `#[serde(skip)]` on the Rust credential struct, and a test locks this. The
  front end only gets `has_password` and a placeholder string. Submitting the
  placeholder makes Rust log in, over the same pinned tunnel a normal request
  uses.
- **Rule for contributors: do not widen what the web view can read.**
  - The web view holds the session token and the voice-E2EE identity private
    key by design. The remembered password stays on the Rust side. Never
    return it, or any new secret, over IPC.
  - Never log a token, password or message body.
  - Never widen a Tauri capability (file system scope, the loopback-only HTTP
    fetch scope, DevTools) or the CSP beyond what a feature needs. Both are
    least-privilege. `Client/tests/unit/capabilities-scope.test.ts` and
    `Client/tests/unit/tauri-conf-csp.test.ts` guard them.

### Input validation and content sanitization

- **IPC commands** check host format, string lengths and allowed characters.
  Push-to-talk key codes are range-checked. The LiveKit proxy checks
  `remote_host` for CRLF injection.
- **Uploads.** The composer checks size and file type first, against
  `auth_ok`'s `upload_policy`. The server has the final say:
  - It works out the type from the file's bytes.
  - It refuses executable and script signatures (`blockedMagic` in
    `Server/storage/storage.go`).
  - It refuses names the owner's file-type policy blocks
    (`storage.FileTypePolicy`). By default that blocks Windows scripts,
    installers and disk images by final extension. An owner can also set an
    allow-only list in the admin panel.
  - It serves HTML, SVG, XML, PDF and XSL as
    `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`.
  - Allowing an extension never lifts the signature blocks.
- **Rendering.** The desktop client renders all user content with
  `textContent`/`setText`, never `innerHTML`. The one exception works on a
  compile-time constant and has a runtime guard. Only `http:` and `https:`
  URLs are allowed. `image/svg+xml` is not a safe data-URI type. YouTube
  embeds are sandboxed.
- **Content from other websites** is fetched only by the desktop's native
  broker (`Client/src-tauri/src/external_content.rs`). This covers link
  previews, YouTube titles and thumbnails, inline external images, GIFs and
  external avatars. The broker:
  - uses `https` on port 443 only
  - checks every resolved address with the same list as `Server/safefetch`,
    and refuses loopback, private, link-local, multicast and other non-public
    addresses before it connects
  - follows at most three redirects, one at a time, by hand
  - limits time, bytes, content type and the number of fetches at once

  No broker call and no GIF-proxy search happens until the viewer chooses,
  once per server profile, to load automatically or to ask each time. Before
  choosing, they are told the linked site can see their IP address.

- **On the server**, `Server/safefetch` applies the same rules to outbound
  content: the Klipy GIF API proxy, the plugin `http` capability and Web Push
  sending. Attachments, avatars and emoji hosted by the connected server use
  the TOFU-pinned `http_proxy.rs`, never the broker. This is deliberate.
- **Rule for contributors:** a new automatic fetch of outside content must go
  through the broker (desktop) or `safefetch` (server), not a new HTTP client.
  Do not send server-hosted files through the broker, or outside content
  through `http_proxy.rs`.

### Voice and video E2EE

- **The room key is made on a participant's device** (WebCrypto), never on the
  server. One participant holds the key: always the lowest user ID in the
  channel. The key holder wraps the key for each person with ECDH + AES-GCM.
  The server passes the wrapped bytes on without decoding them.
- **Media is encrypted before it leaves the sender's device.** The LiveKit SFU
  only ever relays ciphertext.
- **Identity keys and pinning.**
  - Each install holds a long-lived ECDSA P-256 identity key per account and
    server (keychain account `identity:{userId}@{host}`).
  - Peers pin one key per account (`{host}:{userId}`) the first time they see
    it (trust on first use).
  - If that key later changes, the change is accepted automatically once the
    peer's announcement verifies against the new key. The pin is replaced.
    The user gets a lasting notice naming the peer, and a "key changed" badge
    in the call list for the rest of the call. They can then compare safety
    numbers outside the app. A user's second device shows up the same way.
  - A pinned peer whose key is no longer delivered is blocked until pinned
    again.
- **Key rotation.** The key holder makes a new room key whenever someone
  leaves. So a person who left cannot decrypt what follows (forward secrecy).
  The key also rotates on a timer while the call runs.
- **What E2EE does not hide from the operator:** who is in which voice
  channel, when, for how long, and mute or deafen state. That is server state,
  not media.
- **Rule for contributors:** if you touch the E2EE code, keep the
  epoch/keypair staleness guards, and never show an unverified peer as
  verified. This is a security invariant, not a style choice. The E2EE code is
  `Client/src/lib/net/e2eeCrypto.ts`, `livekitE2EE.ts`, the
  `features/voice/e2ee*.ts` modules, `identity.ts`, the Linux native back end
  in `Client/src-tauri/src/native_voice/`, and the server's
  `Server/ws/voice_e2ee.go`.

### Logging and redaction

- **Secrets are kept out of logs by type, not by filtering each line.** No
  `slog` call in server code logs message content.
  `Server/db/logvalue.go` and `Server/config/logvalue.go` make `db.User`,
  `db.Session` and the secret-bearing config sections safe to log. The tests
  `TestUserSessionRedactedInLogs` and `TestSecretConfigsRedactedInLogs` check
  this. A raw token, key or message body passed to `slog` as a string is
  **not** cleaned. Never pass one.
- **Secrets set in the admin panel are write-only.** They live in
  `<data_dir>/config-overrides.json` (mode `0600`). No response, error, log
  line or audit row contains one. The panel only shows whether a value is set.
  Treat that file like `config.yaml` in backups.
- **The audit log** (`audit_log` table) records security-relevant actions:
  auth, 2FA, admin, content, voice moderation and operations events. Tests
  hold it to the same rule.
  - The `TestAuditCoverage_*` tables in `Server/api`, `Server/admin` and
    `Server/service` perform each listed security-relevant change and require
    its audit row.
  - They run `audittest.AssertSafeDetails`
    (`Server/db/audittest/audittest.go`). It fails if a detail looks like a
    credential, or contains one of the test's secrets or message bodies.
  - The tables do not find new changes by themselves. A new security-relevant
    change must add its own row.
- **No telemetry.** OwnCord sends no automatic product or usage telemetry.
  Every diagnostic surface stays on the operator's machine: the health probe,
  connectivity diagnostics, metrics, logs, the audit log and backups.
- **Rule for contributors:** do not add a log statement, audit-log `detail`
  field or diagnostic surface that can carry message content or a secret. The
  audit-safety tests exist to catch this. Do not weaken them to make a new
  change pass.

### Transport

- **TLS.** With any `tls.mode` other than `off`, the client and server talk
  over TLS. `tls.mode: off` serves plain HTTP. Use it only behind a reverse
  proxy you run that handles TLS.
- **Certificate pinning (TOFU).** The desktop client pins the server's
  certificate the first time it connects.
  - It shows the SHA-256 fingerprint of the server's certificate. The user
    must accept it on first connect.
  - It checks the fingerprint on every later connection. This applies to
    self-signed, ACME-issued and manually supplied certificates alike. The
    desktop does not trust the public CA list on first contact.
  - A fingerprint mismatch stops the connection before any WebSocket data or
    auth frame is sent.
  - One exception: a routine renewal where the old and new certificates are
    both publicly valid for the server's domain. That is re-pinned without a
    prompt ([docs/trust-model.md](docs/trust-model.md)).
- **All three native tunnels** (WebSocket, HTTP REST and LiveKit) check the
  same pin store (`certs.json`) through `Client/src-tauri/src/tofu.rs`.
  - The WebSocket and HTTP proxies read the certificate fingerprint and decide
    before they forward anything.
  - The LiveKit proxy fails the handshake on any mismatch. It refuses to start
    until a pin exists.
  - Only the `accept_cert_fingerprint` command and the public-CA renewal above
    write a pin.
- **The session token travels in the first WebSocket frame**, never in the
  URL.
- **LiveKit signalling** goes through the Rust `livekit_proxy` loopback tunnel
  (TOFU-pinned) to the server's `/livekit/*` reverse proxy. There is one
  exception. For a server on this machine (`localhost`, `127.0.0.1` or `::1`)
  whose LiveKit URL is itself a loopback `ws:`/`http:` address, the client
  connects to LiveKit directly. This rule is the same on every platform.
- **Media** takes neither path. It flows directly between the client and
  LiveKit's advertised ICE endpoints (by default TCP 7881 and UDP
  50000–60000). E2EE protects it, not the certificate pin.
- The web admin panel's IP limit is separate from transport encryption.
- **Rule for contributors:** do not add a web view fetch path that skips the
  pinned tunnels or the broker. On the server, every file that opens an
  outbound connection must be listed in two places: `EgressAllow`
  (`Server/invariants/egress_sites.go`) and
  [docs/trust-model.md](docs/trust-model.md) ("Outbound connections the server
  makes"). The `egress-sites` invariant fails a connection that is not listed.
  `TestNoAutomaticTelemetry_Capture` fails if the default build reaches
  anything beyond loopback.

### Release and update trust chain

- **Server self-update.** The server:
  1. checks GitHub Releases and compares versions (semver)
  2. downloads the matching file
  3. verifies a signed update manifest that ties the binary's hash to the
     release version
  4. checks the SHA-256 against a checksums file
  5. on Windows, verifies a separate Ed25519/minisign signature against a
     public key committed in this repository

  If any check fails, the installed binary is left alone.

- **Desktop app update.** The Tauri updater verifies an Ed25519 signature
  before it applies an update. The signature must name the version the update
  check offered. The updater also reads the file name from the signature's
  trusted comment. It refuses a file whose name does not match this machine's
  operating system, architecture and installer type.
- **Provenance and SBOMs.**
  - Release files carry SLSA Build L2 provenance attestations. These tie a
    file to the workflow and commit that built it, not to a person.
  - The server binaries have SBOMs (CycloneDX, one per binary or archive). The
    container image has an SBOM too (SPDX).
  - The desktop app bundles carry provenance and their updater signature, but
    no SBOM yet.
  - Operators can check checksums, attestations and signatures themselves,
    with the documented `gh attestation verify` and `minisign` steps.
- **Windows binaries are not yet Authenticode-signed.** So SmartScreen still
  warns, even when every other check passes. Verify a download with the
  checksum, signature and attestation steps instead.

### Rules for contributors

- **Never expose a secret beyond where the design puts it.** By design, the
  session token and the voice identity private key reach the web view. A TOTP
  enrolment secret, backup codes and a recovery kit are shown to their owner
  once. None of these, and no password or API token, may go into a log line,
  an audit-log detail field, or a public commit or issue. The remembered
  password never comes back over IPC.
- **Validate input at every trust boundary.** That means IPC commands, REST
  and WebSocket payloads, and any URL or hostname taken from message content.
  Use the existing allowlist and classification helpers, not one-off checks.
- **Check permissions on the server for every request**, through the owning
  permission check or route permission gate. Never rely on a client-side check
  or a role the client claims.
- **Never weaken a security invariant that a test locks.** These tests exist
  so a change cannot quietly undo them:
  - the authz chokepoint inventory
  - the egress inventory
  - the audit-safety assertions
  - the E2EE staleness and verification guards
  - the redaction helpers
  - the Tauri capability and CSP scope tests
  - the no-federation contract tests

  If a test blocks your change, fix the change, not the test.

- **Report security problems privately.** Do not open a public issue. Do not
  describe an unfixed weakness in a commit message, PR description or
  changelog. Use a GitHub Security Advisory, as described at the top of this
  page.

### Sources

- [docs/security.md](docs/security.md), [docs/trust-model.md](docs/trust-model.md), [docs/credential-storage.md](docs/credential-storage.md), [docs/deployment.md](docs/deployment.md)
- [docs/architecture/voice-e2ee.md](docs/architecture/voice-e2ee.md), [docs/architecture/system-overview.md](docs/architecture/system-overview.md)
- [Server/invariants/authz_chokepoint.go](Server/invariants/authz_chokepoint.go), [Server/invariants/egress_sites.go](Server/invariants/egress_sites.go), [Server/api/absence_contract_test.go](Server/api/absence_contract_test.go), [Server/auth/totp_encrypt.go](Server/auth/totp_encrypt.go), [Server/auth/totp.go](Server/auth/totp.go)
- [Server/db/logvalue.go](Server/db/logvalue.go), [Server/config/logvalue.go](Server/config/logvalue.go), [Server/db/audittest/audittest.go](Server/db/audittest/audittest.go), [Server/db/models.go](Server/db/models.go), [Server/service/recovery.go](Server/service/recovery.go), [Server/storage/storage.go](Server/storage/storage.go)
- [Client/src-tauri/src/tofu.rs](Client/src-tauri/src/tofu.rs), [Client/src-tauri/src/credentials.rs](Client/src-tauri/src/credentials.rs), [Client/src-tauri/src/external_content.rs](Client/src-tauri/src/external_content.rs), [Client/src/lib/net/identity.ts](Client/src/lib/net/identity.ts), [Client/src/platform/desktop/nativeProxies.ts](Client/src/platform/desktop/nativeProxies.ts)
- [CLAUDE.md](CLAUDE.md), [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md)
