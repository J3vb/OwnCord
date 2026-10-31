# Security Policy

This page tells you how to report a security problem in OwnCord.

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

## More

- Keeping a server safe: [docs/security.md](docs/security.md).
- The security model and the rules every code change follows:
  [docs/security-model.md](docs/security-model.md).
