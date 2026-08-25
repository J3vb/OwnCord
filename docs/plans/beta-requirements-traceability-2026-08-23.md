# OwnCord beta requirement traceability

**Prepared:** 2026-08-23  
**Requirements source:**
[beta-product-requirements-2026-08-23.md](beta-product-requirements-2026-08-23.md)  
**Execution source:**
[public-beta roadmap](repo-health-roadmap-2026-08-23.md)  
**Structural input:**
[repository-layout audit](../audit-2026-08-23-repository-layout.md)  
**Current status:** all 57 requirements are mapped; none is release-qualified

## How to use this document

- The primary phase owns the implementation invariant, coordinates any
  downstream consumers, and records the first acceptance evidence.
- A phase range means every earlier exit gate in that range is a prerequisite.
- Some server-owned requirements need later client proof. Those rows name B7,
  B8, or B9 evidence explicitly and remain open until that proof exists.
- B10 repeats every applicable verification against one immutable release
  candidate. Earlier green evidence cannot substitute for release evidence.
- Security-sensitive proof is linked from a private advisory. The public row
  records only the security property, test category, and pass/fail status.
- The canonical product wording remains in the requirements source. Short
  labels here are navigation aids, not replacements.

## Phase ownership

| Phase                                                | Primary requirement IDs                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| B0 — truth and scope                                 | BPR-002, BPR-003                                                                         |
| B1 — repository and contributor foundation           | BPR-100, BPR-101, BPR-102, BPR-103                                                       |
| B2 — server protocol, trust, and compatibility       | BPR-031, BPR-032, BPR-040, BPR-050, BPR-051, BPR-080, BPR-081, BPR-082, BPR-083          |
| B3 — server architecture and guardrails              | No direct product requirement; mandatory prerequisite for B4–B10                         |
| B4 — identity, recovery, privacy, and data lifecycle | BPR-041, BPR-042, BPR-043, BPR-044, BPR-045, BPR-046, BPR-052, BPR-053, BPR-054, BPR-055 |
| B5 — community, content, and moderation services     | BPR-060, BPR-061, BPR-062, BPR-063, BPR-070, BPR-071, BPR-072, BPR-073                   |
| B6 — deployment, operations, and capacity            | BPR-011, BPR-012, BPR-013, BPR-014, BPR-015, BPR-016, BPR-030                            |
| B7 — shared client platform and desktop parity       | BPR-033, BPR-034, BPR-035                                                                |
| B8 — browser, PWA, phone, and tablet                 | BPR-020, BPR-021, BPR-022, BPR-023, BPR-024, BPR-025                                     |
| B9 — unified UX, accessibility, and polish           | BPR-064, BPR-090, BPR-091, BPR-092                                                       |
| B10 — qualification and release                      | BPR-001, BPR-004, BPR-005, BPR-010; final proof for every row                            |

## Release and scope

| ID      | Short label                            | Primary phase | Prerequisites                                                                         | Minimum verification and closure evidence                                                                                                                                                                                                                         |
| ------- | -------------------------------------- | ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-001 | Public GitHub beta                     | B10           | B0–B9; BPR-005 and BPR-010                                                            | Public release points to the qualified tag; an unauthenticated user can download every declared asset; install/cold-boot smoke succeeds; release page, source, checksums, signatures, SBOM, provenance, and support links agree.                                  |
| BPR-002 | No deadline; evidence gates            | B0            | Approved requirements                                                                 | Every phase template omits calendar-based completion, records exact-SHA evidence, and blocks closure when any exit row is red or unavailable. B10 confirms all phase scorecards are green.                                                                        |
| BPR-003 | Frozen beta scope                      | B0            | Approved requirements; canonical issue intake                                         | Issue/Discussion triage maps work to a BPR or post-beta label; phase diffs show no unapproved feature; any exception records why it is required for security, correctness, accessibility, parity, or an approved feature.                                         |
| BPR-004 | In-place alpha-to-beta upgrade         | B10           | B2 protocol; B4 migrations/deletion markers; B6 deployment/backup; B7 client settings | Upgrade representative alpha Docker and standalone datasets to the RC and verify row/file/config/credential/attachment/client-setting checksums and behavior; rehearse interrupted upgrade, restart, backup restore, and declared rollback without loss.          |
| BPR-005 | Deterministic, signed release evidence | B10           | B1 release gates; B6 supply chain; B7/B8 artifacts                                    | Rebuild unsigned payloads twice where the platform permits and compare; repeat packaging; verify timestamped-signature exception; validate checksums, signatures, update metadata, source snapshot, signed SBOM/provenance, cold boot, and exact published bytes. |

