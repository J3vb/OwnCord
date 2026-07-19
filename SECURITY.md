# Security Policy

## Supported versions

OwnCord is in alpha. Only the **latest release** receives security fixes.
There are no backports.

| Version | Supported |
| ------- | --------- |
| Latest release (see [OwnCord-releases](https://github.com/J3vb/OwnCord-releases/releases)) | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Report vulnerabilities privately via GitHub Security Advisories on the
[OwnCord-releases](https://github.com/J3vb/OwnCord-releases/security/advisories/new)
repository ("Report a vulnerability"). This channel works even while the
source repository is private.

Please include:

- Affected component (server, desktop client, admin panel, plugin host)
- Reproduction steps or a proof of concept
- The release version (or source snapshot) you tested against

You will get an initial response within 7 days. Coordinated disclosure is
appreciated; fixes ship in the next release with credit unless you prefer
otherwise.

## Hardening documentation

Operator-facing hardening notes live in [docs/security.md](docs/security.md).
