# OwnCord beta product requirements

**Approved:** 2026-08-23  
**Release target:** first public beta after the `1.2.0-alpha.*` line  
**Planning model:** quality-gated, with no calendar deadline  
**Owner authority:** product decisions below are fixed; engineering may choose
the safest and most performant implementation that satisfies them.

This document records the decisions that define “beta-ready.” It is the product
input to the repository-health issue register and phased roadmap; it is not an
implementation checklist by itself.

Companion documents:

- [repository-health issue register](repo-health-issue-register-2026-08-23.md);
- [server-first beta roadmap](repo-health-roadmap-2026-08-23.md);
- [repository-layout audit](../audit-2026-08-23-repository-layout.md).

## Release and scope

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-001 | Beta is a public GitHub release that anyone can download.                                                                                                                                                                                                                                                                                                        |
| BPR-002 | There is no deadline. A phase closes only when its evidence and exit gates are green.                                                                                                                                                                                                                                                                            |
| BPR-003 | Beta scope is frozen to this document. New ideas go to the post-beta backlog unless needed for security, correctness, accessibility, platform parity, or completion of an approved feature.                                                                                                                                                                      |
| BPR-004 | Existing alpha server data, attachments, configuration, credentials, and client settings must survive an in-place beta upgrade.                                                                                                                                                                                                                                  |
| BPR-005 | Unsigned payloads are deterministic where the platform permits, packaging is repeatable, and releases carry signed provenance/SBOM evidence. Checksums, signatures, update metadata, source snapshots, and the final published artifacts are verified before publication; timestamped platform signatures are not required to be byte-identical across rebuilds. |

## Supported platforms and delivery

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BPR-010 | Official desktop targets are Windows x64, Windows ARM64, Linux x64, and Linux ARM64. Native Windows ARM64 validation is available; Linux ARM64 may use cross-build and emulated smoke evidence until real hardware is available.                                                                                                                                               |
| BPR-011 | The supported server matrix is Windows x64/ARM64 executables, Linux x64/ARM64 archives, and multi-architecture Docker images for `linux/amd64` and `linux/arm64`. Docker is the primary deployment path; standalone binaries remain fully tested release assets.                                                                                                               |
| BPR-012 | Each server is independently hosted by its owner. The project operates no official OwnCord community server or identity service.                                                                                                                                                                                                                                               |
| BPR-013 | Internet-facing servers commonly run directly behind port forwarding. A reverse proxy must not be required.                                                                                                                                                                                                                                                                    |
| BPR-014 | Domain names and raw public IP addresses are supported connection addresses.                                                                                                                                                                                                                                                                                                   |
| BPR-015 | Public domains and stable public IPs use a built-in automatic public-CA certificate lifecycle. Private LAN/offline deployments use a server-generated local CA with guided, unavoidable one-time trust installation on each browser device. Owners may instead supply a certificate explicitly; no reverse proxy or recurring manual renewal is required by the default paths. |
| BPR-016 | Private LAN-only and fully offline deployments are first-class supported modes. Offline browser use works after local certificate trust, while internet-dependent capabilities such as closed-app Web Push clearly report that they are unavailable.                                                                                                                           |

## Browser and PWA client

| ID      | Requirement                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-020 | A server may host the browser client only when its owner explicitly enables it; it is disabled by default.                                                                                                              |
| BPR-021 | The browser client targets desktop parity wherever browser APIs permit. Installer, desktop updater, system tray, and native OS integrations are desktop-only.                                                           |
| BPR-022 | Phones and tablets are official browser targets. Layout, touch input, virtual keyboards, safe areas, media constraints, and accessibility must be tested.                                                               |
| BPR-023 | The browser client is installable as a Progressive Web App with icons, standalone presentation, and safely cached application assets.                                                                                   |
| BPR-024 | Background Web Push is supported where the browser and operating system permit it. It requires explicit owner and user opt-in, uses no OwnCord-operated relay, and degrades honestly on offline or unsupported systems. |
| BPR-025 | The desktop and browser clients share product behavior and contracts rather than becoming divergent applications.                                                                                                       |