## Supported platforms and delivery

| ID      | Short label                             | Primary phase | Prerequisites                                                      | Minimum verification and closure evidence                                                                                                                                                                                                                             |
| ------- | --------------------------------------- | ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-010 | Four desktop targets                    | B10           | B6 server artifacts; B7 desktop; B8/B9 shared-client qualification | Windows x64, native Windows ARM64, Linux x64, and Linux ARM64 packages build and pass install, boot, connect, media, update, rollback, and recovery smoke. Linux ARM64 evidence states whether it is cross-build/emulated or real hardware.                           |
| BPR-011 | Complete server artifact matrix         | B6            | B1 CI/release foundation; B3 lifecycle                             | Windows x64/ARM64 executables, Linux x64/ARM64 archives, and Docker linux/amd64 plus linux/arm64 are published from one commit; every artifact cold-boots, migrates, reports healthy, serves traffic, drains, restarts, and preserves data.                           |
| BPR-012 | Independently owner-hosted              | B6            | B2 central-dependency audit; B4 local identity/recovery            | Fresh deployment, registration, login, messaging, moderation, update verification, recovery, and backup work without an OwnCord account/service; controlled network capture shows no undeclared central dependency.                                                   |
| BPR-013 | No required reverse proxy               | B6            | B2 trust contracts; B6 TLS configuration                           | Domain and public-IP deployments work through documented direct port forwarding with the built-in TLS path; a clean install contains no reverse-proxy prerequisite; blocked-port/CGNAT limits fail actionably.                                                        |
| BPR-014 | Domain and raw public IP                | B6            | BPR-013; certificate-mode design                                   | Automated integration covers DNS name, eligible stable IPv4, and eligible stable IPv6 origins through HTTPS/WSS, reconnect, update, and browser-origin checks; address changes and unsupported cases are explicit.                                                    |
| BPR-015 | Automatic public CA and guided local CA | B6            | B2 trust model; protected persistent configuration                 | ACME staging covers public domain and eligible public IP issue/renew/expiry/hot reload; LAN/offline covers local-CA generation, fingerprint, one-time trust install, rotation, and removal on supported browser devices; owner-supplied certificate mode also passes. |
| BPR-016 | LAN-only and fully offline              | B6            | BPR-015; B4 local recovery; B5 offline service behavior            | After local trust, server and client cold-boot, authenticate, message, call where local media permits, back up, restore, and update from local artifacts with internet blocked; internet-dependent push/provider features report unavailable without retry storms.    |

## Browser and PWA client

