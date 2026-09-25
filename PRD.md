# OwnCord Product Requirements Document

Condensed from the sources listed at the end, at commit `7732f969`
(2026-09-25). On conflict, the source documents win.

## Product overview

**Name:** OwnCord.

**One-line description:** A self-hosted chat platform — real-time text
channels, voice/video, and file sharing — run by its owner on their own
hardware, with no OwnCord-operated service of any kind.

**Vision:** "A self-hosted chat app I build for me and my friends — text
channels, voice and video, and a server you actually own." ([README.md](README.md))
It is currently an alpha, hobby-scale project: most of the implementation is
AI-generated, quality is held up by CI/tests/linting and real usage by the
author and friends, and behavior can change quickly between releases
([README.md](README.md)). The product direction beyond alpha is the beta —
a public GitHub release anyone can download (BPR-001) — governed by the beta
product requirements below.

## Problem

An owner can already run OwnCord's alpha, but nothing yet proves a stranger —
someone with no access to the codebase or its authors — can deploy, upgrade,
recover, and operate it unaided on every supported mode, or that the desktop
client is one coherent, contract-bound application rather than 21+ files each
reaching into native APIs directly ([b6-server-deployment-operations-capacity.prd.md](docs/plans/b6-server-deployment-operations-capacity.prd.md),
[b7-shared-client-platform-desktop-parity.prd.md](docs/plans/b7-shared-client-platform-desktop-parity.prd.md)).
Feature-complete server behavior is not the same thing as a server a stranger
can host, and a working client is not the same thing as a client whose
update, profile, session, and recovery flows are proven end to end. Shipping
without solving this means the public beta works "on the maintainer's
machine" and fails, silently or confusingly, on everyone else's.

## Goal

Ship a public beta that a self-hosting owner with ordinary sysadmin skill can
deploy, operate, and trust unaided, and that a desktop user can use for daily
chat, voice/video, moderation, and account lifecycle without being routed
through any OwnCord-operated service. Beta scope is frozen to the [beta
product requirements](docs/plans/beta-product-requirements-2026-08-23.md)
document (BPR-003): new ideas go to a post-beta backlog unless required for
security, correctness, accessibility, platform parity, or finishing an
already-approved feature. There is no calendar deadline — a phase closes only
when its evidence and exit gates are green (BPR-002).

## Target users

