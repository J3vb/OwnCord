# Product requirements

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the code wins, then the source documents.

What OwnCord is, who it is for, and what the public beta must do. Requirement IDs (`BPR-###`) are defined in [docs/plans/beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md). The phase plans (B6, B7, B9, …) and their current status are indexed in [docs/plans/README.md](docs/plans/README.md), which is the authority on status; this file deliberately carries none.

## Product overview

**Name:** OwnCord.

**One-line description:** A self-hosted chat platform (real-time text channels, direct messages, voice/video and file sharing) that its owner runs on a machine they control, a spare box or a VPS, with no OwnCord-operated service of any kind (BPR-012).

**Vision:** "A self-hosted chat app I build for me and my friends — text channels, voice and video, and a server you actually own." ([README.md](README.md)) It is currently an alpha, hobby-scale project: most of the implementation is AI-generated, quality is held up by CI, tests, linting and real use by the author and friends, and behaviour can change quickly between releases. The direction beyond alpha is the beta: a public GitHub release anyone can download (BPR-001), governed by the requirements below.

## Problem

Group chat with voice and video usually means accounts on a service someone else runs. OwnCord is for a group that wants a server it actually owns: run the server, hand your friends an invite code, and that is the whole thing ([README.md](README.md)). There is no central identity, directory or relay (BPR-012, BPR-040, BPR-083).

For the beta, the problem is proving that holds for strangers: that someone with no access to the codebase or its authors can deploy, upgrade, recover and operate a server unaided on every supported mode, and that the desktop client is one contract-bound application whose update, profile, session and recovery flows are proven end to end ([B6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md), [B7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md)). Feature-complete server behaviour is not the same thing as a server a stranger can host, and a working client is not the same thing as a client whose failure paths are proven. Shipping without that proof means a beta that works on the maintainer's machine and fails, silently or confusingly, on everyone else's.

## Goal

Ship a public beta that a self-hosting owner with ordinary sysadmin skill can deploy, operate and trust unaided, and that a desktop user can use for daily chat, voice/video, moderation and account lifecycle without being routed through any OwnCord-operated service. Beta scope is frozen to the beta requirements document (BPR-003): new ideas go to a post-beta backlog unless required for security, correctness, accessibility, platform parity, or finishing an already-approved feature. There is no calendar deadline; a phase closes only when its evidence and exit gates are green (BPR-002).

## Target users