| ID      | Short label                              | Primary phase | Prerequisites                                              | Minimum verification and closure evidence                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------- | ------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-020 | Optional server-hosted browser client    | B8            | B6 default-off host/origin contract; B7 web contract build | Clean server exposes no browser application while disabled; owner enablement serves the version-matched signed bundle; disable removes access without affecting API/desktop; upgrade and rollback keep the setting and bundle consistent.                                                    |
| BPR-021 | Browser desktop parity within API limits | B8            | B5 services; B7 shared contracts; BPR-020                  | Requirement-journey comparison passes on desktop and supported browsers; every intentional difference has an API-based rationale and honest UI; installer, updater, tray, and native integrations remain desktop-only.                                                                       |
| BPR-022 | Phone and tablet browser support         | B8            | B7 contracts; responsive navigation design; BPR-021        | Real Android phone/tablet and iPhone/iPad plus automation cover navigation, touch targets, virtual keyboard, safe areas, orientation, zoom/reflow, media constraints, screen reader, and recovery/moderation workflows.                                                                      |
| BPR-023 | Installable PWA                          | B8            | BPR-020; secure origin; cache policy                       | Manifest/icons/standalone launch pass installability checks; service worker is correctly scoped; only approved application assets cache; version change, stale cache, offline fallback, logout, and server rollback do not expose messages, credentials, attachments, or moderator evidence. |
| BPR-024 | Opt-in Web Push without OwnCord relay    | B8            | B5 per-server push backend; B6 HTTPS; BPR-023              | Owner-disabled, user-denied, subscribed, revoked, expired, 404/410 cleanup, VAPID rotation, click routing, offline, iOS installed-PWA, and unsupported cases pass; default payload is generic and network inspection shows no OwnCord relay.                                                 |
| BPR-025 | One shared product and contracts         | B8            | B1 target layout; B7 platform contracts; BPR-021           | Static checks keep native imports inside desktop ownership; the same domain/store/protocol suites run against desktop and browser adapters; no copied feature implementation or independently versioned browser protocol exists.                                                             |

## Capacity and compatibility

| ID      | Short label                            | Primary phase | Prerequisites                                             | Minimum verification and closure evidence                                                                                                                                                                                                                                              |
| ------- | -------------------------------------- | ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-030 | 250/100/25 reference profile           | B6            | B3 benchmarks/simulation; B5 completed services           | Reproducible load run on stated hardware sustains 250 registered users, 100 simultaneous connections, and 25 concurrent voice participants; publish configuration, duration, p50/p95/p99 latency, errors, CPU, memory, disk/database waits, network, reconnect, and recovery behavior. |
| BPR-031 | Server upgrades first                  | B2            | B1 protocol owner and release metadata                    | Update-state tests prove the old server never directs users to an incompatible new client; server upgrade exposes signed compatible-client metadata; operator and client wording describes the sequence.                                                                               |
| BPR-032 | Protocol epochs N/N-1/N-2              | B2            | B1 generated protocol gate; BPR-031                       | Fixtures for epochs N, N-1, and N-2 connect and exercise required journeys; N-3 rejects safely; patch versions within an epoch interoperate; prerelease/release metadata declares epoch; bundled browser version always matches server.                                                |
| BPR-033 | Update notice and safe incompatibility | B7            | BPR-031 and BPR-032; signed update metadata               | Connected clients in-window receive a clear notice and can verify/install the compatible release; incompatible clients show an actionable non-destructive requirement; tampered, missing, offline, rollback, and user-deferral cases pass.                                             |
| BPR-034 | One active server connection           | B7            | BPR-040; isolated profile storage; platform contracts     | Instrumented unit/E2E tests prove only one live server transport/media session exists; switching tears down old resources, isolates credentials/cache/notifications, preserves profiles, and never aggregates background servers.                                                      |
| BPR-035 | Multiple device sessions               | B7            | B4 session inventory/revocation and login events; BPR-034 | Two or more devices remain active for one account; list labels/current-device state are correct; new-login notice appears; individual revoke affects only its target; sign-out-everywhere revokes all tokens and live connections.                                                     |

## Identity, registration, and recovery

