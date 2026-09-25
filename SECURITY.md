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
(2026-09-25). On conflict, the source documents win.

### Trust model

- **The server operator can read everything the server stores or relays in
  the clear**: channel messages, direct messages, uploaded files, the search
  index, names, timestamps, and who is where. This is by design — it is what
  delivery, replay, search, moderation and backup require — not a defect. Text
  chat is **not** end-to-end encrypted.
- **Voice, video and screen share are end-to-end encrypted** between call
  participants. The server relays wrapped keys and encrypted media as opaque
  bytes and never holds the room key, so an operator who only reads what the
  server stores or relays learns nothing about call content.
- **The server still controls call membership.** It decides who is admitted to
  a voice channel, and a client accepts and pins any new participant's
  identity key the first time it sees it. A modified server can therefore add
  a participant it controls and receive the room key — E2EE media is not a
  defence against an operator who modifies the server, only against one who
  reads. Pinning catches a known peer's key changing, not an unknown member
  joining.
- **Passwords, session tokens, API tokens are never stored in the clear.**
  Passwords are bcrypt-hashed (cost 12); session and API tokens are stored as
  SHA-256 hashes, never the token itself; TOTP secrets are encrypted with a
  server-local AES-256 key (with a documented pre-encryption legacy exception
  that is never rewritten in place, only ever read as-is with a warning
  logged).
- **One server is one island.** No federation, no cross-server messaging, no
  directory or discovery, and no global identity — an account is a row in one
  server's database, and the same username on two servers is two unrelated
  people. These absences are enforced by router, wire-type and config-key
  tests, not just documentation.
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
- TOTP-based 2FA is supported (enrolment via QR code + backup codes); second-
  factor state, including a pending enrolment and the replay window, is
  durable and encrypted, never stored as a plaintext token or code. Admins can
  require 2FA server-wide.
- Auth challenges are rate-limited to 10 requests/minute per IP.
- Sessions: a user may hold up to 25 sessions, with the oldest evicted beyond
  that. Users can list and revoke their own sessions, sign out everywhere, and
  a password change revokes every other session. Admin force-logout revokes
  all of a user's sessions.
- Account recovery (a self-held recovery kit, or owner-assisted recovery after
  out-of-band identity verification) replaces the password and revokes every
  session in one transaction; a spent or lost kit cannot be recovered by the
  server, and no administrator below the owner can reset another account's
  credentials.
- The first-run setup endpoint (which creates the first Owner account) is
  unauthenticated by necessity, but is gated by a `setup_completed` flag that
  is written once and never cleared by the server, so an emptied users table
  (via account deletion or erasure) does not reopen it to the next caller on
  an allowed network.

### Authorization

- Only the `permissions/` package calls the raw permission-bit helpers.
  Everywhere else in the server resolves a `permissions.Subject` and asks the
  predicate that owns the specific security property (`CanViewChannel`,
  `CanSendMessage`, `CanJoinVoice`, `CanModerateVoice`, etc.) — one predicate
  per property, so a call site cannot re-derive half a rule. This chokepoint
  is enforced by an inventory file (`invariants/authz_chokepoint.go`) that
  only shrinks.
- Voice permission enforcement happens twice: once at `voice_join` (channel
  permission) and again inside the LiveKit JWT itself (`CanPublishSources`
  scoped per role permission) — the client is never the sole gate.
- Admin panel access is IP/CIDR-gated (`admin_allowed_cidrs`), separately from
  bearer admin auth on its API.
- The rule contributors must follow: never trust a client-supplied permission
  or role claim — every authorization decision is re-checked server-side
  through the owning predicate.

### Secrets and credentials

- Server-side secrets that must exist as files (the TOTP encryption key, the
  erasure marker key) are generated only when confirmed absent; any other read
  error refuses to start rather than silently replace a key, which would
  orphan every secret encrypted or named under it. Writes are atomic.
