# Security Policy

## Reporting Vulnerabilities

Use GitHub Security Advisories to report vulnerabilities: go to Settings > Security > Advisories and create a new advisory.

**Do NOT open public issues for security bugs.**

## Response Timeline

- **Acknowledgment:** Within 48 hours
- **Critical fixes:** Within 7 days
- **Non-critical fixes:** Included in the next release

## Known Limitations

- No code signing yet — binaries are verified via SHA256 checksums only

## Security Hardening Checklist for Operators

- [ ] Enable TLS (self-signed is the default; custom certs recommended for production)
- [ ] Keep invite-only registration enabled (default)
- [ ] Set a strong admin password
- [ ] Configure rate limits (defaults are sensible but review for your use case)
- [ ] Run regular backups via the admin panel
- [ ] Keep the server updated (admin panel shows available updates)
- [ ] Firewall: only expose port 8443 (HTTPS) and 3478 (TURN/STUN for voice)
