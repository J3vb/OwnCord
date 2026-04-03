# Security Policy

Security guidelines and vulnerability reporting for OwnCord.

## Reporting Vulnerabilities

Use GitHub Security Advisories to report vulnerabilities: go to Settings > Security > Advisories and create a new advisory.

**Do NOT open public issues for security bugs.**

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Critical fixes:** Within 7 days
- **Non-critical fixes:** Included in the next release

## Two-Factor Authentication

OwnCord supports TOTP-based 2FA:

- Users enroll via Settings > Account (QR code + backup codes)
- Admins can enforce server-wide 2FA via the `require_2fa` setting in the admin panel
- `require_2fa` requires all users to have 2FA enabled and registration to be closed
- Login flow returns `requires_2fa: true` with a `partial_token` (10-min TTL, 5-attempt limit)
- Auth challenges are rate-limited to 10 req/min per IP
- TOTP code verification uses constant-time comparison (`subtle.ConstantTimeCompare`) to prevent timing side-channel attacks

## Account Deletion

Users can delete their own account via `DELETE /api/v1/auth/account` with password confirmation. The last admin account cannot be deleted. After 3 failed password attempts, the endpoint locks out for 15 minutes.

## Audit Logging

Security-relevant actions are recorded in the `audit_log` table with actor, action, target, and detail:

- **Auth:** `user_register`, `user_login`, `user_logout`, `login_blocked_banned`, `account_deleted`
- **2FA:** `totp_enabled`, `totp_verified`, `totp_disabled`
- **Admin:** `role_change`, `user_ban`, `user_unban`, `force_logout`, `setting_change`, `server_setup`
- **Content:** `channel_create`, `channel_update`, `channel_delete`, `message_delete`
- **Ops:** `backup_create`, `backup_delete`, `backup_restore`, `ws_connect`

## Client Security Hardening

The Tauri desktop client implements the following security measures:

### Credential Storage
- Credentials are stored in Windows Credential Manager via DPAPI (per-user scope, `CRED_PERSIST_ENTERPRISE`)
- Plaintext passwords are **never** returned to the frontend over IPC — only tokens are accessible from JavaScript
- Auto-login uses stored tokens for reconnection, not passwords

### Tauri Capabilities (Least Privilege)
- Filesystem write access is scoped to `$APPDATA/**` and `$APPLOG/**` only
- DevTools command is gated behind the `devtools` feature flag (excluded from release builds)
- HTTP fetch permissions are restricted to `https://` origins

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
- Tenor GIF URLs are validated against trusted CDN origins
- Linkified URLs strip trailing punctuation to prevent misleading destinations

### Search and Rate Limiting
- Client-side search requests are rate-limited (500ms minimum interval + 300ms debounce)

## Known Limitations

- Server auto-updates depend on a dedicated pinned minisign/Ed25519 server release key in [Server/updater/server_update_public_key.txt](Server/updater/server_update_public_key.txt) and a signed release manifest that binds the shipped binary hash to the release version; Windows Authenticode/SmartScreen code signing is still separate work
- The Tenor API key is hardcoded (Google's public anonymous key) — consider build-time injection for production
- CSP `connect-src` allows `https:` to any host (necessary for self-hosted server URLs not known at build time)

## Security Hardening Checklist for Operators

- [ ] Enable TLS (self-signed is the default; custom certs recommended for production)
- [ ] Keep invite-only registration enabled (default)
- [ ] Set a strong admin password
- [ ] Configure rate limits (defaults are sensible but review for your use case)
- [ ] Run regular backups via the admin panel
- [ ] Keep the server updated (admin panel shows available updates)
- [ ] Firewall: only expose port 8443 (HTTPS) and 7880 (LiveKit WebSocket for voice/video)
- [ ] Enable server-wide 2FA requirement once all users have enrolled
- [ ] Set `admin_allowed_cidrs` to restrict admin panel access to trusted networks