- **Self-hosting server owner** — ordinary sysadmin skill, no access to the
  codebase or its authors; stands up a server on a domain, a public IP, a
  home LAN, or fully offline ([b6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Users").
- **Release engineer** — produces signed, traceable release artifacts for
  every supported architecture (same source).
- **Desktop member** of a self-hosted server — reads/sends messages, joins
  voice/video, manages their own account and devices
  ([b7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Users",
  [b9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Users").
- **First-contact recipients, reporters, and moderated members** — the
  Message Requests, reporting, and appeals flows exist for them
  ([b9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Users").
- **Narrowly authorized local moderators and the server owner** — day-to-day
  moderation and owner-only operational controls (TLS, backups, updates)
  (BPR-072, [b9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md)).
- **Client contributor** — moves existing client behavior behind typed
  platform contracts without regressing it
  ([b7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Users").
- **Not targeted (beta):** anonymous guests, a public server directory, more
  than one active server connection per client, browser/PWA/phone/tablet
  users (see Out of scope), and anyone expecting an OwnCord-operated hosted
  service (BPR-012, BPR-042, BPR-034).

## Core features

From [README.md](README.md) "What OwnCord Already Has" and the beta
requirements:

- Real-time channels and direct messages over WebSocket.
- Voice/video channels via LiveKit — the LiveKit server binary is downloaded
  and managed for the owner automatically.
- Invite-only registration by default, with owner-configurable
  approval-based or open registration (BPR-041), and role-based permissions.
- Web admin panel with logs, backups, and update tooling.
- File uploads and inline media rendering, with link previews, GIF search,
  and YouTube/media embeds behind bounded, SSRF-resistant retrieval
  (BPR-061, BPR-062).
- TOTP two-factor authentication, emergency recovery codes, and a locally
  generated account-recovery kit — registration and recovery work without
  SMTP or any central service (BPR-043, BPR-044, BPR-046).
- API rate limiting and desktop client auto-update with signature
  verification.
- Multi-device sessions per account, with a device list, new-login notice,
  individual revocation, and sign-out-everywhere (BPR-035).
- Message Requests inbox for first-time DMs, with preview/accept/ignore/
  delete/block (BPR-060).
- Owner-designated NSFW channels with explicit labels and per-user,
  server-backed consent before any preview loads (BPR-063).
- Local moderation: user reports, a permission-gated Moderation Center
  (queue, evidence, assignment, notes, actions, immutable audit history),
  warning/timeout/removal/kick/ban, and rate-limited in-app appeals
  (BPR-070–073).
- WASM plugin system for slash commands — experimental, sandboxed, and
  disabled by default (`plugins.enabled`, build tag `wazero`); no beta
  plugin-API compatibility promise is made (BPR-080).
- GIF picker, off by default, using a server-supplied Klipy key.
- No automatic product/usage telemetry; diagnostics stay local, and
  support-bundle export is user-initiated (BPR-055).

## User flows

Full behavioral specs (states, transitions, event → reaction maps) live in
[docs/architecture/ux/](docs/architecture/ux/README.md); this section
summarizes the flows it defines as the client's target behavior.

**Connection & auth** ([connection-and-auth.md](docs/architecture/ux/connection-and-auth.md)):
the app is a two-page state machine (`connect | main`). On the connect page a
user picks a saved server profile (health-checked every 15 s), signs in
through an explicit form state machine (`idle → loading → totp → connecting
→ auto-connecting`, with client-side validation before any request), and —
depending on the server's registration mode (`invite | open | approval |
closed`) — registers by invite or waits for approval. A protocol-epoch
mismatch badges the server row advisorily; the WebSocket refusal is the
authority and raises an exitable incompatible-version notice naming which
side updates. Login proceeds to a WebSocket handshake; the client never
navigates to the main view until the server's `ready` event arrives, so the
UI never renders against empty stores. Reconnection uses exponential backoff
and replays missed events by `last_seq`, with a persistent banner and
disabled live-controls while reconnecting; a self-signed certificate is
Trust-On-First-Use, with the client refusing to send credentials to an
unconfirmed host until the user accepts its fingerprint, and a later
fingerprint mismatch blocks reconnection behind another explicit accept/reject
prompt.

**Messaging** ([messaging.md](docs/architecture/ux/messaging.md)): sending is
optimistic — a message appears locally as "pending" and reconciles against
the server's echo, rolling back visibly with a retry on failure, never
silently. The composer gates on connection status and effective permissions
(e.g., announcement-channel read-only, slow-mode cooldowns) by disabling with
a stated reason rather than accepting a click that will be rejected. The spec
also covers edit/delete, reactions, attachments, replies, pins, search,
read/unread tracking, message jumping, mentions, and Markdown rendering.

**Channels, members & DMs** ([channels-members-dms.md](docs/architecture/ux/channels-members-dms.md)):
the channel sidebar reflects live create/update/delete events and redirects
the user if their active channel is removed; the member list shows live
presence, typing, and role/permission-driven affordances; direct messages can
be opened, closed, and blocked.

**Voice & E2EE** ([voice-and-e2ee.md](docs/architecture/ux/voice-and-e2ee.md)):
joining/leaving a voice channel, mute/deafen/camera/screenshare, push-to-talk,
and the active-speaker roster are driven by two coordinated state machines
(OwnCord's control plane and LiveKit's media session). Voice, video, and
screen-share are end-to-end encrypted between participants (BPR-050), and the
client surfaces securing/key-ready indicators and an identity-verification
surface during the handshake; token refresh and reconnect are designed to be
invisible to the user.

**Settings & admin** ([settings-and-admin.md](docs/architecture/ux/settings-and-admin.md)):
a settings overlay covers account operations (password, TOTP, recovery kit,
sessions, deletion disclosure, local support-bundle export), appearance and
theming, the client's inline admin surface (ban/kick/roles, channel CRUD,
invites) for permitted users, the desktop auto-updater, and system tray
behavior.

## Requirements

### Functional (selected BPR IDs; full text in [beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md))

| Area               | Requirement                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release            | BPR-001 public GitHub release; BPR-002 no deadline, evidence-gated; BPR-003 scope frozen to the beta requirements doc; BPR-004 alpha data/config survives an in-place upgrade; BPR-005 deterministic-where-possible builds with signed provenance/SBOM.                                                                                                                                                                 |
| Platforms          | BPR-010 desktop: Windows x64/ARM64, Linux x64/ARM64; BPR-011 server: Windows/Linux x64/ARM64 binaries plus multi-arch Docker images.                                                                                                                                                                                                                                                                                    |
| Identity           | BPR-040 accounts are per-server, no global identity; BPR-041 invite-only by default; BPR-042 all features require an authenticated account; BPR-043 email optional; BPR-044/046 local recovery kit, TOTP, emergency codes; security questions prohibited.                                                                                                                                                               |
| Privacy            | BPR-050 hybrid trust model (server sees text/files, voice/video/screen-share E2EE); BPR-051 server-operator trust disclosed plainly; BPR-052 account deletion erases authored data; BPR-053 audit/moderation history survives deletion only as an unlinkable event record (HMAC-token model, see amendment in the source); BPR-054 indefinite retention by default, owner-configurable; BPR-055 no automatic telemetry. |
| Messaging & safety | BPR-060 Message Requests inbox; BPR-061/062 bounded, SSRF-resistant external content; BPR-063 NSFW channels need explicit label + per-user consent; BPR-064 English-only for beta, translation-ready text architecture.                                                                                                                                                                                                 |
| Moderation         | BPR-070 local reporting, no central service; BPR-071 permission-gated Moderation Center; BPR-072 warn/timeout/remove/kick/ban by role; BPR-073 rate-limited appeals with audited decisions.                                                                                                                                                                                                                             |
| Client experience  | BPR-090 preserve visual identity, no rebrand; BPR-091 accessibility is a release property, not a later pass; BPR-092 browser/offline limitations stated honestly (client-relevant portion; browser itself is post-beta).                                                                                                                                                                                                |
| Capacity           | BPR-030 ≥250 registered users, ≥100 simultaneous connections, ≥25 concurrent voice participants, on published, reproducible hardware.                                                                                                                                                                                                                                                                                   |
| Compatibility      | BPR-031 server upgrades before clients; BPR-032 epoch-gated protocol compatibility with a coded refusal naming which side to update; BPR-033 clear update notice / safe incompatible-state handling; BPR-034 one live connection per client, isolated saved profiles; BPR-035 multi-device sessions with revocation.                                                                                                    |

### UX

- Every data-bearing view must represent a defined `loading | ready | empty |
error | stale | permission-denied | offline` state with a specified
  presentation — no silent states ([ux/README.md](docs/architecture/ux/README.md) §1).
- One canonical feedback primitive per situation (toast, inline field error,
  inline section error + retry, persistent banner, blocking modal, two-click
  confirm, disabled-with-reason) — picked by a fixed decision table, not
  improvised per call site (§2).
- Connection status (`connected | reconnecting | disconnected`) is a single
  source of truth that every live-only control reads reactively, not
  per-click (§3).
- Every inbound WebSocket event produces a defined store mutation and, where
  user-visible, a defined UI reaction (§4); one canonical reaction per
  failure/permission class, applied uniformly everywhere (§5).
- Optimistic locally, authoritative from the server; permission is expressed
  as a pre-disabled affordance, not a rejection after the fact (§6).
- BPR-090/091: preserve OwnCord's recognizable visual identity and familiar
  workflows while treating accessibility (keyboard, pointer, touch, screen
  reader, reduced motion, contrast, focus, zoom, responsive layout) as a
  release-blocking property, not a cosmetic pass.

### Performance

Published capacity profile and latency budgets, measured on reproducible
reference hardware (2 vCPU / 4 GB RAM / SSD, Linux x64, run inside a
constrained cgroup) — see [docs/capacity.md](docs/capacity.md):

| Path                                                    | p95 budget | p99 budget | Latest measured (constrained leg) |
| ------------------------------------------------------- | ---------- | ---------- | --------------------------------- |
| REST login                                              | < 600 ms   | < 1 s      | 315 ms / 331 ms                   |
| WebSocket open → `auth_ok`                              | < 200 ms   | < 500 ms   | 21 ms / 35 ms                     |
| Message send → sender acknowledgement                   | < 150 ms   | < 300 ms   | 51 ms / 78 ms                     |
| Message send → recipient delivery (all connections)     | < 200 ms   | < 400 ms   | 53 ms / 79 ms                     |
| Voice join, OwnCord half (`voice_join` → `voice_token`) | < 250 ms   | < 500 ms   | 4 ms / 6 ms                       |
| Graceful drain to exit 0                                | < 20 s     | —          | (smoke-gated, not a percentile)   |

Budgets may only be tightened from data, never loosened; the reference
capacity target itself — ≥250 registered users, ≥100 simultaneous
connections (180 s sustain), ≥25 concurrent voice participants — was met on
2026-09-12 and reproduced on a second run (BPR-030, [capacity.md](docs/capacity.md)).
Operational scenarios (reconnect storms, database-writer/reader wait,
message fan-out to a ceiling, voice control churn, upload/download pressure,
TLS overhead, graceful shutdown under load) are measured the same way and
published with the same never-loosen rule; two operational budget misses are
open findings tracked outside this document, not silently absorbed into a
looser number.

### Platform

- **Desktop only for beta.** Officially supported targets are Windows x64,
  Windows ARM64, Linux x64, and Linux ARM64 (BPR-010); the desktop artifact
  matrix installs, boots, connects, updates, rolls back, and recovers under
  CI smoke on all four ([b7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md)).
- **Server matrix:** Windows x64/ARM64 executables, Linux x64/ARM64
  archives, and multi-architecture Docker images for `linux/amd64` and
  `linux/arm64`; Docker is the primary deployment path, standalone binaries
  remain fully tested release assets (BPR-011).
- Each server is independently owner-hosted; there is no OwnCord-operated
  community server or identity service (BPR-012). A reverse proxy is
  supported but never required for direct port-forward operation (BPR-013).
- TLS: `self_signed`, `acme`, and `manual` modes exist in the code; only
  `self_signed` is qualified at beta-planning time — automatic public-CA
  certificate lifecycle work (domain/public-IP ACME, guided LAN/offline
  device trust) was deferred by owner decision, and a reverse proxy is the
  recommended HTTPS path for a domain owner in the interim
  ([b6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "TLS block deferred").
- Build prerequisites: Go 1.26+, Node.js 26.x / npm 11.x, Rust stable
  ([README.md](README.md) "Build and Test").

## Success metrics

Only exit-gate/evidence criteria the repo itself defines, from the phase
PRDs:

**B6 — server deployment, operations, capacity** ([b6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Success Metrics"):

| Metric                                                         | Status                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Registered users ≥ 250                                         | Met 2026-09-12                                                                     |
| Simultaneous connections ≥ 100 (180 s sustain)                 | Met 2026-09-12                                                                     |
| Concurrent voice ≥ 25                                          | Met 2026-09-12 (625/625 tracks, 0% loss)                                           |
| Latency budgets tightened from the first run                   | Done, re-verified on a second run                                                  |
| Reference hardware published (2 vCPU / 4 GB / SSD / Linux x64) | Done                                                                               |
| TLS mode matrix                                                | Not measured — B6-3–B6-5 deferred; accepted limitation at HP-6 (owner, 2026-09-20) |
| Artifact matrix (install/migrate/heal/drain/restart/restore)   | Delivered across B6-1, B6-2, B6-8, B6-11 milestones                                |
| Operator usability                                             | Gated on HP-6 (owner sign-off), pending at last read                               |

**B7 — shared client platform & desktop parity** ([b7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Success Metrics"; **HP-7 signed by the owner 2026-09-23**):

| Metric                                                | Target / result                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native imports outside `platform/desktop` + bootstrap | 0                                                                                                                                                                                                                                                           |
| oxlint unapproved warnings                            | 0 (from 471 at B0 baseline)                                                                                                                                                                                                                                 |
| Import cycles                                         | 0, or each boundary-tested                                                                                                                                                                                                                                  |
| Client statement-coverage floor                       | Raised from 70% toward 93% across milestones                                                                                                                                                                                                                |
| Bundle budgets                                        | Enforced in CI against the B0 baseline                                                                                                                                                                                                                      |
| BPR-033/034/035 evidence                              | Each has a passing traceability row                                                                                                                                                                                                                         |
| Desktop artifact matrix                               | 4/4 targets passing install/boot/connect/update/rollback/media/recovery smoke                                                                                                                                                                               |
| HP-7                                                  | Signed 2026-09-23, with stated limits (nightly schedule inert until main carry, first-release Windows ARM64 update N/A, owner-run Linux device check outstanding); B7 phase itself remained `in-progress` on reconciliation items as of the cited PRD text. |

**B9 — unified feature experience, accessibility, polish** ([b9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Success metrics"):

| Outcome                  | Gate                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement completeness | Every planned row has an automated journey and native/manual proof; no unexplained missing state.                                                                                                                                                  |
| Consent                  | Zero NSFW or consent-gated external fetch before acknowledgement, including native admission and alternate entry points.                                                                                                                           |
| Authorization            | Member/reporter/subject/moderator/owner cases expose only authorized fields.                                                                                                                                                                       |
| Accessibility            | No release-blocking defect across the defined check groups; owner decision 2026-09-24 dropped the manual native screen-reader (NVDA/Orca) recording requirement in favor of the automated ARIA/keyboard/focus evidence every lane already carries. |
| English readiness        | Every app-authored text sink inventoried; typed parameter/plural/date/number formatting checks pass.                                                                                                                                               |
| Identity and performance | Desktop visual review passes; existing B7 budgets are not weakened.                                                                                                                                                                                |
| Phase closure            | Owner accepts HP-9 and exact-SHA evidence; every exit row passes. As of the cited status, B9-0 through B9-24 were merged; B9-25 through B9-27 (capability honesty, cross-feature journey qualification, HP-9 freeze/exit) remained pending.        |

## Out of scope

Per [beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md)
"Explicitly outside beta":

- Server federation and cross-server identity.
- Native macOS, iOS, or Android applications.
- More than one active server connection per client.
- Anonymous guest access or a public server directory.
- A stable third-party plugin API or bundled third-party plugins.
- An OwnCord-operated hosting, identity, telemetry, push, or moderation
  service.
- Unrelated feature expansion after the scope freeze.
- **The browser, PWA, phone, and tablet client (B8) — deferred to
  post-beta** _(added 2026-09-18, owner decision)_. Beta is desktop-only;
  BPR-020 through BPR-025 (browser hosting switch, desktop-parity target,
  phone/tablet support, PWA installability, background Web Push, and the
  shared desktop/browser contract) are each amended in place to move with
  B8. Re-entry conditions are recorded against the roadmap's B8 section.

Additional out-of-scope items named by individual phase PRDs:

- **B6:** the signed browser client bundle itself (only the disabled-by-default
  hosting switch and its origin/path contract ship); any client-side
  experience; reverse-proxy-specific tuning beyond documenting honest
  limits; new performance targets beyond closing the existing BPR-030
  promise; redesigning the retained audit-token erasure model
  ([b6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Scope").
- **B7:** browser adapters, `build:web`, and PWA/mobile surfaces (moved to
  B8); the CSS source split and later feature UX (Message Requests,
  moderation UX, translation-ready strings, phone/tablet layouts — moved to
  B9); the render-gate/consent UI for external content (B9); server work
  beyond two small `server-info` additions
  ([b7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Scope").
- **B9:** browser adapters, PWA hosting/push, phone/tablet layouts, touch
  qualification, new content providers, a second shipping language,
  centralized moderation, unrelated server policy, a dependency major
  version bump, a release-pipeline redesign, or a visual rebrand; no
  operational TLS/backup/update powers added to moderation roles
  ([b9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Explicitly out of scope").

## Sources

- [docs/plans/beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md)
- [README.md](README.md)
- [docs/plans/b6-server-deployment-operations-capacity.prd.md](docs/plans/b6-server-deployment-operations-capacity.prd.md)
- [docs/plans/b7-shared-client-platform-desktop-parity.prd.md](docs/plans/b7-shared-client-platform-desktop-parity.prd.md)
- [docs/plans/b9-unified-experience-accessibility-polish.prd.md](docs/plans/b9-unified-experience-accessibility-polish.prd.md)
- [docs/capacity.md](docs/capacity.md)
- [docs/architecture/ux/README.md](docs/architecture/ux/README.md)
- [docs/architecture/ux/connection-and-auth.md](docs/architecture/ux/connection-and-auth.md)
- [docs/architecture/ux/messaging.md](docs/architecture/ux/messaging.md)
- [docs/architecture/ux/channels-members-dms.md](docs/architecture/ux/channels-members-dms.md)
- [docs/architecture/ux/voice-and-e2ee.md](docs/architecture/ux/voice-and-e2ee.md)
- [docs/architecture/ux/settings-and-admin.md](docs/architecture/ux/settings-and-admin.md)
