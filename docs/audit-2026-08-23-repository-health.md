# OwnCord full repository-health audit

**Audited:** 2026-08-23  
**Audited head:** `5cc0888964e26276d1aca145e83270a2c1b9febd` (`dev`)  
**Conclusion:** strong server foundation; not beta-ready

## Executive status

OwnCord is in a promising but pre-beta state. The server is the stronger half:
its principal build, race, deadlock, tagged-test, and vet gates pass. The
client has a substantial desktop foundation, but its required unit-coverage
gate is red and its full Playwright process does not terminate. The approved
browser/PWA/phone/tablet product is mostly still a planned workstream.

| Area                   | Status         | Evidence-based conclusion                                                                                                                                                                        |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server core            | Strong / amber | Builds and concurrency-oriented tests pass; coverage is 74.6%; architecture, security boundaries, capacity, and operations still need work.                                                      |
| Desktop client         | Amber-red      | TypeScript, build, static checks, Rust checks, and browser smoke pass; 5,255 unit tests pass but 2 fail, and Playwright does not exit cleanly.                                                   |
| Browser/PWA/mobile     | Red            | No production browser target, optional server-hosted bundle, PWA lifecycle, Web Push, or beta-quality mobile navigation is complete.                                                             |
| Security/privacy       | Red / pending  | Private current-head security evidence contains unresolved work. The restarted independent deep scan was not sealed because it produced no manifest or result before the audit budget limit.     |
| CI/release/platforms   | Amber-red      | Signing, checksums, source snapshots, and cold-boot foundations are good; exact-SHA dev evidence, ARM64 coverage, multi-architecture Docker, and native release qualification remain incomplete. |
| Repository/community   | Amber          | Server/client separation is understandable; a focused client-layout and contributor-experience migration is justified.                                                                           |
| Overall beta readiness | Red            | Do not publish the public beta from this head.                                                                                                                                                   |

## Validation evidence

### Server

- Default, OpenTelemetry, Wazero-tagged WASM runtime, and combined builds pass.
- `go vet`, the full race suite, deadlock tests, and tag-gated tests pass.
- CI-style aggregate coverage is 74.6%; there are many tests and fuzz targets,
  but no benchmark baseline for the highest-risk hot paths.
- Docker validation was unavailable locally because no Docker daemon was
  attached. Local `golangci-lint` could not load because its binary and module
  toolchains differed; this needs matched-tool or CI evidence.
- Structural debt remains in large hub/serve/lifecycle files and numerous
  direct database call sites.

### Client

- Application and E2E typechecks, ESLint, Prettier, Knip, production npm audit,
  Vite build, Rust Clippy, and 115 Rust tests pass.
- Vitest coverage is red: 5,255 passed and 2 failed in the message-list and
  noise-suppression restart contracts.
- Three direct Chromium browser tests pass, but this is a narrow API harness,
  not a production browser client.
- The 293-test Playwright journey reaches its test activity but does not exit;
  an isolated five-test voice-widget run also hangs.
- Oxlint exits successfully but reports 471 warnings. The largest lazy feature
  output is approximately 2.0 MB minified / 1.345 MB gzip, with additional
  oversized-chunk and dynamic-import warnings.

### Repository and release

- The audited SHA has no GitHub Actions run, so local evidence is not an
  exact-SHA integration qualification.
- The release workflow has good signing, checksum, source-snapshot, and
  server-cold-boot foundations, but the approved Windows/Linux ARM64 and
  multi-architecture Docker matrix is not complete.
- Node guidance is inconsistent (`.nvmrc` 20 versus CI 24); the repository
  needs one enforced version source.
- Generated graph/ledger artifacts, protocol ownership, tool discovery, hooks,
  issue intake, and externally triggered automation all need explicit policy.

## Product gaps that block beta

The approved requirements require server-hosted browser support disabled by
default, shared desktop/browser contracts, PWA installation, phones/tablets,
opt-in per-server Web Push, N/N-1/N-2 protocol epochs, recovery kits, session
alerts and sign-out-everywhere, deletion that survives restore, configurable
retention, Message Requests, moderation reports/appeals, NSFW no-fetch-before-
consent, translation-ready English text, and the full release architecture
matrix. Most of these are absent or only partial today.

## Repository structure decision

A targeted migration is justified, not a rewrite:

1. Flatten `Client/tauri-client/` to `Client/` in adjacent pure-move and
   mechanical-path-rewrite commits.
2. Keep one shared UI and add typed desktop/browser platform contracts later in
   B7, after server-first contracts and services are stable.
3. Keep `Server/` and its package tree stable.
4. Make protocol schema, generated artifacts, tools, hooks, and contributor
   commands explicit and reproducible.

## Deployment constraints that must be designed into beta

Public domains and eligible stable public IPs can use built-in ACME. Private
or reserved LAN addresses cannot receive public-CA certificates and require a
server-local CA plus one-time trust installation on each browser device. Web
service workers, media capture, screen sharing, and Push API behavior require a
secure context in normal browser use. See the [Let’s Encrypt IP certificate
guidance](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability),
[ACME challenges](https://letsencrypt.org/docs/challenge-types/), and [W3C
secure-context standards](https://www.w3.org/TR/secure-contexts/).

Fully offline browser use can work after local trust onboarding, but closed-app
Web Push cannot be treated as an offline capability. CGNAT, blocked ports, and
changing raw IP origins remain operator/network limitations rather than bugs
OwnCord can hide.

## Phased route

The approved execution sequence is B0–B10:

`B0 truth → B1 repository foundation → B2 protocol/trust → B3 server guardrails → B4 identity/privacy → B5 community/moderation → B6 deployment/capacity → B7 shared desktop platform → B8 browser/PWA/mobile → B9 unified UX/accessibility → B10 qualification/public release`

No phase closes on elapsed time. Each phase requires exact-SHA evidence, and
B10 additionally requires a complete platform/deployment matrix, migration,
restore, rollback, security, accessibility, capacity, and release scorecard.

## Audit artifacts

- [Beta product requirements](plans/beta-product-requirements-2026-08-23.md)
- [Exhaustive issue register](plans/repo-health-issue-register-2026-08-23.md)
- [Server-first roadmap](plans/repo-health-roadmap-2026-08-23.md)
- [Requirement traceability](plans/beta-requirements-traceability-2026-08-23.md)
- [Repository-layout audit](audit-2026-08-23-repository-layout.md)

The detailed reports under `docs/security-findings/` are intentionally
untracked/private and must not be committed to a public repository before
coordinated remediation.

## Recommended first implementation slice

Begin B0 only: repair the two failing unit contracts, make Playwright terminate
reliably, obtain matched lint/Docker evidence, reconcile private security
findings, and run the full exact-SHA matrix. Then perform the isolated B1
repository migration before implementing new client features.