## Capacity and compatibility

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-030 | The beta reference profile supports at least 250 registered users, 100 simultaneous connections, and 25 concurrent voice participants per server, backed by published measurements on stated hardware.                                                                                                                                                                                                            |
| BPR-031 | A server owner upgrades the server before users install the corresponding client update.                                                                                                                                                                                                                                                                                                                          |
| BPR-032 | An upgraded server supports the current advertised protocol epoch and the previous two epochs (`N/N-1/N-2`). Patch releases that retain an epoch remain compatible; prerelease and release metadata declare their epoch explicitly. The server-bundled browser client matches its server and is not an independently versioned compatibility generation. A new client is not required to support an older server. |
| BPR-033 | Connected users receive a clear update notification and can install the compatible client release. Clients outside the compatibility window fail safely with an actionable update requirement.                                                                                                                                                                                                                    |
| BPR-034 | One client connects to one server at a time. Saved profiles remain isolated and easy to switch; background multi-server aggregation is outside beta.                                                                                                                                                                                                                                                              |
| BPR-035 | One server-local account may have multiple simultaneous device sessions, with a device/session list, new-login notice, individual revocation, and sign-out-everywhere.                                                                                                                                                                                                                                            |

## Identity, registration, and recovery

| ID      | Requirement                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-040 | Accounts and usernames are local to each server. There is no global OwnCord identity.                                                                                                                                                                                               |
| BPR-041 | New servers default to invite-only registration. Owners may explicitly enable approval-based or open registration.                                                                                                                                                                  |
| BPR-042 | All messages, files, calls, and moderation features require an authenticated account. Anonymous guest access is outside beta.                                                                                                                                                       |
| BPR-043 | Email is optional. Registration and recovery work without SMTP or any central service.                                                                                                                                                                                              |
| BPR-044 | Account recovery uses a locally generated recovery kit whose server-side secrets are stored only in protected, non-reversible form and rotate after use.                                                                                                                            |
| BPR-045 | Administrators may issue short-lived recovery credentials after local identity verification. Recovery revokes affected sessions and creates a safe audit record.                                                                                                                    |
| BPR-046 | Existing TOTP multi-factor authentication and emergency recovery codes remain supported beta features. Optional SMTP recovery may be enabled, but SMTP and all external services remain nonessential to registration, login, and local recovery. Security questions are prohibited. |

## Privacy, deletion, and retention

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BPR-050 | OwnCord follows Discord's hybrid privacy model: text and files are available to the trusted server for delivery, search, moderation, and backup; voice, video, and screen sharing are end-to-end encrypted between participants.                                                                                                                                   |
| BPR-051 | The server-operator trust model is disclosed plainly. Transport and at-rest controls do not claim to hide stored text or files from the machine owner.                                                                                                                                                                                                             |
| BPR-052 | Account deletion erases the user's profile, credentials, sessions, messages, reactions, uploads, and other authored data rather than leaving attributed or anonymized content behind.                                                                                                                                                                              |
| BPR-053 | Necessary integrity records retain no identifying or content data after deletion. Immutable moderation/audit history survives only as an unlinkable event category, time, action class, and integrity proof after the subject mapping is cryptographically erased. Durable deletion markers prevent a later backup restore from silently resurrecting erased data. |
| BPR-054 | Message history is retained indefinitely by default. Owners may configure automatic retention at server or channel scope, with corresponding attachment cleanup.                                                                                                                                                                                                   |
| BPR-055 | OwnCord sends no automatic product or usage telemetry. Diagnostics remain local and support-bundle export is user initiated. Any future crash reporting is explicit opt-in.                                                                                                                                                                                        |

## Messaging, content, and safety

