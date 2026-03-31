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

## Known Limitations

- No code signing yet -- binaries are verified via SHA256 checksums only

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