- **Self-hosting server owner:** ordinary sysadmin skill, no access to the codebase or its authors; stands up a server on a domain, a public IP, a home LAN, or fully offline ([B6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Users").
- **Release engineer:** produces signed, traceable release artifacts for every supported architecture (same source).
- **Desktop member** of a self-hosted server: reads and sends messages, joins voice/video, manages their own account and devices ([B7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) and [B9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Users").
- **First-contact recipients, reporters and moderated members:** the Message Requests, reporting and appeals flows exist for them (B9 PRD "Users").
- **Narrowly authorized local moderators and the server owner:** day-to-day moderation and owner-only operational controls such as TLS, backups and updates (BPR-072, B9 PRD).
- **Client contributor:** moves existing client behaviour behind typed platform contracts without regressing it (B7 PRD "Users").
- **Not targeted in beta:** anonymous guests, a public server directory, more than one active server connection per client, browser/PWA/phone/tablet users (see [Out of scope](#out-of-scope)), and anyone expecting an OwnCord-operated hosted service (BPR-012, BPR-034, BPR-042, BPR-083).

## Core features

From [README.md](README.md) "What OwnCord Already Has" and the beta requirements:

- Real-time channels and direct messages over WebSocket.
- Voice/video channels via LiveKit; the LiveKit server binary is downloaded and managed for the owner automatically.
- Invite-only registration by default, with owner-configurable approval-based or open registration (BPR-041), and role-based permissions.
- A web admin panel with logs, backups and update tooling.
- File uploads and inline media, with link previews, GIF search and YouTube/media embeds (BPR-061). Previews and images are fetched from the viewer's machine through the bounded desktop content broker; GIF search goes through the server's Klipy proxy, and server-side fetches use `Server/safefetch` (BPR-062). Nothing external loads before a per-server consent choice. YouTube playback is a separate click into a fixed-host sandboxed iframe, which the broker's limits do not cover.
- TOTP two-factor authentication, emergency recovery codes, and a locally generated account-recovery kit; registration and recovery work without SMTP or any central service (BPR-043, BPR-044, BPR-046).
- API rate limiting, and desktop client auto-update with signature verification.
- Multi-device sessions: every device stays signed in, with a device list, a new-login notice, individual revocation and sign-out-everywhere. The server holds one live socket per account: the last device to connect wins, and the displaced one shows "Signed in elsewhere" with "Use here" (BPR-035).
- A Message Requests inbox for first-time DMs, with preview, accept, ignore, delete and block (BPR-060).
- Owner-designated NSFW channels with explicit labels and per-user, server-backed consent before any preview loads (BPR-063).
- Local moderation: user reports; a permission-gated Moderation Center (queue, evidence, assignment, notes, actions, immutable audit history); warning, timeout, removal, kick and ban; and rate-limited in-app appeals (three per day, one per action; kicks are not appealable, and a user who is still banned can appeal only out of band) (BPR-070–073).
- A WASM plugin system for slash commands: experimental, sandboxed and disabled by default (`plugins.enabled`, build tag `wazero`), with no beta plugin-API compatibility promise (BPR-080).
- A GIF picker, off by default, using a server-supplied Klipy key.
- No automatic product or usage telemetry; diagnostics stay local, and support-bundle export is user-initiated (BPR-055).

## User flows

The behavioural specs (states, transitions, event → reaction maps) live in [docs/architecture/ux/](docs/architecture/ux/README.md); this section summarizes the flows it defines as the client's target behaviour.

**Connection & auth** ([connection-and-auth.md](docs/architecture/ux/connection-and-auth.md)): the app is a two-page state machine (`connect | main`). On the connect page a user picks a saved server profile (health-checked every 15 s) and signs in through an explicit form state machine (`idle | loading | totp | connecting | error | auto-connecting`; `auto-connecting` is saved-profile auto-login, and any key or click cancels it to `idle`), with client-side validation before any request. Depending on the server's registration mode (`invite | open | approval | closed`), a new user registers by invite or waits for approval. A protocol-epoch mismatch badges the server row advisorily; the WebSocket refusal is the authority and raises an exitable incompatible-version notice naming which side updates. Login proceeds to a WebSocket handshake, and the client never navigates to the main view until the server's `ready` event arrives, so the UI never renders against empty stores. Reconnection uses exponential backoff and replays missed events by `last_seq`, with a persistent banner and disabled live controls while reconnecting. Every server certificate, self-signed or public-CA, is trust-on-first-use (the desktop pins the fingerprint instead of checking the CA list): the client refuses to send credentials to an unconfirmed host until the user accepts it, and a later fingerprint mismatch blocks reconnection behind another explicit accept/reject prompt.

**Messaging** ([messaging.md](docs/architecture/ux/messaging.md)): sending is optimistic. A message appears locally as "pending" and reconciles against the server's echo, rolling back visibly with a retry on failure, never silently. The composer gates on connection status and effective permissions (e.g. announcement-channel read-only, slow-mode cooldowns) by disabling with a stated reason rather than accepting a click that will be rejected. The spec also covers edit/delete, reactions, attachments, replies, pins, search, read/unread tracking, message jumping, mentions and Markdown rendering.

**Channels, members & DMs** ([channels-members-dms.md](docs/architecture/ux/channels-members-dms.md)): the channel sidebar reflects live create/update/delete events and redirects the user if their active channel is removed; the member list shows live presence, typing, and role/permission-driven affordances; direct messages can be opened, closed and blocked.

**Voice & E2EE** ([voice-and-e2ee.md](docs/architecture/ux/voice-and-e2ee.md)): joining and leaving a voice channel, mute/deafen/camera/screenshare, push-to-talk and the active-speaker roster are driven by two coordinated state machines (OwnCord's control plane and LiveKit's media session). Voice, video and screen share are end-to-end encrypted between participants (BPR-050). The voice widget shows Connecting… / Securing… / Secured, the voice roster shows a per-peer identity badge (verified / unverified / mismatch), and a mismatch opens a blocking re-pin modal. Token refresh and reconnect are designed to be invisible to the user.

**Settings & admin** ([settings-and-admin.md](docs/architecture/ux/settings-and-admin.md)): a settings overlay (Account, Safety, Appearance, Notifications, Text & Images, Accessibility, Voice & Audio, Keybinds, Advanced, Logs) covers account operations (password, TOTP, recovery kit, sessions, deletion disclosure), a local support-bundle export in the Logs tab, appearance and theming, the client's inline admin surface (ban/kick/roles, channel CRUD, invites) for permitted users, the desktop auto-updater, and system-tray behaviour.

**Beta additions (B9).** These flows are specified in the B9 PRD's owner decisions Q2–Q4 and Q10 and in [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md); `docs/architecture/ux/` predates them.

- **Message Requests:** a "Message Requests (N)" section at the top of DM mode. Request messages never add to unread or mention counts and never notify before acceptance.
- **External-content consent:** one choice per server profile ("Load automatically on this server" or "Ask each time"), revocable in Text & Images. NSFW channels keep their own server-backed acknowledgement.
- **Warnings and timeouts:** an unacknowledged warning is a persistent top-of-app banner with one "Acknowledge" button. A timeout shows inline, on the disabled composer, reactions and voice join, with the server's expiry.
- **Moderation:** a "Moderation" view beside "Audit Log" in the server header, shown only with `MODERATE_MEMBERS`. Timeouts take one validated duration input (1 minute to 28 days).
- **Safety tab:** personal notices, restrictions, the user's own reports and appeals live in a Settings "Safety" tab.

## Requirements

### Functional

Selected BPR IDs; the full text is in [beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md).

| Area               | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release            | BPR-001 public GitHub release; BPR-002 no deadline, evidence-gated; BPR-003 scope frozen to the beta requirements doc; BPR-004 alpha data and config survive an in-place upgrade; BPR-005 deterministic-where-possible builds with signed provenance and SBOM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Platforms          | BPR-010 desktop: Windows x64/ARM64, Linux x64/ARM64; BPR-011 server: Windows/Linux x64/ARM64 binaries plus multi-arch Docker images.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Identity           | BPR-040 accounts are per-server, no global identity; BPR-041 invite-only by default; BPR-042 all features require an authenticated account; BPR-043 email optional; BPR-044/046 local recovery kit, TOTP and emergency codes, with security questions prohibited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Privacy            | BPR-050 hybrid trust model: the server sees text and files, while voice, video and screen share are E2EE. E2EE hides media from an operator who reads the server, not from one who modifies it (the server controls call membership, and a new participant's key is accepted on first sight); authenticated membership is not in beta. BPR-051 server-operator trust disclosed plainly. BPR-052 account deletion erases authored data. BPR-053 audit/moderation rows about an erased account keep one stable HMAC-SHA256 token per subject (`data/erasure.key`): linkable to each other, and to the identity only by whoever holds the key; the `erasure_jobs` row keeps the bare user id, and free text the account wrote while moderating is unlinked but not cleared (amended 2026-09-18). BPR-054 indefinite retention by default, owner-configurable. BPR-055 no automatic telemetry. |
| Messaging & safety | BPR-060 Message Requests inbox; BPR-061/062 bounded, SSRF-resistant external content; BPR-063 NSFW channels need an explicit label plus per-user consent; BPR-064 English-only for beta, with a translation-ready text architecture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Moderation         | BPR-070 local reporting, no central service; BPR-071 permission-gated Moderation Center; BPR-072 warn/timeout/remove/kick/ban by role; BPR-073 rate-limited appeals with audited decisions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Client experience  | BPR-090 preserve a recognizable visual identity, no rebrand; BPR-091 accessibility is a release property, not a later pass; BPR-092 browser and offline limitations stated honestly (the client-relevant portion; the browser client itself is post-beta).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Capacity           | BPR-030 ≥250 registered users, ≥100 simultaneous connections, ≥25 concurrent voice participants, on published, reproducible hardware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Compatibility      | BPR-031 servers upgrade before clients; BPR-032 epoch-gated protocol compatibility with a coded refusal naming which side to update; BPR-033 a clear update notice and safe incompatible-state handling; BPR-034 one live connection per client, isolated saved profiles; BPR-035 multi-device sessions with revocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### UX

- Every data-bearing view must represent a defined `loading | ready | empty | error | stale | permission-denied | offline` state with a specified presentation: no silent states ([ux/README.md](docs/architecture/ux/README.md) §1).
- One canonical feedback primitive per situation (toast, inline field error, inline section error + retry, persistent banner, blocking modal, two-click confirm, disabled-with-reason), picked by a fixed decision table rather than improvised per call site (§2).
- Connection status (`connected | reconnecting | disconnected`) is a single source of truth that every live-only control reads reactively, not per click (§3).
- Every inbound WebSocket event produces a defined store mutation and, where user-visible, a defined UI reaction (§4); one canonical reaction per failure or permission class, applied uniformly (§5).
- Optimistic locally, authoritative from the server; permission is expressed as a pre-disabled affordance, not a rejection after the fact (§6).
- BPR-090 is now read through B9 decision Q13 (owner, 2026-09-23): the "Refined Neon" visual direction, with design tokens that have a single writer ([DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)).
- BPR-091: desktop accessibility (keyboard, pointer, screen reader, reduced motion, contrast, focus, text scaling, zoom/reflow) is release-blocking. Touch and responsive-device evidence moved to B8 on 2026-09-18. The manual screen-reader recording was dropped on 2026-09-24; automated ARIA name/role and keyboard/focus tests satisfy that clause.

### Performance

Published capacity profile and latency budgets, measured on reproducible reference hardware (2 vCPU / 4 GB RAM / SSD, Linux x64, run inside a constrained cgroup). Current measurements are in [docs/capacity.md](docs/capacity.md).

| Path                                                    | p95 budget | p99 budget                      |
| ------------------------------------------------------- | ---------- | ------------------------------- |
| REST login                                              | < 600 ms   | < 1 s                           |
| WebSocket open → `auth_ok`                              | < 200 ms   | < 500 ms                        |
| Message send → sender acknowledgement                   | < 150 ms   | < 300 ms                        |
| Message send → recipient delivery (all connections)     | < 200 ms   | < 400 ms                        |
| Voice join, OwnCord half (`voice_join` → `voice_token`) | < 250 ms   | < 500 ms                        |
| Graceful drain to exit 0                                | < 20 s     | (smoke-gated, not a percentile) |

Budgets may only be tightened from data, never loosened. The capacity target itself (≥250 registered users, ≥100 simultaneous connections with a 180 s sustain, ≥25 concurrent voice participants) was met on 2026-09-12 and reproduced on a second run (BPR-030). Operational scenarios (reconnect storms, database writer/reader wait, message fan-out to a ceiling, voice control churn, upload/download pressure, TLS overhead, graceful shutdown under load) are measured on the same constrained leg, with each scenario and its commands published before its first qualifying run. They introduce no new latency budget: each either applies a published budget or reports its figure with none attached.

### Platform

- **Desktop only for beta.** Officially supported targets are Windows x64, Windows ARM64, Linux x64 and Linux ARM64 (BPR-010). CI smoke covers install, boot, connect, media and recovery on all four; update and rollback run only at release time, on signed artifacts ([B7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md)).
- **Server matrix:** Windows x64/ARM64 executables, Linux x64/ARM64 archives, and multi-architecture Docker images for `linux/amd64` and `linux/arm64`. Docker is the primary deployment path; standalone binaries remain fully tested release assets (BPR-011).
- Each server is independently owner-hosted; there is no OwnCord-operated community server or identity service (BPR-012). A reverse proxy is supported but never required for direct port-forward operation (BPR-013).
- **TLS:** `tls.mode` offers `self_signed` (the default and only qualified mode), `acme`, `manual` and `off`. Built-in domain ACME is implemented but unqualified, and renewal is the owner's responsibility. There is no public-IP HTTPS and no guided LAN/offline device trust (B6-3–B6-5 were deferred on 2026-09-11 and accepted as a limitation on 2026-09-20). For a public domain, the recommended setup is a reverse proxy terminating TLS, with OwnCord on `tls.mode: "off"` ([B6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md), [docs/deployment.md](docs/deployment.md)).

## Success metrics

Beta readiness is defined by each phase's exit gates and the owner's hold-point sign-offs (HP-6, HP-7, HP-9), not by usage metrics; OwnCord collects no telemetry to measure usage with (BPR-055). The current status of every gate is in [docs/plans/README.md](docs/plans/README.md).

**B6: server deployment, operations, capacity** ([B6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Success Metrics"):

- Capacity: ≥250 registered users, ≥100 simultaneous connections (180 s sustain) and ≥25 concurrent voice participants on published reference hardware, with latency budgets tightened from measured data.
- Artifact matrix: every server artifact installs, migrates, heals, drains, restarts and restores, proven on a release tag.
- TLS mode matrix: not measured; B6-3–B6-5 were deferred, and the owner accepted that on 2026-09-20 as a limitation HP-6 signs around.
- Operator usability: signed by the owner at HP-6.

**B7: shared client platform and desktop parity** ([B7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Success Metrics"):

- 0 native imports outside `platform/desktop` and bootstrap; 0 unapproved oxlint warnings; 0 import cycles, or each one boundary-tested.
- The client statement-coverage floor only ratchets upward (`Client/coverage-floor.json`), and bundle budgets are enforced in CI (`Client/bundle-budgets.json`).
- BPR-033, BPR-034 and BPR-035 each have a passing traceability row.
- Desktop artifact matrix: install, boot, connect, media and recovery pass CI smoke on all four targets; update and rollback pass at release time on signed artifacts.

**B9: unified feature experience, accessibility, polish** ([B9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Success metrics"):

| Outcome                  | Gate                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement completeness | Every planned row has an automated journey and native/manual proof; no unexplained missing state.                                                                                                                                           |
| Consent                  | Zero NSFW or consent-gated external fetch before acknowledgement, including native admission and alternate entry points.                                                                                                                    |
| Authorization            | Member, reporter, subject, moderator and owner cases expose only authorized fields.                                                                                                                                                         |
| Accessibility            | No release-blocking defect across the defined check groups. The owner decision of 2026-09-24 dropped the manual native screen-reader (NVDA/Orca) recording in favour of the automated ARIA, keyboard and focus evidence every lane carries. |
| English readiness        | Every app-authored text sink inventoried; typed parameter, plural, date and number formatting checks pass.                                                                                                                                  |
| Identity and performance | Desktop visual review passes; existing B7 budgets are not weakened.                                                                                                                                                                         |
| Phase closure            | The owner accepts HP-9 and the exact-SHA evidence; every exit row passes.                                                                                                                                                                   |

## Out of scope

From [beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md) "Explicitly outside beta":

- Server federation and cross-server identity.
- Native macOS, iOS or Android applications.
- More than one active server connection per client.
- Anonymous guest access or a public server directory.
- A stable third-party plugin API or bundled third-party plugins.
- An OwnCord-operated hosting, identity, telemetry, push or moderation service.
- Unrelated feature expansion after the scope freeze.
- **The browser, PWA, phone and tablet client (B8), deferred to post-beta** _(added 2026-09-18, owner decision)_. Beta is desktop-only. BPR-020 through BPR-025 are amended so their browser/PWA/phone/tablet client halves move with B8; the disabled-by-default server hosting switch (BPR-020, B6-7) and the server-side push storage and dispatch (BPR-024, B5) stay in place, and B7's platform contracts keep BPR-025's shared-contract rule alive. BPR-015, BPR-016 and BPR-071 carry matching browser amendments. Re-entry conditions are recorded in the roadmap's B8 section.

Named by individual phase PRDs:

- **B6:** the signed browser client bundle itself (only the disabled-by-default hosting switch and its origin/path contract ship); any client-side experience; reverse-proxy-specific tuning beyond documenting honest limits; new performance targets beyond closing the existing BPR-030 promise; redesigning the retained audit-token erasure model ([B6 PRD](docs/plans/b6-server-deployment-operations-capacity.prd.md) "Scope").
- **B7:** browser adapters, `build:web`, and PWA/mobile surfaces (moved to B8); the CSS source split and later feature UX (Message Requests, moderation UX and translation-ready strings moved to B9; phone/tablet layouts are post-beta with B8 under the 2026-09-18 deferral); the render-gate/consent UI for external content (B9); server work beyond two small `server-info` additions ([B7 PRD](docs/plans/b7-shared-client-platform-desktop-parity.prd.md) "Scope").
- **B9:** browser adapters, PWA hosting/push, phone/tablet layouts, touch qualification, new content providers, a second shipping language, centralized moderation, unrelated server policy, a dependency major-version bump, a release-pipeline redesign, or a visual rebrand; no operational TLS/backup/update powers are added to moderation roles ([B9 PRD](docs/plans/b9-unified-experience-accessibility-polish.prd.md) "Explicitly out of scope").

## Sources

- [docs/plans/beta-product-requirements-2026-08-23.md](docs/plans/beta-product-requirements-2026-08-23.md), [docs/plans/README.md](docs/plans/README.md), [README.md](README.md)
- [docs/plans/b6-server-deployment-operations-capacity.prd.md](docs/plans/b6-server-deployment-operations-capacity.prd.md), [docs/plans/b7-shared-client-platform-desktop-parity.prd.md](docs/plans/b7-shared-client-platform-desktop-parity.prd.md), [docs/plans/b9-unified-experience-accessibility-polish.prd.md](docs/plans/b9-unified-experience-accessibility-polish.prd.md)
- [docs/capacity.md](docs/capacity.md), [docs/deployment.md](docs/deployment.md), [docs/trust-model.md](docs/trust-model.md), [docs/architecture/b9-ui-contract.md](docs/architecture/b9-ui-contract.md)
- [docs/architecture/ux/README.md](docs/architecture/ux/README.md), [connection-and-auth.md](docs/architecture/ux/connection-and-auth.md), [messaging.md](docs/architecture/ux/messaging.md), [channels-members-dms.md](docs/architecture/ux/channels-members-dms.md), [voice-and-e2ee.md](docs/architecture/ux/voice-and-e2ee.md), [settings-and-admin.md](docs/architecture/ux/settings-and-admin.md)
- [Client/src/pages/connect-page/LoginForm.ts](Client/src/pages/connect-page/LoginForm.ts), [Client/src/components/SettingsOverlay.ts](Client/src/components/SettingsOverlay.ts), [Client/src-tauri/src/tofu.rs](Client/src-tauri/src/tofu.rs)
