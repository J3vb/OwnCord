# Security Policy

Security guidelines and vulnerability reporting for OwnCord.

## Reporting Vulnerabilities

Report privately via GitHub Security Advisories:
[github.com/J3vb/OwnCord/security/advisories/new](https://github.com/J3vb/OwnCord/security/advisories/new).

**Do NOT open public issues for security bugs.**

The repository-root [SECURITY.md](../SECURITY.md) is the canonical reporting
policy — what to include and the response timeline (initial response within
7 days) live there, so the two files cannot disagree.

## What stays private, and for how long

This applies to weaknesses in the repository's own automation and settings —
workflow authorization, credential scope, release gating — as much as to bugs in
the server or client. Planning documents cite this section as the rule; it is
written here so the citation points at something.

- Public artifacts — commits, issues, pull request descriptions, changelogs —
  carry an **opaque identifier, the affected property, safe acceptance criteria,
  and a status**. Nothing more.
- Reproduction steps, source-to-sink traces, exploit conditions, and the state a
  fix replaced stay in the private advisory. A commit that fixes a weakness
  describes the control it adds, not the gap it closes.
- Every private finding has exactly one public owner, so nothing is tracked only
  in private and nothing is silently dropped.
- Release notes may describe repaired impact after coordinated remediation,
  without the detail needed to reproduce it.

This repository is public. A commit message is a disclosure channel.

## Trust model

What the server operator can and cannot read, what is end-to-end encrypted,
how transport and at-rest data are protected, and what beta does not claim are
stated in one place: [trust-model.md](trust-model.md). Every claim there cites
the code line or test that makes it true.

## Two-Factor Authentication

OwnCord supports TOTP-based 2FA:

- Users enroll via Settings > Account (QR code + backup codes)
- Emergency recovery codes (BPR-046): ten `XXXXX-XXXXX` codes are issued once at
  enrolment and on every `POST /api/v1/users/me/totp/recovery-codes`
  (password-confirmed). Each is accepted once in place of a TOTP code at
  `verify-totp`, which then reports `recovery_codes_remaining`; the server
  stores bcrypt hashes only, and disabling 2FA or deleting the account removes
  the set. Security questions do not exist and will not.
- Second-factor state is durable (migration 032): the login challenge, a
  pending enrolment (encrypted under the TOTP key) and the 90-second replay
  window survive a restart, stored as digests and ciphertext — never a token
  or code in the clear. A store fault fails closed: no challenge is issued and
  no code is accepted on trust.
- The TOTP encryption key (`data/totp.key`, or `OWNCORD_TOTP_KEY`) is generated
  only when confirmed absent; any other read error refuses to start rather than
  replace the key (which would orphan every stored secret), and the write is
  atomic. Back the key file up beside the database — a backup does not contain
  it.
- Admins can enforce server-wide 2FA via the `require_2fa` setting in the admin panel
- `require_2fa` requires all users to have 2FA enabled and registration to be closed
- Login flow returns `requires_2fa: true` with a `partial_token` (10-min TTL, 5-attempt limit)
- Auth challenges are rate-limited to 10 req/min per IP
- Every bcrypt computation on an authentication route — password checks and hashes, recovery-code matching — is admitted through one process-wide concurrency budget (`security.expensive_auth_concurrency`, default twice the core count); an over-budget attempt is refused with `429 RATE_LIMITED`, runs no bcrypt and counts as no failed attempt
- TOTP code verification uses constant-time comparison (`subtle.ConstantTimeCompare`) to prevent timing side-channel attacks

## Account Deletion

Users can delete their own account via `DELETE /api/v1/auth/account` with password confirmation. The last admin account cannot be deleted. After 3 failed password attempts, the endpoint locks out for 15 minutes.

## Audit Logging

Security-relevant actions are recorded in the `audit_log` table with actor, action, target, and detail:

- **Auth:** `user_register`, `user_login`, `user_logout`, `login_blocked_banned`, `account_deleted`, `password_change`, `session_revoke`
- **2FA:** `totp_enabled`, `totp_verified`, `totp_disabled`, `recovery_codes_regenerated`
- **Admin:** `role_change`, `role_create`, `role_update`, `role_delete`, `role_reorder`, `user_ban`, `user_unban`, `force_logout`, `setting_change`, `server_setup`, `api_token_create`, `api_token_revoke`, `config_write`, `invite_create`, `invite_revoke`, `plugin_install`, `plugin_uninstall`
- **Content:** `channel_create`, `channel_update`, `channel_delete`, `channel_perms_update`, `channel_perms_clear`, `channel_user_perms_update`, `channel_user_perms_clear`, `message_delete`, `message_purge`, `emoji_create`, `emoji_delete`
- **Profile:** `profile_update`, `identity_key_update`
- **Ops:** `backup_create`, `backup_delete`, `backup_restore`, `ws_connect`

Note: `backup_restore` is written synchronously to the live database _before_
the pre-restore safety copy is taken, so the row survives inside the
`pre_restore_*.db` backup. The restored database itself will not contain it —
the restore replaces the database file wholesale.

## Client Security Hardening

The Tauri desktop client implements the following security measures:

### Credential Storage

- Credentials are stored in the OS keyring (Windows Credential Manager / macOS Keychain / Secret Service) via the `keyring` crate, with every write read back and verified; if no keyring is available they fall back to an encrypted file (Windows DPAPI with `CRYPTPROTECT_UI_FORBIDDEN`, ChaCha20-Poly1305 elsewhere) — see [credential-storage.md](credential-storage.md)
- Plaintext passwords are **never** returned to the frontend over IPC — only tokens are accessible from JavaScript
- Auto-login uses stored tokens for reconnection, not passwords

### Tauri Capabilities (Least Privilege)

- Filesystem write access is scoped to `$APPDATA/**` and `$APPLOG/**` only
- DevTools command is gated behind the `devtools` feature flag (excluded from release builds)
- HTTP fetch is restricted to `https://` origins plus `http://127.0.0.1:*` (the Rust TOFU proxy's loopback tunnel), and **denies** `https://localhost[:*]` and `https://127.0.0.1[:*]` — no legitimate flow reaches loopback over https, so the deny list keeps the renderer from probing other local services
- `http:allow-fetch` is the **only** URL-scoped HTTP identifier. `tauri-plugin-http` validates the URL exactly once, in the `fetch` command; `fetch_send` and `fetch_read_body` operate on an already-validated `ResourceId` and never consult a scope, so `allow`/`deny` blocks on those identifiers are inert and were removed rather than left in place advertising a control that does not exist
- The `https://*` wildcard cannot be removed today: link previews (`embeds.ts`) fetch arbitrary user-posted URLs by design, and Tauri scopes per _command_, not per JS caller. Bounded in TypeScript by `isPrivateHost`/`isBlockedForPreview`, a 5 s timeout and a 50 KB body cap; the response is regex-scraped for `og:` tags and never executed
- Regression-guarded by `tests/unit/capabilities-scope.test.ts`; rationale and the follow-up that would remove the wildcard are in [docs/plans/tauri-capability-narrowing.md](plans/tauri-capability-narrowing.md)

### TLS and Certificate Pinning (TOFU)

- Self-signed certificates are supported via Trust-On-First-Use (TOFU) pinning
- The WebSocket proxy (`ws_proxy`) pins the server certificate fingerprint on first connection
- The LiveKit proxy (`livekit_proxy`) reuses the pinned fingerprint from the WS proxy
- Certificate mismatch triggers a modal requiring user acknowledgment
- Update downloads validate `server_url` uses `https://` and rejects URLs with userinfo

### Input Validation

- IPC commands validate host format, string lengths, and character allowlists
- PTT virtual key codes are validated to the Win32 range (1–254)
- LiveKit proxy `remote_host` is validated against CRLF injection
- API client validates host format before constructing URLs
- File uploads enforce a MIME type allowlist (images, video, audio, PDF, text)
- Error messages from server responses are capped at 200 characters
- Notification titles are sanitized (control chars stripped, length capped)

### XSS Prevention

- All user-generated content is rendered via `textContent`/`setText` — never `innerHTML`
- The single `innerHTML` usage (SVG icons) operates on compile-time constants with a runtime guard
- URLs are validated via `isSafeUrl` (rejects `javascript:`, `data:`, `vbscript:`)
- YouTube embeds use `sandbox` attribute on iframes
- `image/svg+xml` is excluded from safe MIME types for data URIs
- GIF media URLs are validated against the trusted Klipy CDN origins
- Linkified URLs strip trailing punctuation to prevent misleading destinations

### Search and Rate Limiting

- Client-side search requests are rate-limited (500ms minimum interval + 300ms debounce)

## Known Limitations

- Server auto-updates depend on a dedicated pinned minisign/Ed25519 server release key in [Server/updater/server_update_public_key.txt](../Server/updater/server_update_public_key.txt) and a signed release manifest that binds the shipped binary hash to the release version; Windows Authenticode/SmartScreen code signing is still separate work
- CSP `connect-src` allows `https:` to any host (necessary for self-hosted server URLs not known at build time). Because of this, narrowing the Tauri `http:allow-fetch` scope alone would not bound exfiltration from a compromised renderer — the webview's own `fetch` reaches the same hosts without going through the plugin. Closing that requires narrowing `connect-src` and moving the link-preview fetch into Rust in the same change

## Security Hardening Checklist for Operators

- [ ] Enable TLS (self-signed is the default; custom certs recommended for production)
- [ ] Keep invite-only registration enabled (default)
- [ ] Set a strong admin password
- [ ] Configure rate limits (defaults are sensible but review for your use case)
- [ ] Run regular backups via the admin panel
- [ ] Keep the server updated (admin panel shows available updates)
- [ ] Firewall: only expose port 8443 (HTTPS); for voice/video also 7880-7881/TCP and 50000-60000/UDP (LiveKit signaling + media — see [deployment.md](deployment.md)); port 80 only when using ACME
- [ ] Enable server-wide 2FA requirement once all users have enrolled
- [ ] Set `admin_allowed_cidrs` to restrict admin panel access to trusted networks
