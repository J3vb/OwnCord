# Security Policy

## Supported versions

OwnCord is in alpha. Only the **latest release** receives security fixes.
There are no backports.

| Version                                                                   | Supported |
| ------------------------------------------------------------------------- | --------- |
| Latest release (see [Releases](https://github.com/J3vb/OwnCord/releases)) | Yes       |
| Anything older                                                            | No        |

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Report vulnerabilities privately via GitHub Security Advisories on the
[OwnCord](https://github.com/J3vb/OwnCord/security/advisories/new)
repository ("Report a vulnerability"). Advisories stay private until
published, so this channel is safe even though the repository is public.

Please include:

- Affected component (server, desktop client, admin panel, plugin host)
- Reproduction steps or a proof of concept
- The release version (or source snapshot) you tested against

You will get an initial response within 7 days. Coordinated disclosure is
appreciated; fixes ship in the next release with credit unless you prefer
otherwise.

## Hardening documentation

Operator-facing hardening notes live in [docs/security.md](docs/security.md).

---

## Security model and rules for contributors

Condensed from the sources listed at the end, at commit `7732f969`
(2026-09-25). On conflict the code wins, then the source documents; a
disagreement is a doc bug.

### Trust model

- **The server operator can read everything the server stores or relays in
  the clear**: channel messages, direct messages, uploaded files, the search
  index, names, timestamps, and who is where. This is by design (it is what
  delivery, replay, search, moderation and backup require), not a defect. Text
  chat is **not** end-to-end encrypted.
- **Voice, video and screen share are end-to-end encrypted** between call
  participants. The server relays wrapped keys and encrypted media as opaque
  bytes and never holds the room key, so an operator who only reads what the
  server stores or relays learns nothing about call content.
- **The server still controls call membership.** It decides who is admitted to
  a voice channel, and a client accepts and pins any new participant's
  identity key the first time it sees it. A modified server can therefore add
  a participant it controls and receive the room key: E2EE media is not a
  defence against an operator who modifies the server, only against one who
  reads. Pinning catches a known peer's key changing, not an unknown member
  joining.
- **Passwords, session tokens and API tokens are never stored in the clear.**
  Passwords are bcrypt-hashed (cost 12); session and API tokens are stored as
  SHA-256 hashes, never the token itself; TOTP secrets are encrypted with a
  server-local AES-256 key (with a documented pre-encryption legacy exception
  that is never rewritten in place, only read as-is with a warning logged).
- **One server is one island.** No federation, no cross-server messaging, no
  directory or discovery, and no global identity: an account is a row in one
  server's database, and the same username on two servers is two unrelated
  people. Three tests in `Server/api/absence_contract_test.go` fail if a
  mounted route, a WebSocket message type or a config key uses federation,
  directory, discovery or listing vocabulary. They pin vocabulary, not
  behaviour: a feature that makes the server talk to another server must first
  update [docs/trust-model.md](docs/trust-model.md) ("What OwnCord does not
  have") and its outbound-connection table.
- **A hostile operator with shell access is out of scope for every control in
  this document, E2EE media included.** No control here survives root on the
  box: an operator who can edit the binary, the database or the configuration
  can defeat any of it.

### Authentication and sessions

- Passwords are bcrypt-hashed (cost 12); TOTP verification uses constant-time
  comparison (`subtle.ConstantTimeCompare`).
- Every bcrypt computation on an authentication route (password checks and
  hashes, recovery-code matching) is admitted through one process-wide
  concurrency budget; an over-budget attempt is refused with `429
RATE_LIMITED`, runs no bcrypt, and counts as no failed attempt.
- TOTP-based 2FA is supported (enrolment via QR code plus backup codes), and
  admins can require it server-wide. Second-factor state (the login
  challenge, a pending enrolment and the 90-second replay window) survives a
  restart, stored as SHA-256 digests (challenge token, used codes) and
  AES-256-GCM ciphertext under the TOTP key (a pending enrolment's secret),
  never as a token, code or secret in the clear.
- Auth routes are rate-limited per IP: login 5/min, registration 3/min, 2FA
  verification 10/min, account recovery 5/min, each scaled by
  `security.auth_rate_limit_multiplier` (default 1.0). Ten failed logins
  within 15 minutes lock the username for 15 minutes whatever the source IP
  (never scaled: it is the only cross-IP defence); the same count, scaled,
  locks the source IP.
- Lifetimes: a session expires 30 days after it was created, and use does not
  extend it; a 2FA login challenge (`partial_token`) lives 10 minutes and is
  revoked after 5 wrong codes; a LiveKit access token lives 5 minutes; an API
  token lives as long as its creator chose, and one created without a lifetime
  never expires.
- Sessions: a user may hold up to 25 sessions, with the oldest evicted beyond
  that. Users can list and revoke their own sessions and sign out everywhere,
  and a password change revokes every other session. Admin force-logout
  revokes all of a user's sessions.
- Account recovery (a self-held recovery kit, or owner-assisted recovery after
  out-of-band identity verification) replaces the password and revokes every
  session in one transaction. Both paths then sign the holder in without the
  second factor (an owner decision: recovery exists for lost devices). The kit
  is stored only as an argon2id verifier, and a spent or lost kit cannot be
  recovered by the server; the owner-issued credential is single-use and
  expires in 15 minutes; five failed attempts per account or per address lock
  recovery for 15 minutes. No administrator below the owner can reset another
  account's credentials.
- The first-run setup endpoint (which creates the first Owner account) is
  unauthenticated by necessity, but requires the one-time setup token the
  server prints to its own console at start-up, and is gated by a
  `setup_completed` flag that is written once and never cleared by the
  server, so an emptied users table (via account deletion or erasure) does
  not reopen it to the next caller on an allowed network.

### Authorization

- Channel-scoped authorization goes through one predicate per property in
  `Server/permissions/predicates.go` (`CanViewChannel`, `CanSendMessage`,
  `CanJoinVoice`, `CanModerateVoice`, …) over a resolved `permissions.Subject`,
  so a call site cannot re-derive half a rule.
- Outside `Server/permissions`, a raw bit helper (`HasPerm`, `HasAnyPerm`,
  `HasServerPerm`, `HasAdmin`, `EffectivePerms`, `EffectiveChannelPerms`) may
  appear only in a symbol listed, with its exact call count, in
  `AuthzResidueAllow` (`Server/invariants/authz_chokepoint.go`): server-wide
  gates such as `api.RequirePermission` and `admin.requirePerm`, and
  administrator short-circuits. The `authz-chokepoint` invariant fails any
  other raw call, and that list only shrinks.
- Voice permission is enforced twice: once at `voice_join` (channel
  permission) and again inside the LiveKit JWT itself (`CanPublishSources`
  scoped by role permission). The client is never the sole gate.
- Admin panel access is IP/CIDR-gated (`admin_allowed_cidrs`), separately from
  bearer admin auth on its API.
- The rule contributors must follow: never trust a client-supplied permission
  or role claim. Every authorization decision is re-checked server-side
  through the owning predicate or route permission gate.

### Secrets and credentials

- Server key files (`totp.key`, `erasure.key` and `push_vapid.key` in the data
  directory, each overridable by an `OWNCORD_*` environment variable) share
  one loader (`loadOrGenerateKeyFile`, `Server/auth/totp_encrypt.go`). A key is
  generated only when confirmed absent; any other read error refuses to start
  rather than silently replace it, which would orphan every secret encrypted
  or named under it; writes are atomic. A new key file must use that loader.
- Secret-bearing values redact themselves when logged (see
  [Logging and redaction](#logging-and-redaction)); user IDs, usernames,
  session IDs, devices and IP addresses are logged by design. No `slog` call
  in server code logs message content.
- Desktop client credentials (login token/password, the voice-E2EE identity
  private key, pending message drafts) are stored in the OS keyring (Windows
  Credential Manager, macOS Keychain, Secret Service), with every write read
  back and verified. If the keyring write is rejected or fails verification,
  the client falls back to an encrypted file (Windows DPAPI with
  `CRYPTPROTECT_UI_FORBIDDEN`; ChaCha20-Poly1305 under a per-install key
  elsewhere), never plaintext at rest.
- A remembered password never crosses IPC back to JavaScript: the field is
  `#[serde(skip)]` on the Rust credential struct, test-locked. The frontend
  gets `has_password` and a placeholder string; submitting it triggers a
  Rust-side login over the same pinned tunnel a normal request uses.
- Contributors must not widen what the renderer can read. It holds the
  session token and the voice-E2EE identity private key by design; the
  remembered password is the credential kept Rust-side, so never return it,
  or any new secret, over IPC. Never log a token, password or message body,
  and never widen a Tauri capability (filesystem scope, the loopback-only HTTP
  fetch scope, DevTools) or the CSP beyond what a feature specifically needs:
  both are least-privilege and regression-guarded by
  `Client/tests/unit/capabilities-scope.test.ts` and
  `Client/tests/unit/tauri-conf-csp.test.ts`.

### Input validation and content sanitization

- IPC commands validate host format, string lengths and character
  allowlists; PTT virtual key codes are range-checked; the LiveKit proxy
  validates `remote_host` against CRLF injection.
- Uploads: the composer filters attachments by a MIME-prefix allowlist
  (`ALLOWED_TYPES`, `Client/src/components/MessageInput.ts`) as a convenience,
  but the server does not rely on it. It sniffs the type from the file bytes,
  refuses executable and script magic bytes (`blockedMagic`,
  `Server/storage/storage.go`), and serves HTML, SVG, XML, PDF and XSL as
  `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`.
- All user-generated content in the desktop client renders via
  `textContent`/`setText`, never `innerHTML` (the one exception operates on a
  compile-time constant with a runtime guard). URLs are validated to allow
  only `http:` and `https:`; `image/svg+xml` is excluded from safe data-URI
  MIME types; YouTube embeds are sandboxed.
- Content other users named (link previews, YouTube oEmbed titles and
  thumbnails, inline external images, GIFs and external avatars) is fetched
  only by the desktop's native broker (`Client/src-tauri/src/external_content.rs`):
  `https` on port 443 only; every resolved address classified with the same
  list as `Server/safefetch`, with loopback, private, link-local, multicast and
  other non-global answers refused before connecting; at most three redirects,
  followed by hand; and time, bytes, content type and concurrency bounded. No
  broker call and no GIF-proxy query is made until the viewer has chosen, once
  per server profile, to load automatically or to ask per item, after being
  told the linked site can see their IP.
- On the server, `Server/safefetch` applies the same rules to its outbound
  content paths: the Klipy GIF API proxy, the plugin `http` capability and Web
  Push dispatch. Attachments, avatars and emoji hosted by the connected server
  deliberately use the TOFU-pinned `http_proxy.rs`, never the broker.
- Contributors adding a new automatic outbound-content path must route it
  through the broker (desktop) or `safefetch` (server), not a new bespoke HTTP
  client, and must not route server-hosted files through the broker or
  third-party content through `http_proxy.rs`.

### Voice and video E2EE

- The room key is generated on a participant's device (WebCrypto), never on
  the server. One participant (the key holder, deterministically the lowest
  user ID in the channel) wraps the key per recipient with ECDH + AES-GCM; the
  server relays the wrapped bytes without decoding them.
- Media frames are encrypted before they leave the sending device; the LiveKit
  SFU relays ciphertext only.
- Each install holds a long-lived ECDSA P-256 identity key per account and
  server (keychain account `identity:{userId}@{host}`). Peers pin one key per
  account (`{host}:{userId}`) on first sight (trust-on-first-use) and block
  with a mismatch modal if it later changes, so a user's second device shows
  up as a key change until verified out of band.
- The key holder rotates the room key whenever a participant leaves, so a
  departed member cannot decrypt what follows (forward secrecy), and also
  rotates it on a timer while the call runs.
- What E2EE does not hide from the operator: who is in which voice channel,
  when, for how long, and mute/deafen state. These are server state, not
  media content.
- Contributors touching the E2EE code (`Client/src/lib/e2eeCrypto.ts`,
  `livekitE2EE.ts`, the `features/voice/e2ee*.ts` modules, `identity.ts`, the
  Linux native backend in `Client/src-tauri/src/native_voice/`, or the
  server's `Server/ws/voice_e2ee.go`) must preserve the epoch/keypair
  staleness guards and must never report an unverified peer as verified. This
  is a security-hardening invariant, not a style preference.

### Logging and redaction

- No `slog` call in server code logs message content, and secrets are kept
  out by type, not by a filter on every line: `Server/db/logvalue.go` and
  `Server/config/logvalue.go` make `db.User`, `db.Session` and the
  secret-bearing config sections safe to log (tests
  `TestUserSessionRedactedInLogs`, `TestSecretConfigsRedactedInLogs`). A raw
  token, key or message body passed to `slog` as a string is not scrubbed:
  never pass one.
- The audit log (`audit_log` table), which records security-relevant actions
  (auth, 2FA, admin, content, voice moderation, ops events), is held to the
  same rule by tests, not a runtime filter. The `TestAuditCoverage_*` tables in
  `Server/api`, `Server/admin` and `Server/service` perform each listed
  security-relevant mutation, require its audit row, and run
  `audittest.AssertSafeDetails` (`Server/db/audittest/audittest.go`), which
  fails on a detail matching a credential shape or containing one of the
  fixture's secrets or message bodies. The tables do not discover new
  mutations: a new security-relevant mutation must add its own row.
- OwnCord sends no automatic product or usage telemetry. Every diagnostic
  surface (health probe, connectivity diagnostics, metrics, logs, audit log,
  backups) stays on the operator's machine.
- Contributors must not add a log statement, audit-log `detail` field or
  diagnostic surface that can carry message content or a secret; the
  audit-safety tests exist to catch this and must not be weakened to make a
  new mutation pass.

### Transport

- With any `tls.mode` other than `off`, the connection between client and
  server is TLS. `tls.mode: off` serves plaintext HTTP and is intended only
  behind an operator-run TLS-terminating reverse proxy.
- The desktop client pins the server's certificate on trust-on-first-use
  (TOFU): the SHA-256 fingerprint of the leaf certificate is shown and must be
  accepted on first connect, then checked on every later connection,
  regardless of whether the certificate is self-signed, ACME-issued or
  manually supplied. The desktop does not validate against the public CA list
  on this connection. A fingerprint mismatch rejects the connection before any
  WebSocket payload or auth frame is sent.
- All three native tunnels (WebSocket, HTTP REST, LiveKit) check the same pin
  store (`certs.json`) through `Client/src-tauri/src/tofu.rs`. The WebSocket
  and HTTP proxies capture the leaf fingerprint and decide before forwarding
  anything; the LiveKit proxy fails the handshake on any mismatch and refuses
  to start until a pin exists. Only the explicit `accept_cert_fingerprint`
  command writes a pin.
- The session token travels inside the first WebSocket frame, never in the
  URL.
- LiveKit signalling goes through the Rust `livekit_proxy` loopback tunnel
  (TOFU-pinned) to the server's `/livekit/*` reverse proxy. Only for a server
  on this machine (`localhost`, `127.0.0.1`, `::1`) whose LiveKit URL is itself
  loopback `ws:`/`http:` (on Linux, where voice is native, any local server's
  LiveKit URL) does the client connect to LiveKit directly. Media takes
  neither path: it flows directly between the client and LiveKit's advertised
  ICE endpoints (by default TCP 7881 and UDP 50000–60000), protected by E2EE
  rather than by the certificate pin. The web admin panel is IP/CIDR-gated
  separately from transport encryption.
- Contributors must not add a renderer fetch path that bypasses the pinned
  tunnels or the broker. On the server, every file that opens an outbound
  connection must be inventoried in `EgressAllow`
  (`Server/invariants/egress_sites.go`) and in
  [docs/trust-model.md](docs/trust-model.md) ("Outbound connections the server
  makes"): the `egress-sites` invariant fails an uninventoried dial, and
  `TestNoAutomaticTelemetry_Capture` fails if the compiled defaults reach
  anything beyond loopback.

### Release and update trust chain

- Server self-updates check GitHub Releases, compare semver, download the
  matching asset, verify a signed update manifest that binds the shipped
  binary hash to the release version, cross-check the SHA-256 against a
  checksums file, and (Windows) verify a detached Ed25519/minisign signature
  against a public key committed in the repository. A verification failure
  leaves the installed binary untouched.
- The Tauri desktop client's own updater performs Ed25519 signature
  verification before applying an update.
- Release artifacts also carry SLSA Build L2 provenance attestations (binding
  a file to the workflow and commit that produced it, not to a person), and
  SBOMs for the server binaries (CycloneDX, one per binary or archive) and the
  container image (SPDX). The Tauri client bundles carry provenance and their
  updater signature but no SBOM yet. Operators can verify checksums,
  attestations and signatures independently via the documented
  `gh attestation verify` / `minisign` steps.
- Windows binaries are not yet Authenticode-signed, so SmartScreen still warns
  even when every other check passes; verify a download with the checksum,
  signature and attestation steps instead.

### Rules for contributors

- **Never expose a secret beyond where the design puts it.** The session token
  and the voice identity private key reach the renderer by design, and a TOTP
  enrolment secret, backup codes and a recovery kit are shown to their owner
  once. None of these, nor any password or API token, goes into a log line,
  an audit-log detail field, or a public commit or issue, and the remembered
  password never returns over IPC.
- **Validate input at every trust boundary** (IPC commands, REST and WebSocket
  payloads, and any URL or hostname taken from message content) using the
  existing allowlist and classification helpers rather than ad hoc checks.
- **Verify authorization server-side on every request**, through the owning
  permission predicate or route permission gate. Never rely on a client-side
  permission check or a role claim the client supplied.
- **Never weaken a security-hardening invariant that a test locks**: the
  authz chokepoint inventory, the egress inventory, the audit-safety
  assertions, the E2EE staleness and verification guards, the redaction
  helpers, the Tauri capability and CSP scope tests, and the
  absence-of-federation contract tests all exist so a change cannot regress
  them silently. If a test blocks a change, fix the change, not the test.
- **Report security issues privately.** Do not open a public issue or
  describe an unfixed weakness in a commit message, PR description or
  changelog; use GitHub Security Advisories as described at the top of this
  document.

### Sources

- [docs/security.md](docs/security.md), [docs/trust-model.md](docs/trust-model.md), [docs/credential-storage.md](docs/credential-storage.md), [docs/deployment.md](docs/deployment.md)
- [docs/architecture/voice-e2ee.md](docs/architecture/voice-e2ee.md), [docs/architecture/system-overview.md](docs/architecture/system-overview.md)
- [Server/invariants/authz_chokepoint.go](Server/invariants/authz_chokepoint.go), [Server/invariants/egress_sites.go](Server/invariants/egress_sites.go), [Server/api/absence_contract_test.go](Server/api/absence_contract_test.go), [Server/auth/totp_encrypt.go](Server/auth/totp_encrypt.go), [Server/auth/totp.go](Server/auth/totp.go)
- [Server/db/logvalue.go](Server/db/logvalue.go), [Server/config/logvalue.go](Server/config/logvalue.go), [Server/db/audittest/audittest.go](Server/db/audittest/audittest.go), [Server/db/models.go](Server/db/models.go), [Server/service/recovery.go](Server/service/recovery.go), [Server/storage/storage.go](Server/storage/storage.go)
- [Client/src-tauri/src/tofu.rs](Client/src-tauri/src/tofu.rs), [Client/src-tauri/src/credentials.rs](Client/src-tauri/src/credentials.rs), [Client/src-tauri/src/external_content.rs](Client/src-tauri/src/external_content.rs), [Client/src/lib/identity.ts](Client/src/lib/identity.ts), [Client/src/platform/desktop/nativeProxies.ts](Client/src/platform/desktop/nativeProxies.ts)
- [CLAUDE.md](CLAUDE.md), [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md)