| ID      | Requirement                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-060 | First-time direct messages enter a Message Requests inbox. A recipient may safely preview, accept, ignore, delete, or block; acceptance establishes a server-local trusted-sender relationship.                                                                                     |
| BPR-061 | Link previews, GIF search, YouTube/media embeds, and existing rich external content remain supported and must meet the beta security, privacy, accessibility, failure-state, and performance gates. Provider expansion beyond the existing set is optional and otherwise post-beta. |
| BPR-062 | Automatic external retrieval uses privacy-preserving, resource-bounded, SSRF-resistant boundaries with strict redirect, address, type, size, time, concurrency, cache, and offline behavior.                                                                                        |
| BPR-063 | Owner-designated NSFW channels remain supported. They require explicit labels and per-user acknowledgement, with concealed previews and no automatic third-party media loading before consent.                                                                                      |
| BPR-064 | English is the only officially supported beta language. User-facing text is organized so community translations can be added later without a rewrite.                                                                                                                               |

## Moderation

| ID      | Requirement                                                                                                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-070 | Users can report messages, users, and attachments to that server's local moderators. There is no central OwnCord moderation service.                                                                             |
| BPR-071 | Desktop, browser, and PWA clients contain a permission-gated Moderation Center for the report queue, evidence and surrounding context, assignment, status, internal notes, actions, and immutable audit history. |
| BPR-072 | Day-to-day moderator actions include warning, timeout, content removal, kick, and ban according to narrowly assigned role permissions. Operational TLS, backup, and update controls remain owner-only.           |
| BPR-073 | Moderated users can submit a rate-limited in-app appeal to local moderators and receive status updates. Appeal decisions are audited.                                                                            |

## Extensions and deferred systems

| ID      | Requirement                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-080 | The WASM plugin runtime remains experimental and disabled by default. No beta plugin API compatibility promise is made because no supported plugins exist yet.                               |
| BPR-081 | The audit identifies cohesive features and provider integrations that could become plugins later, without moving them behind the experimental runtime during beta.                           |
| BPR-082 | Server federation, cross-server messaging, and federation-specific architecture work are outside beta. The idea may be reconsidered only after the beta codebase and operations are healthy. |
| BPR-083 | There is no centralized public server directory. Owners distribute addresses and invite links themselves.                                                                                    |

## Client experience and accessibility

| ID      | Requirement                                                                                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-090 | Preserve OwnCord's recognizable visual identity and familiar workflows while improving consistency, responsiveness, accessibility, and performance. A wholesale visual rebrand is outside beta. |
| BPR-091 | Accessibility is a release property across keyboard, pointer, touch, screen reader, reduced-motion, contrast, focus, zoom, and responsive layouts—not a later cosmetic pass.                    |
| BPR-092 | Browser limitations and offline states are explicit. The UI does not present unavailable media, push, update, or network behavior as functional.                                                |

## Community and governance

| ID      | Requirement                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BPR-100 | GitHub Issues is the official bug tracker; GitHub Discussions hosts support, ideas, and community feedback.                                                                                                |
| BPR-101 | Vulnerabilities use private GitHub security reporting and are not disclosed through public issues before coordinated remediation.                                                                          |
| BPR-102 | Community pull requests are welcome. Contributor documentation defines setup, scope, quality gates, generated files, review expectations, and safe security reporting.                                     |
| BPR-103 | Repository layout and contributor experience are audited before implementation. A restructure occurs only when evidence shows a durable improvement and is performed as an isolated, migration-safe phase. |

## Engineering-controlled choices

Within these product boundaries, implementation details such as cryptographic
libraries, data structures, cache policy, browser/version matrix, performance
budgets, backup schedule, CI topology, branch automation, module boundaries,
and release mechanics are chosen for security, maintainability, and measured
performance. Material tradeoffs and accepted risks must still be recorded.

## Explicitly outside beta

- server federation and cross-server identity;
- native macOS, iOS, or Android applications;
- more than one active server connection per client;
- anonymous guest access or a public server directory;
- a stable third-party plugin API or bundled third-party plugins;
- an OwnCord-operated hosting, identity, telemetry, push, or moderation service;
- unrelated feature expansion after this scope freeze.