- Config secrets and session/user identifiers are redacted from every log
  line; no `slog` call in server code logs message content.
- Desktop client credentials (login token/password, the voice-E2EE identity
  private key, pending message drafts) are stored in the OS keyring (Windows
  Credential Manager, macOS Keychain, Secret Service), with every write read
  back and verified. If the keyring write is rejected or fails verification,
  the client falls back to an encrypted file (Windows DPAPI with
  `CRYPTPROTECT_UI_FORBIDDEN`; ChaCha20-Poly1305 under a per-install key
  elsewhere), never plaintext at rest.
- A remembered password never crosses IPC back to JavaScript: the field is
  `#[serde(skip)]` on the Rust credential struct, test-locked. The frontend
  gets `has_password` and a placeholder string; submitting it triggers a Rust-
  side login over the same pinned tunnel a normal request uses.
- Contributors must never expose a secret to the renderer/webview, never log
  a token, password, or message body, and never widen a Tauri capability
  (filesystem, HTTP fetch scope, DevTools) beyond what a feature specifically
  needs — capabilities are least-privilege and regression-guarded by tests.

### Input validation and content sanitization

- IPC commands validate host format, string lengths, and character
  allowlists; PTT virtual key codes are range-checked; the LiveKit proxy
  validates `remote_host` against CRLF injection; file uploads enforce a MIME
  type allowlist.
- All user-generated content in the desktop client renders via
  `textContent`/`setText`, never `innerHTML` (the one exception operates on a
  compile-time constant with a runtime guard). URLs are validated to reject
  `javascript:`, `data:` and `vbscript:` schemes; `image/svg+xml` is excluded
  from safe data-URI MIME types; YouTube embeds are sandboxed.
- Automatic outbound fetches of content other users named (link previews,
  external images, GIFs, external avatars) are centralized behind one native
  broker per platform (`Server/safefetch` on the server; the desktop's
  external-content broker in Rust) rather than scattered per call site. Both
  resolve DNS, classify every returned address, and reject loopback, private,
  link-local, multicast, and other non-global destinations before connecting,
  follow at most a small fixed number of redirects by hand, and bound time,
  bytes, content-type and concurrency. A user must opt in (once per server
  profile, or per item) before any such fetch is made, after being told the
  linked site can see their IP.
- Contributors adding a new automatic outbound-content path must route it
  through the existing broker/`safefetch`, not a new bespoke HTTP client.

### Voice and video E2EE

- The room key is generated on a participant's device (WebCrypto), never on
  the server. One participant (the key holder, deterministically the lowest
  user ID in the channel) wraps the key per-recipient with ECDH + AES-GCM; the
  server relays the wrapped bytes without decoding them.
- Media frames are encrypted before they leave the sending device; the LiveKit
  SFU relays ciphertext only.
- Each user has a long-lived identity key. Peers pin it on first sight
  (trust-on-first-use) and block with a mismatch modal if a pinned peer's key
  later changes. The key holder rotates the room key whenever a participant
  leaves, so a departed member cannot decrypt what follows (forward secrecy),
  and also rotates on a timer while the call runs.
- What E2EE does not hide from the operator: who is in which voice channel,
  when, for how long, and mute/deafen state — these are server state, not
  media content.