| ID      | Short label                                       | Primary phase | Prerequisites                                   | Minimum verification and closure evidence                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------- | ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-040 | Server-local accounts                             | B2            | B1 protocol boundary; no central identity       | The same username can represent unrelated identities on two servers; credentials, sessions, recovery, profiles, and moderation never cross; dependency/network audit finds no global identifier or OwnCord identity lookup.                                            |
| BPR-041 | Invite-only default, optional approval/open       | B4            | B3 configuration/domain boundaries; BPR-040     | Fresh install is invite-only; valid/expired/revoked/concurrent invite tests pass; explicit transitions to approval/open and back are audited; upgrade preserves the owner's chosen mode without silently opening registration.                                         |
| BPR-042 | Authentication required; no guests                | B4            | B2 canonical auth/authz; BPR-041                | Anonymous requests and sockets cannot message, upload, call, report, moderate, or fetch protected data; revoked/expired/partial sessions fail uniformly; UI and public docs expose no guest path.                                                                      |
| BPR-043 | Email optional and no central recovery dependency | B4            | BPR-040; local recovery design                  | Registration, login, recovery, device revocation, and administration pass with SMTP unset and internet blocked; optional email absence never blocks account creation or local recovery.                                                                                |
| BPR-044 | Rotating local recovery kit                       | B4            | B3 secret-storage guardrails; BPR-043           | Kit generation/recovery/replay/concurrency/restart tests prove only protected non-reversible server material is stored; one successful use rotates/invalidates it; logs, audit, backup, and support bundles contain no usable secret.                                  |
| BPR-045 | Admin-assisted short-lived recovery               | B4            | BPR-044; canonical audit/session revocation     | Issuance requires authorized admin and recorded local-verification decision; credential expires, is single-use and rate-limited; success revokes affected sessions; unauthorized, replay, concurrent, restart, and audit-redaction tests pass.                         |
| BPR-046 | TOTP, emergency codes, optional SMTP              | B4            | BPR-043–BPR-045; current MFA migration fixtures | Existing TOTP and emergency recovery codes survive upgrade/restart and pass enrollment, verification, replay, rotation, exhaustion, clock-skew, revocation, and recovery tests; SMTP failure cannot block local paths; configuration/UI contain no security questions. |

## Privacy, deletion, and retention

| ID      | Short label                                        | Primary phase | Prerequisites                                         | Minimum verification and closure evidence                                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------- | ------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-050 | Hybrid privacy and media E2EE                      | B2            | B1 protocol ownership; private threat model           | Storage inspection confirms the trusted server can deliver/search/moderate/backup text and files; authenticated media interoperability and adversarial membership/rekey/removal tests demonstrate participant E2EE for voice, video, and screen share; docs state the boundary accurately.         |
| BPR-051 | Plain server-operator trust disclosure             | B2            | BPR-050; B1 docs source of truth                      | Setup, privacy, backup, moderator, and client disclosures say the machine owner can access stored text/files and distinguish transport/at-rest controls from E2EE; technical review and user comprehension check find no contradictory claim.                                                      |
| BPR-052 | Erase all user-authored data                       | B4            | B3 data ownership inventory; BPR-042; backup fixtures | Deletion traverses profile, credentials, sessions, messages, reactions, uploads, thumbnails/cache, request/report references, and every later data class; pre/post database and storage inventory is empty for the subject; interruption resumes safely; B7/B9 UI confirms impact and completion.  |
| BPR-053 | Unlinkable integrity history and anti-resurrection | B4            | BPR-052; cryptographic mapping and backup design      | After deletion, audit/moderation rows retain only allowed event category, time, action class, and integrity proof; subject/content mapping key is cryptographically erased; correlation attempts fail; restore of an older backup reapplies the durable deletion marker and cannot resurrect data. |
| BPR-054 | Indefinite default and configurable retention      | B4            | B3 scheduler/lifecycle; BPR-052/BPR-053               | Fresh and upgraded servers default to indefinite history; server/channel policies handle precedence, clock boundaries, restart, batches, attachments, cache/search, reports/audit, deletion, and disk pressure; owner UI/docs preview and confirm effects.                                         |
| BPR-055 | No automatic telemetry                             | B4            | B1 dependency inventory; local diagnostics design     | Network capture across install, startup, use, crash, update check, offline, and support workflows shows no automatic product/usage reporting; support bundle requires user action and passes secret/content review; any future crash option defaults off and records consent.                      |

## Messaging, content, and safety

