# Security model (contributors)

This page is for people who change OwnCord's code. It sums up the security
model, the rules every change must follow, and the technical detail behind the
owner guide. Server owners want [security.md](security.md) instead.

## What stays private, and for how long

These rules apply to weaknesses in the repository's own automation and
settings (workflow permissions, credential scope, release gating) just as much
as to bugs in the server or client. Planning documents point to this section
as the rule.

- **Public records carry only four things.** Commits, issues, pull request
  descriptions and changelogs carry an **opaque identifier, the affected
  property, safe acceptance criteria, and a status**. Nothing more.
- **Details stay in the private advisory.** That means reproduction steps,
  source-to-sink traces, the conditions needed to exploit it, and the state a
  fix replaced. A commit that fixes a weakness describes the control it adds,
  not the gap it closes.
- **Every private finding has exactly one public owner.** So nothing is
  tracked only in private, and nothing is silently dropped.
- **Release notes may describe the repaired impact** once the fix is
  coordinated, but without the detail needed to reproduce it.

This repository is public. A commit message can reveal a weakness.

## Security model

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
    another server must first update [docs/trust-model.md](trust-model.md)
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
    prompt ([docs/trust-model.md](trust-model.md)).
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
  [docs/trust-model.md](trust-model.md) ("Outbound connections the server
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
  changelog. Use a GitHub Security Advisory, as described in [SECURITY.md](../SECURITY.md).

### Sources

- [docs/security.md](security.md), [docs/trust-model.md](trust-model.md), [docs/credential-storage.md](credential-storage.md), [docs/deployment.md](deployment.md)
- [docs/architecture/voice-e2ee.md](architecture/voice-e2ee.md), [docs/architecture/system-overview.md](architecture/system-overview.md)
- [Server/invariants/authz_chokepoint.go](../Server/invariants/authz_chokepoint.go), [Server/invariants/egress_sites.go](../Server/invariants/egress_sites.go), [Server/api/absence_contract_test.go](../Server/api/absence_contract_test.go), [Server/auth/totp_encrypt.go](../Server/auth/totp_encrypt.go), [Server/auth/totp.go](../Server/auth/totp.go)
- [Server/db/logvalue.go](../Server/db/logvalue.go), [Server/config/logvalue.go](../Server/config/logvalue.go), [Server/db/audittest/audittest.go](../Server/db/audittest/audittest.go), [Server/db/models.go](../Server/db/models.go), [Server/service/recovery.go](../Server/service/recovery.go), [Server/storage/storage.go](../Server/storage/storage.go)
- [Client/src-tauri/src/tofu.rs](../Client/src-tauri/src/tofu.rs), [Client/src-tauri/src/credentials.rs](../Client/src-tauri/src/credentials.rs), [Client/src-tauri/src/external_content.rs](../Client/src-tauri/src/external_content.rs), [Client/src/lib/net/identity.ts](../Client/src/lib/net/identity.ts), [Client/src/platform/desktop/nativeProxies.ts](../Client/src/platform/desktop/nativeProxies.ts)
- [CLAUDE.md](../CLAUDE.md), [Server/CLAUDE.md](../Server/CLAUDE.md), [Client/CLAUDE.md](../Client/CLAUDE.md)

## Accounts and sign-in in detail

### Two-factor state and keys

- Second-factor state survives a restart (migration 032). This covers the
  login challenge, a pending enrolment (encrypted under the TOTP key) and the
  90-second replay window. They are stored as digests and ciphertext, never as
  a token or code in the clear.
- If that store fails, the server fails closed. It issues no challenge and
  accepts no code on trust.
- **TOTP encryption key** (`data/totp.key`, or `OWNCORD_TOTP_KEY`):
  - It is generated only when the server confirms it is absent.
  - Any other read error stops the server from starting. Replacing the key
    would orphan every stored secret.
  - The key is written atomically.
  - Back it up next to the database. A backup does not contain it.
- **Erasure marker key** (`data/erasure.key`, or `OWNCORD_ERASURE_KEY`)
  follows the same rules: generated only when confirmed absent, any other read
  error stops the start-up, atomic write.
  - Deletion markers in `data/erasure/markers.sqlite` name erased accounts
    only as an HMAC under this key.
  - Back up both next to the database. If a restore is missing them, the
    server cannot recognise an account the backup brings back, and so cannot
    erase it again.

### Sign-in limits

- Admins can require 2FA for everyone with the `require_2fa` setting in the
  admin panel.
- `require_2fa` needs every user to have 2FA turned on, and needs
  `registration_mode` to be `closed`. While it is on, registration cannot be
  reopened.
- **Session expiry:**
  - A session expires 30 days after it was last used.
  - An authenticated REST request, the WebSocket handshake and the WebSocket
    heartbeat each extend `expires_at`. This happens at most once a minute per
    session, and the write is batched up to a minute later.
    [schema.md](schema.md#sessions) owns the exact bound and its edge case.
  - A session never lives more than 365 days from sign-in.
  - Use never revives a session that has already expired or been revoked.
- The login flow returns `requires_2fa: true` with a `partial_token`. That
  token lasts 10 minutes and allows 5 attempts.
- Auth challenges are rate-limited to 10 requests per minute per IP address.
- **Password-hashing budget:**
  - Every bcrypt computation on an authentication route goes through one
    process-wide limit (`security.expensive_auth_concurrency`, default twice
    the CPU core count). This covers password checks and hashes, and
    recovery-code matching.
  - Login, registration, first-run setup and recovery-code checks over that
    limit wait in a bounded first-in, first-out queue for up to 10 seconds.
  - A refused attempt gets `429 AUTH_BUSY`. That happens when the queue is
    full, the wait runs out, or a password confirmation is over the limit. A
    refused attempt runs no bcrypt and does not count as a failed attempt.
- TOTP codes are compared in constant time (`subtle.ConstantTimeCompare`). This
  prevents timing side-channel attacks.

### Recovery kit and owner-assisted recovery

**The recovery kit** is a secret the account holder keeps offline. The server
stores only an argon2id verifier of it.

- The setup wizard offers to create the owner's kit at first run. It is shown
  once, on the finish step, and only its verifier is stored.
- Any account can enrol or replace a kit from the desktop client while signed
  in.
- Redeeming the kit, in one transaction:
  - replaces the password;
  - revokes every session and API token;
  - uses up the kit;
  - writes an audit row with no content;
  - then signs the holder in without the second factor. The kit exists for
    when the holder's devices are gone.
- A used or lost kit cannot be recovered by the server. The holder issues a new
  one while signed in.
- Five failed attempts lock recovery for 15 minutes.

**Owner-assisted recovery.** Only the server owner, or a member holding the
Issue Recovery permission, can issue a recovery credential. A holder can do so
only for members ranked below them, and not for an account carrying an
owner-level permission the holder lacks.

- The owner first checks the person's identity outside OwnCord, and records
  how, as one of four fixed values: `in_person`, `voice_call`, `video_call`
  or `trusted_contact`. No free text is accepted.
- The credential works once, expires in 15 minutes, and is stored only as an
  argon2id verifier.
- It redeems through the same route, with the same results: a new password,
  every session and API token revoked, and no second factor.
- No administrator below the owner can reset anyone's credentials.
- Issuing and using it are audited (`recovery_assist_issued`,
  `recovery_assist_used`).

## First-run setup in detail

**Single-use download links.** The full-archive download uses the same
single-use pattern as the log stream.

- The owner asks for a link (`POST /admin/api/archive/link`) with normal
  authentication. The browser then opens the returned URL as a plain download,
  so a large archive is never held in the page.
- The link token is 32 random bytes. It is bound to the owner who asked for
  it, works once, lasts about a minute, and is never written to a log or audit
  row.
- Like the log-stream ticket, it stores the hash of the credential that asked
  for it, and checks it again when used. So a revoked session, a ban or a lost
  Owner role cancels an unused link.
- An unknown, expired, used or cancelled token always gets the same `403`.
- Downloading a single backup from the panel works the same way
  (`POST /admin/api/backups/{name}/link`). That token is also bound to the one
  file and kept in a separate store. So an archive token opens no backup, and
  a backup token opens neither the archive nor another backup.

**The `setup_completed` flag.** `POST /admin/api/setup` needs no login,
because it is how the first Owner account is created. Until account erasure
existed, the only thing guarding it was "no users exist". Erasure can now
empty the users table:

- the administrator erases the last account; or
- a deletion marker is replayed against a restored backup whose only user is
  the erased owner (the replay does not apply the last-admin guard).

So the user count is no longer the gate. The `setup_completed` setting is
(migration 043). It is written in the same transaction as the first Owner and
the server never clears it. An emptied users table therefore leaves setup
closed, rather than open to the first caller on an allowed network.

A server upgrading into migration 043 is judged the same way. Setup closes if
any of these exist:

- a live user;
- an `erasure_jobs` row;
- a `server_setup`, `account_deleted` or `account_erasure_replayed` audit row.

So a server whose users table was already emptied before the upgrade closes
too, instead of looking fresh. Only those three audit actions count, not any
audit row. A server that was never set up still writes `backup_create` from
the scheduled-backup loop, and closing setup on that would block its own
first run.

The owner-facing steps for reopening a locked server are in [security.md](security.md#reopening-a-locked-server).

**Reopening a locked server.** A server with no accounts and the flag set is
locked on purpose. Reopening it is an operator action that needs filesystem
access to the database, not a network action:

```sql
UPDATE settings SET value = '0' WHERE key = 'setup_completed';
```

The server prints the setup token only at start-up, and only while setup is
open. So **restart the server after this change**. It then prints a fresh
one-time token next to the banner. The next `POST /admin/api/setup` that
carries it creates a new Owner and sets the flag again. A running server does
not print a token when setup is reopened, so restart it rather than reuse a
token from an earlier start.

**Which values open setup.** `0` is the only _value_ that opens setup. The gate
guards an endpoint with no login, so any other value (corrupted, or
hand-edited to something the server does not know) counts as closed.

A missing row is the one exception. Every database from before migration 043
looks like that, so there the user count decides, and a server that was truly
never set up can still run its wizard. The migration writes the row on every
upgrade. After that, the row is missing only if something removed it, and
removing it needs the same write access to the database file as setting it to
`0`.

**Restores.** The flag lives in the database, so a restore rolls it back with
everything else. That includes a backup taken before the server was ever set
up, which the scheduled-backup loop may well have made.

The deletion markers close that gap. They live outside the database. An
account marker proves an account existed here and was erased. So at start-up,
the replay closes the flag whenever the marker file holds an account marker,
whatever the restored database says. A marker file with only retention markers
leaves a truly fresh server alone.

The `setup_completed` key is deliberately not in the settings PATCH allowlist.
No logged-in route can write it. Only the operator can, with access to the
database file.

## Audit log in detail

- **Auth:** `user_register`, `user_login`, `user_logout`, `login_blocked_banned`, `account_deleted`, `password_change`, `session_revoke`, `session_revoke_all`, `recovery_kit_issued`, `recovery_kit_used`, `recovery_kit_locked`, `recovery_assist_used`, `account_erasure_replayed`
- **2FA:** `totp_enabled`, `totp_verified`, `totp_disabled`, `recovery_codes_regenerated`
- **Admin:** `role_change`, `role_add`, `role_remove`, `role_create`, `role_update`, `role_delete`, `role_reorder`, `user_ban`, `user_unban`, `force_logout`, `setting_change`, `server_setup`, `api_token_create`, `api_token_revoke`, `config_write`, `config_override_change`, `invite_create`, `invite_revoke`, `registration_mode_change`, `registration_approve`, `registration_deny`, `recovery_assist_issued`, `plugin_install`, `plugin_uninstall`, `retention_policy_change`, `channel_retention_change`, `permission_explain`, `permission_preview`
- **Content:** `channel_create`, `channel_update`, `channel_delete`, `channel_perms_update`, `channel_perms_clear`, `channel_user_perms_update`, `channel_user_perms_clear`, `discord_import_start`, `discord_import_publish`, `discord_import_cancel`, `message_delete`, `message_purge`, `emoji_create`, `emoji_delete`, `sticker_create`, `sticker_update`, `sticker_delete`
- **Voice moderation:** `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`, `voice_mod_kick`
- **Profile:** `profile_update`, `identity_key_update`
- **Ops:** `backup_create`, `backup_delete`, `backup_restore`, `backup_archive`, `archive_link`, `backup_link`, `backup_download`,
  `log_level_debug_on`, `log_level_reverted`, `update_apply`, `update_applied`,
  `update_failed`, `server_restart_requested`, `ws_connect`

**Audit rows about an erased account.** Erasure unlinks them
(`Server/db/erasure.go`, `erasureUnlinkPrincipalRows`):

- Each row keeps its action, time and order.
- `actor_id` and `target_id` become 0, and `detail` is cleared.
- The deletion marker's token takes the id's place. The token is an
  HMAC-SHA256 of the user id under `data/erasure.key`. It goes in
  `subject_token` where the erased user was the target, and in `actor_token`
  where they acted.
- The same token replaces the id in the report, report-note, report-event,
  moderation-action and appeal rows that name them.

What this means:

- A row that names two erased users keeps both tokens.
- Rows about one user stay linkable to each other for anyone allowed to read
  them, any `VIEW_AUDIT_LOG` holder included.
- The trail identifies the person again only for whoever holds `erasure.key`.
  (That is the erasure-key holder, not the voice key holder from the E2EE
  section.)

Two things the token does not cover:

- The `erasure_jobs` row names the user by their plain user id and is never
  pruned (an owner decision). Whoever may read it knows the identity without
  the key.
- Free text the erased account wrote while moderating others
  (`report_notes.body`, `moderation_actions.reason`, `appeals.decision_note`)
  is unlinked but not cleared.

The erasure's own `account_deleted` row is written in the unlinked form from
the start. `account_erasure_replayed` records a start-up that erased a restored
backup's copy of the account again.

Note: `backup_restore` is written to the live database _before_ the
pre-restore safety copy is taken. So the row survives inside the
`pre_restore_*.db` backup. The restored database itself will not contain it,
because the restore replaces the database file completely.

## Client Security Hardening

The Tauri desktop client uses the following security measures.

### Credential Storage

- **Where credentials are kept.** Credentials are stored in the OS keyring
  (Windows Credential Manager, macOS Keychain or Secret Service) through the
  `keyring` crate. Every write is read back and checked. If no keyring is
  available, they fall back to an encrypted file: Windows DPAPI with
  `CRYPTPROTECT_UI_FORBIDDEN`, or ChaCha20-Poly1305 elsewhere. See
  [credential-storage.md](credential-storage.md).
- **Passwords never reach the frontend.** Plaintext passwords are **never**
  returned to the frontend over IPC. Only tokens are visible to JavaScript.
  The field is `#[serde(skip)]` on `CredentialData`, and a test locks this in
  (`credential_data_never_serializes_the_password`). A remembered password is
  shown in the login form as a placeholder. The `login_with_saved_password`
  command reads the password in Rust and logs in through the same pinned
  loopback proxy a normal request uses.
- **Auto-login uses tokens.** It uses stored tokens to reconnect, not
  passwords.
- **Commands are scoped to the active host.** Credential and identity commands
  only act on the active session host, which Rust holds in its state.
  - That host is set only when the proxy relays the server's `auth_ok` over the
    pinned socket, never by a renderer command. It is cleared when that
    connection ends, or on `ws_disconnect`.
  - The relayed `auth_ok` also records every host a login was verified for
    during this app run. That set survives a disconnect and a credential
    removal.
  - While no session is active, the connect-page credential prefill, stored
    token resume and saved-password login work only for a host in that set,
    never for another saved host.
  - Before any login has been verified in this app run, the set is empty and
    the first-run behaviour applies. So a restart can still auto-login from a
    saved credential.
  - The pending-message commands (unsent message text) act on the active
    host, or while no session is active on a host in that set. They never
    skip the set, even before the first verified login.

### Tauri Capabilities (Least Privilege)

- **Filesystem access is limited to `$APPLOG`.** The renderer reads and writes
  its own logs there. Every other save from the frontend goes through the
  native save dialog, and the dialog plugin grants the chosen path on the fly.
  `$APPDATA` is deliberately out of scope. It holds `credential_fallback.json`
  and `.key`, `certs.json` and `identity_pins.json`, so a renderer compromise
  could otherwise read the fallback credential store or the TLS and identity
  pins. `fs:default` (whose recursive read covers `$APPDATA`) and the old
  `$APPDATA/**` write scope were removed for this reason.
- **DevTools are off in release builds.** The DevTools command is behind the
  `devtools` feature flag, which release builds leave out.
- **HTTP fetch reaches only loopback.** It is restricted to
  `http://127.0.0.1:*`, the Rust TOFU proxies' loopback tunnels. No `https://`
  destination is allowed at all. As a second layer of defence, it still
  **denies** `https://localhost[:*]` and `https://127.0.0.1[:*]`, in case a
  wildcard ever comes back.
- **Only `http:allow-fetch` carries a URL scope.** `tauri-plugin-http` checks
  the URL once, in the `fetch` command. `fetch_send` and `fetch_read_body` work
  on an already-checked `ResourceId` and never look at a scope. So `allow` and
  `deny` blocks on those identifiers would do nothing. They were removed
  rather than left in place looking like a control that does not exist.
- **No `https://*` wildcard.** Link previews, external images, GIFs and
  external avatars are fetched by the native external-content broker
  (`src-tauri/src/external_content.rs`), and the CSP `img-src` no longer
  allows `https:`. The broker's policy is in
  [trust-model-evidence.md](architecture/trust-model-evidence.md#desktop-preview-destination-policy-c-09--contract-for-b7).
- **CSP `connect-src` allows only local targets.** It allows `'self'`, IPC and
  loopback `http:` and `ws:` (`localhost`, `127.0.0.1`). There is no `https:`
  or `wss:` source, so a compromised renderer's own `fetch` or `WebSocket`
  cannot reach a remote host.
  - REST and the chat socket go through IPC. LiveKit goes through the loopback
    TOFU tunnel.
  - A local server's LiveKit `direct_url` is used as-is only when it is a
    loopback `ws:` or `http:` address. This rule is the same on every platform,
    Linux native voice included.
  - Anything else is tunnelled like a remote server's
    (`src/platform/desktop/nativeProxies.ts`). That covers LiveKit Cloud, a TLS
    LiveKit elsewhere, or a compose-internal name like `ws://livekit:7880` that
    does not resolve on the host.
- **Regression tests guard all of this:** `tests/unit/capabilities-scope.test.ts`
  and `tests/unit/tauri-conf-csp.test.ts`. The original reasoning is in
  [docs/plans/tauri-capability-narrowing.md](plans/tauri-capability-narrowing.md).

### TLS and Certificate Pinning (TOFU)

- Self-signed certificates are supported through Trust-On-First-Use (TOFU)
  pinning: the client remembers the certificate the first time it connects.
- The WebSocket proxy (`ws_proxy`) pins the server certificate fingerprint on
  first connection.
- The HTTP proxy (`http_proxy`), which carries REST traffic, pins against the
  same store.
- The LiveKit proxy (`livekit_proxy`) reuses the pinned fingerprint from the
  WebSocket proxy.
- All three native tunnels share one TOFU module and one pin store. The
  WebSocket and HTTP tunnels pin on first use. The LiveKit tunnel only checks
  an existing pin. See [trust-model.md](trust-model.md).
- **A certificate mismatch opens a modal** that the user must acknowledge.
  Saving a pin that changes what is trusted also needs a native OS
  confirmation dialog, in `accept_cert_fingerprint`. That command is the only
  user-confirmed writer of a pin, and its dialog names the host and
  fingerprint. So a renderer compromise cannot silently pin a host. The
  artifact smoke test seeds the pin in the profile instead of answering the
  dialog. Test-only builds use the `e2e-auto-confirm` feature, which no shipped
  build turns on.
- **On first contact, compare the fingerprint over another channel.** The
  trust decision rests on the fingerprint. Read it from the server's start-up
  banner (it is also on the admin Dashboard and the setup wizard's finish
  step). Compare it with the prompt, character for character, over a channel
  the server is not part of. The client cannot tell a wrong fingerprint from
  an interception attempt, so accepting a mismatch is the same as accepting an
  interception. The same rule applies when a certificate changes and every
  client shows the mismatch prompt again. (A routine public-CA renewal is
  re-pinned without a prompt.) See [trust-model.md](trust-model.md) and
  [Replacing the self-signed certificate](hosting/tls-and-proxy.md#replacing-the-self-signed-certificate).
- Update downloads check that `server_url` uses `https://`, and reject URLs
  that contain a username or password (userinfo).

### Input Validation

- IPC commands check host format, string lengths and allowed characters.
- Push-to-talk virtual key codes are checked against the Win32 range (1–254).
- The LiveKit proxy's `remote_host` is checked for CRLF injection.
- The API client checks the host format before building URLs.
- **File uploads** accept any type the server's file-type policy allows.
  - The composer checks the size and the policy before sending.
  - The server detects the real type from the content, refuses executables by
    content, and refuses blocked final extensions by name.
  - By default the blocked extensions are Windows scripts, installers and disk
    images. The owner can change the list in `config.yaml` and the admin panel
    (see [SECURITY.md](../SECURITY.md)).
- Error messages from server responses are capped at 200 characters.
- Notification titles are cleaned: control characters are stripped and the
  length is capped.

### XSS Prevention

- All user-generated content is rendered with `textContent` or `setText`,
  never `innerHTML`.
- The single `innerHTML` use (SVG icons) works on compile-time constants, with
  a runtime guard.
- URLs are checked with `isSafeUrl`, which rejects `javascript:`, `data:` and
  `vbscript:`.
- YouTube embeds use the `sandbox` attribute on iframes.
- `image/svg+xml` is not one of the safe MIME types a fetched server image or
  clip may carry as its Blob type.
- GIF media URLs are checked against the trusted Klipy CDN origins.
- Linkified URLs drop trailing punctuation, so the destination is not
  misleading.

### Search and Rate Limiting

- Client-side search requests are rate-limited: at least 500 ms between
  requests, plus a 300 ms debounce.

## Where requirements came from

Background: the emergency recovery codes trace to requirement BPR-046, and
the no-telemetry rule to BPR-055. The recovery kit,
owner-assisted recovery, account erasure and the removal of the `https://*`
wildcard were delivered as work packages B4-5, B4-6, B4-10 and B7-16. The
`erasure_jobs` retention is owner decision B6-15/3.