- Contributors touching the E2EE code (`livekitE2EE.ts`, the `features/voice/
e2ee*.ts` modules, `identity.ts`, or the server's `Server/ws/voice_e2ee.go`)
  must preserve the epoch/keypair staleness guards and must never report an
  unverified peer as verified — this is a security-hardening invariant, not a
  style preference.

### Logging and redaction

- No server log line ever carries message content, a token, a password hash,
  or another secret; dedicated redaction helpers (`Server/db/logvalue.go`,
  `Server/config/logvalue.go`) strip these from every log line and are
  regression-tested.
- The audit log (`audit_log` table) that records security-relevant actions
  (auth, 2FA, admin, content, voice moderation, ops events) is itself
  constrained the same way: an assertion helper fails any audit row whose
  detail field carries a message body, token, hash, or secret, and dedicated
  coverage tests fail if a new mutation ships without an audit row or with an
  unsafe one.
- OwnCord sends no automatic product or usage telemetry. Every diagnostic
  surface (health probe, connectivity diagnostics, metrics, logs, audit log,
  backups) stays on the operator's machine.
- Contributors must not add a log statement, audit-log `detail` field, or
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
  regardless of whether the certificate is self-signed, ACME-issued, or
  manually supplied — the desktop does not validate against the public CA
  list on this connection. A fingerprint mismatch rejects the connection
  before any WebSocket payload or auth frame is sent. All three native
  tunnels (WebSocket, HTTP REST, LiveKit) share one TOFU verifier.
- The session token travels inside the first WebSocket frame, never in the
  URL.
- LiveKit voice/video signaling and media travel over their own paths: through
  the server's proxy for a remote server, or directly when the server's
  LiveKit URL is itself loopback; media always goes directly to LiveKit's
  advertised endpoints. The web admin panel is IP/CIDR-gated separately from
  transport encryption.
- Contributors must not add a remote fetch path (renderer or server) that
  bypasses the pinned tunnels or the outbound-content broker described above.

### Release and update trust chain

- Server self-updates check GitHub Releases, compare semver, download the
  matching asset, verify a signed update manifest that binds the shipped
  binary hash to the release version, cross-check the SHA-256 against a
  checksums file, and (Windows) verify a detached Ed25519/minisign signature
  against a public key committed in the repository. A verification failure
  leaves the installed binary untouched.
- The Tauri desktop client's own updater performs Ed25519 signature
  verification before applying an update.
- Release artifacts additionally carry SLSA Build L2 provenance attestations
  (binding a file to the workflow and commit that produced it, not to a
  person) and, for most binaries, an SBOM; operators can verify checksums,
  attestations and signatures independently via the documented `gh
attestation verify` / `minisign` steps.
- Windows Authenticode/SmartScreen code signing is a known, tracked gap — not
  yet implemented — so SmartScreen still warns on Windows binaries even when
  every other check passes.

### Rules for contributors

- **Never expose a secret.** No password, session token, API token, TOTP
  secret, or private key crosses a trust boundary (IPC to the renderer, a log
  line, an audit-log detail field, a public commit or issue) in the clear.
- **Validate input at every trust boundary** — IPC commands, REST/WebSocket
  payloads, and any URL or hostname taken from message content — using the
  existing allowlist/classification helpers rather than ad hoc checks.
- **Verify authorization server-side, through the owning permission
  predicate, on every request.** Never rely on a client-side permission
  check or a role claim the client supplied.
- **Never weaken a security-hardening invariant that a test locks** — the
  authz chokepoint inventory, the audit-safety assertions, the E2EE
  staleness/verification guards, the redaction helpers, and the absence-of-
  federation contract tests all exist specifically so a change cannot
  regress them silently. If a test blocks a change, fix the change, not the
  test.
- **Report security issues privately.** Do not open a public issue or
  describe an unfixed weakness in a commit message, PR description, or
  changelog — use GitHub Security Advisories as described at the top of this
  document.

### Sources

- [docs/security.md](docs/security.md)
- [docs/trust-model.md](docs/trust-model.md)
- [docs/credential-storage.md](docs/credential-storage.md)
- [docs/architecture/voice-e2ee.md](docs/architecture/voice-e2ee.md)
- [docs/architecture/system-overview.md](docs/architecture/system-overview.md)
- [docs/deployment.md](docs/deployment.md)
- [CLAUDE.md](CLAUDE.md)
- [Server/CLAUDE.md](Server/CLAUDE.md)
- [Client/CLAUDE.md](Client/CLAUDE.md)