| ID      | Short label                             | Primary phase | Prerequisites                                                     | Minimum verification and closure evidence                                                                                                                                                                                                                                               |
| ------- | --------------------------------------- | ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-060 | Message Requests                        | B5            | B4 identity/block/deletion/retention; B3 state-machine guardrails | Server state/property tests cover pending, safe preview, accept, ignore, delete, block, races, reconnect, multi-device, retention, and deletion; B9 desktop/browser/mobile E2E proves inbox UX and that only acceptance creates server-local trust.                                     |
| BPR-061 | Preserve existing rich content safely   | B5            | BPR-062; current provider/feature inventory                       | Existing link preview, GIF search, YouTube/media embed, and rich-content journeys pass security, privacy, accessibility, offline/failure, and performance budgets on B9 clients; provider expansion is not required and any new provider maps to post-beta unless separately justified. |
| BPR-062 | Bounded privacy-safe external retrieval | B5            | B2 trust model; B3 bounded-work guardrails                        | Private adversarial suite covers DNS rebinding/resolution, IPv4/IPv6/private addresses, redirect chains, type sniffing, compressed/streamed size, timeout, concurrency, cache partition/expiry, residual buffering, cancellation, and offline behavior for every fetch path.            |
| BPR-063 | NSFW consent before load                | B5            | BPR-062; per-user preference/authz storage                        | Server and B9 client tests prove explicit owner label plus per-user acknowledgement; previews stay concealed; network inspection confirms content and third-party media are not requested before consent; revoke, new device, logout, accessibility, and moderator cases pass.          |
| BPR-064 | English-only, translation-ready         | B9            | B7/B8 shared UI; frozen beta strings                              | All user-facing strings are inventoried behind translation-ready boundaries with no required second language; dynamic/plural/error/accessibility strings are covered; static scan finds unjustified hard-coded UI text; layout tolerates representative expansion.                      |

## Moderation

| ID      | Short label                        | Primary phase | Prerequisites                                  | Minimum verification and closure evidence                                                                                                                                                                                                                    |
| ------- | ---------------------------------- | ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BPR-070 | Local reports only                 | B5            | B4 identity/deletion/retention; B2 permissions | Authenticated users can report message/user/attachment to their own server; cross-server/central delivery is impossible; duplicate/rate-limit/block/deleted-target/access-control tests pass; B9 clients expose the flows without leaking reporter/evidence. |
| BPR-071 | Permission-gated Moderation Center | B5            | BPR-070; B2 audit/authz; B7/B8 clients         | Service tests cover queue, evidence/context, assignment, status, notes, action links, immutable history, retention, and deletion unlinking; B9 desktop/browser/PWA E2E proves permitted roles see correct data and all others see none.                      |
| BPR-072 | Narrow moderator actions           | B5            | BPR-071; canonical effective permissions       | Role matrix and adversarial tests cover warning, timeout, removal, kick, ban, hierarchy, self/peer/owner targets, concurrent changes, voice/text effects, and audit; B9 UI hides/blocks unauthorized actions; TLS/backup/update remain owner-only.           |
| BPR-073 | Rate-limited local appeals         | B5            | BPR-071/BPR-072; B4 rate limits/notifications  | State/property tests cover submission, rate limit, assignment, status, decision, notification, repeat/closed/blocked users, deletion, retention, and audit; B9 clients show only authorized appeal content and accurate status.                              |

## Extensions and deferred systems

| ID      | Short label                           | Primary phase | Prerequisites                               | Minimum verification and closure evidence                                                                                                                                                                                                      |
| ------- | ------------------------------------- | ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-080 | Experimental WASM disabled by default | B2            | B1 artifact provenance; configuration audit | Fresh, upgraded, Docker, and standalone configurations leave WASM disabled; release/docs/UI mark it experimental with no compatibility promise; example WASM is reproducible or provenance-verified; enabling requires explicit owner action.  |
| BPR-081 | Identify future plugin candidates     | B2            | B0 audit; B3 boundary inventory             | Architecture note lists cohesive candidates and why they are separable, while explicitly keeping auth/authz, TLS, safe fetch, quota, E2EE, updater, deletion, recovery, and moderation audit in core; no beta feature is moved to WASM.        |
| BPR-082 | No federation in beta                 | B2            | B0 scope freeze; BPR-040                    | Protocol/API/config/release review finds no federation, cross-server identity, or cross-server messaging feature; plans/issues route the idea post-beta; generic work is accepted only when justified by a current non-federation requirement. |
| BPR-083 | No centralized public directory       | B2            | BPR-012 and BPR-040                         | Server/client/config/network review finds no automatic listing, discovery submission, central browse/search, or OwnCord directory dependency; owner-shared addresses and invite links pass connect/onboarding tests.                           |

## Client experience and accessibility

| ID      | Short label                          | Primary phase | Prerequisites                                            | Minimum verification and closure evidence                                                                                                                                                                                                                                |
| ------- | ------------------------------------ | ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BPR-090 | Preserve and polish OwnCord identity | B9            | B7 desktop baseline; B8 responsive client; design tokens | Visual regression and owner review show recognizable navigation/identity and familiar workflows across targets; consistency, responsiveness, accessibility, startup, interaction, and bundle budgets improve or meet accepted baselines; no wholesale rebrand.           |
| BPR-091 | Accessibility is release-blocking    | B9            | B7 semantic foundations; B8 mobile/browser behavior      | Automated accessibility plus manual keyboard, pointer, touch, screen reader, reduced-motion, contrast, focus, zoom/reflow, virtual-keyboard, safe-area, error/announcement, and media-control checks pass every critical journey on supported targets.                   |
| BPR-092 | Honest browser/offline limitations   | B9            | B6 deployment modes; B8 capability detection             | Browser/device/network matrix verifies unavailable media, push, screen capture, updater, native integration, certificate, and offline behavior is disabled or explained actionably; no control falsely reports success; recovery after capability/network return passes. |

## Community and governance

| ID      | Short label                                 | Primary phase | Prerequisites                                            | Minimum verification and closure evidence                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------- | ------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-100 | Issues for bugs; Discussions for community  | B1            | B0 scope/intake model                                    | Repository navigation, issue forms, blank-issue policy, Discussions links, support links, and contribution docs route bugs to Issues and support/ideas/feedback to Discussions; dry-run submissions reach the intended destination.                                              |
| BPR-101 | Private coordinated vulnerability reporting | B1            | B0 private/public handling; repository security settings | Security policy and forms point to private GitHub reporting; public templates warn against disclosure; permissions and a tabletop report prove private receipt, triage, advisory, fix, coordinated disclosure, and safe public status.                                           |
| BPR-102 | Community pull requests supported           | B1            | B0 gates; root command facade                            | A fresh Windows and Linux contributor follows docs to bootstrap, run scoped/full checks, understand scope/generated files/review/security rules, and submit a passing sample change; CI feedback matches local commands.                                                         |
| BPR-103 | Evidence-based isolated restructure         | B1            | Layout audit; green B0 baseline                          | Targeted migration uses adjacent pure-move and mechanical-path-rewrite commits, preserves release names/desktop behavior/history, proves all active references and generated ownership, and passes the complete exact-SHA matrix; no wholesale repository/server rewrite occurs. |

## Cross-cutting qualification rule

A row may be marked:

- planned: prerequisites or implementation have not started;
- in progress: the primary phase owns active work;
- implemented, awaiting downstream proof: the server/core invariant is green
  but a named client or deployment journey is not;
- phase-verified: all evidence named in the row is green on that phase commit;
- release-qualified: B10 repeated the evidence on the immutable release
  candidate.

Only release-qualified satisfies beta. No row is release-qualified at the
audited head; implementation maturity ranges from an existing partial
foundation to entirely absent and must be refreshed during B0.

## Completeness check

The map contains exactly the approved IDs:

- BPR-001 through BPR-005;
- BPR-010 through BPR-016;
- BPR-020 through BPR-025;
- BPR-030 through BPR-035;
- BPR-040 through BPR-046;
- BPR-050 through BPR-055;
- BPR-060 through BPR-064;
- BPR-070 through BPR-073;
- BPR-080 through BPR-083;
- BPR-090 through BPR-092;
- BPR-100 through BPR-103.

Gaps in the numeric sequence are intentional category spacing, not missing
requirements.
