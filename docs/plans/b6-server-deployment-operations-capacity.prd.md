# B6 — Server deployment, operations, and capacity

> **Format trial.** This is the first OwnCord phase written in ECC's PRD
> template (`/plan-prd`) instead of the long-form `bX-*.md` style used for
> B0–B5. Source of truth is still
> ["B6 — Qualify server deployment, operations, and capacity"](repo-health-roadmap-2026-08-23.md);
> [README.md](README.md) remains the status authority. Kept in `docs/plans/`
> rather than ECC's default `.claude/prds/` because `.gitignore:9` (`.claude/*`)
> would leave it untracked.
> **Drafted:** 2026-09-08. **Base commit:** `c9009536` (`dev`).

## Problem

An owner can run OwnCord today, but nobody has proven they can _deploy,
upgrade, recover, and operate_ it on every supported mode without help from an
OwnCord-operated service — which does not and will not exist (BPR-012). Server
behaviour is feature-complete through B5, yet the release artifacts, TLS modes,
capacity numbers, failure drills, and supply-chain evidence that turn that
behaviour into something a stranger can host are unqualified. Leaving it
unsolved means the public beta ships a server that works on the maintainer's
machine and fails, silently or confusingly, on everyone else's.

## Evidence

- BPR-030 promises "at least 250 registered users, 100 simultaneous
  connections, and 25 concurrent voice participants per server, backed by
  published measurements on stated hardware." No such measurement exists.
- Three audit carryovers dated 2026-09-06 name concrete gaps: B3-7 (upgrade
  rehearsal used attachment-row counts, not real attachment bytes), B3
  performance evidence (sender acknowledgement latency was measured, not
  recipient delivery), and B4-9 (physical-erasure boundary asserted from
  logical row absence, not byte-level evidence).
- Roadmap workstream 14 records a named gap: k6 cannot drive voice, so the
  25-participant LiveKit load harness does not exist.
- Roadmap workstream 13 listed four defects as must-close before any ARM64
  asset ships. **All four are already `fixed` in
  `.superpowers/findings-ledger.json`** (OC-0320 architecture-blind
  self-update, OC-0332 bare-IPv6 updater URL, OC-0344 hardcoded port 443
  redirect, OC-0339 empty-config-section warning). That workstream is stale and
  is recorded below as a satisfied precondition, not a milestone.
- Operator usability itself is `Assumption — needs validation via HP-6`, the
  hold point where an owner unfamiliar with the code deploys from current
  documentation.

## Users

- **Primary**: a self-hosting server owner with ordinary sysadmin skill and no
  access to the codebase or its authors. Triggered when they decide to stand up
  an OwnCord server on a domain, a public IP, a home LAN, or fully offline.
- **Secondary**: the release engineer who must produce signed, traceable
  artifacts for every supported architecture.
- **Not for**: end users of a server (their experience is B7–B9), and anyone
  expecting a hosted OwnCord service.

## Hypothesis

We believe **a qualified deployment, TLS, capacity, and failure-drill matrix**
will **let an unfamiliar owner securely host and operate a server unaided** for
**self-hosting server owners**.
We'll know we're right when **an owner who has never seen the code completes
every HP-6 task from published documentation alone, and the 250/100/25 profile
is met on stated hardware with published p95/p99 measurements.**

## Success Metrics

| Metric                   | Target                                                                      | How measured                                             |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Registered users         | ≥ 250                                                                       | `Server/scripts/k6/ws-load.js` on stated hardware        |
| Simultaneous connections | ≥ 100                                                                       | same k6 profile                                          |
| Concurrent voice         | ≥ 25                                                                        | **TBD — no LiveKit load harness exists** (workstream 14) |
| Latency budgets          | **TBD — p95/p99 budgets not yet stated**                                    | load-test dataset + reproducible commands                |
| Reference hardware       | **TBD — "stated hardware" undefined**                                       | published with the load dataset                          |
| TLS mode matrix          | 4/4 pass (domain, public IP, LAN, offline)                                  | network-mode integration matrix                          |
| Artifact matrix          | every asset installs, migrates, becomes healthy, drains, restarts, restores | artifact and container install/boot matrix               |
| Operator usability       | an unfamiliar owner completes every HP-6 task from docs alone               | HP-6 operator usability record                           |

## Scope

**MVP** — the server itself is qualified end to end on every supported
deployment mode: artifacts, containers, all four TLS modes, direct port
forwarding, upgrade/rollback, the capacity profile, failure drills, signed
supply-chain evidence, and operator documentation. HP-6 closes the phase and
gates client expansion.

**Out of scope**

- The signed browser client bundle — B8 supplies it. B6 only ships the
  disabled-by-default hosting switch and its origin/path contract.
- Any client-side experience — B7, B8, B9.
- Reverse-proxy-specific tuning — proxies stay optional (BPR-013); B6 qualifies
  direct operation and documents limits honestly.
- New performance _targets_. These measurements close the existing BPR-030
  promise; filename/MIME microbenchmarks stay labelled as microbenchmarks.
- Redesigning the retained audit-token erasure model. B6-15 reconciles the
  documentation with the HP-4-approved design; changing the guarantee needs an
  explicit owner decision.

## Satisfied preconditions

- Workstream 13's ARM64 blockers OC-0320, OC-0332, OC-0344 and OC-0339 are all
  `fixed` in the ledger as of 2026-09-08. Re-verify at the ARM64 release
  candidate; do not re-plan them.
- Workstream 15's exact-SHA gate (`gate-evidence` in `release.yml`, B1-7) and
  `environment: release` (B2-0) both already exist. B6-12 rehearses one tag
  against them; it does not build them.

## Delivery Milestones

<!-- Business outcomes, not engineering tasks. /plan turns each into a plan. -->
<!-- Status: pending | in-progress | complete -->

| #        | Milestone                                                | Outcome                                                                                                                                                                                                          | Status  | Plan | Roadmap WS |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---- | ---------- |
| B6-1     | Standalone release assets                                | An owner downloads a Windows x64/ARM64 executable or Linux x64/ARM64 archive that starts, migrates, becomes healthy, drains and restarts                                                                         | pending | —    | 1          |
| B6-2     | Docker images                                            | An owner runs the `linux/amd64` or `linux/arm64` image with persistent data, health, migration, graceful drain and minimal privilege                                                                             | pending | —    | 2          |
| B6-3     | Automatic TLS for domain and public IP                   | An owner points a domain (ACME) or an eligible stable public IPv4/IPv6 at the server and gets HTTPS/WSS with no manual renewal                                                                                   | pending | —    | 3          |
| B6-4     | LAN, offline, and manual certificate modes               | A private-LAN or offline owner completes one guided device-trust install; an advanced owner supplies their own certificate instead                                                                               | pending | —    | 3          |
| B6-5     | Certificate lifecycle safety                             | Certificate and ACME account keys are protected, renewal state survives restart, certificates hot-reload, and expiry/rotation is exercised with ample margin                                                     | pending | —    | 5          |
| B6-6     | Direct port-forward operation and honest limits          | A reverse proxy is never required; blocked-port, CGNAT, hairpin-NAT, dynamic-IP and firewall limits are reported actionably, never disguised as application success                                              | pending | —    | 4          |
| B6-7     | `GET /api/v1/server-info` and the browser-hosting switch | One endpoint answers "what is this server, and is the browser client on"; hosting is off by default and exposes no route or asset when disabled                                                                  | pending | —    | 6, 16      |
| B6-8     | Alpha-to-beta upgrade and rollback rehearsal             | An owner upgrades and rolls back database, attachments, configuration, credentials and backups on both Docker and standalone, with authenticated downloads still working afterwards                              | pending | —    | 7          |
| B6-9     | Published capacity profile                               | The 250/100/25 profile is met and published with hardware, configuration and reproducible commands                                                                                                               | pending | —    | 8, 14      |
| B6-10    | Operational performance measurements                     | Reconnect storms, database-pool wait deltas, recipient-receipt fan-out latency, voice control, upload admission through quota and storage, TLS overhead and graceful shutdown are all measured and published     | pending | —    | 9          |
| B6-11    | Failure and recovery drills                              | Backup/restore, deletion-marker restore, disk-full, low-headroom, corrupt input, unhealthy dependency, interrupted migration and rollback all pass, with byte-level erasure evidence under active readers        | pending | —    | 10         |
| B6-12    | Signed, traceable release inputs and outputs             | Containers and build inputs are pinned or auto-reviewed; SBOM, provenance, checksums and a source snapshot are signed; one tag is rehearsed against `gate-evidence` and `environment: release`                   | pending | —    | 11, 15     |
| B6-13    | Operator documentation                                   | Local logs, support-bundle generation, capacity limits, ports, storage growth, certificate trust, recovery, updates and safe failure are all documented for a stranger                                           | pending | —    | 12         |
| B6-14    | Service-boundary handle reconciliation                   | Every direct database-handle use, not only imports, has a named service, adapter or transaction-boundary owner, and the guard rejects unclassified access — with replay locking and persister ordering preserved | pending | —    | 17         |
| B6-15    | Privacy-claim reconciliation                             | BPR-053, requirement traceability and privacy acceptance evidence match the HP-4-approved retained audit-token design and `docs/trust-model.md`, with correlation and key-holder limits recorded consistently    | pending | —    | 18         |
| **HP-6** | **Operator and capacity acceptance — the owner signs**   | An owner unfamiliar with the code deploys each mode from current documentation, understands the network and trust limits, recovers a backup, rotates trust and interprets failure                                | pending | —    | HP-6       |
| B6-16    | Register and roadmap reconciliation                      | The issue register and roadmap match what B6 actually shipped                                                                                                                                                    | pending | —    | exit       |

**Ordering.** Unlike HP-5, **HP-6 sits at the end of the phase**, not in the
middle: it gates B7's client expansion rather than later B6 steps. B6-14 and
B6-15 must land _before_ HP-6 (workstreams 17 and 18 both say so). Packaging
(B6-1, B6-2), TLS (B6-3 – B6-5), capacity (B6-9, B6-10), failure drills (B6-11)
and supply chain (B6-12) can run in parallel once configuration and storage
contracts are frozen — but HP-6 must be reached with **one** release candidate
and **one** data-fixture set.

## Open Questions

- [ ] What is the "stated hardware" for the 250/100/25 profile? Without it the
      headline metric is unfalsifiable.
- [ ] Who owns the 25-participant LiveKit voice load harness? Workstream 14
      calls it a real gap needing a named owner before HP-6.
- [ ] What are the p95/p99 latency budgets HP-6 measures against?
- [ ] Do ARM64 assets ship in B6, or does B6 only qualify them?
- [ ] Where do the generated step plans live? ECC's `/plan` writes to
      `.claude/plans/`, which `.gitignore:9` leaves untracked. Either whitelist
      it (`!.claude/plans/`) or redirect output into `docs/plans/`.
- [ ] Are public-IP certificates still gated on short-lived certificate
      handling per current Let's Encrypt guidance? Re-check before B6-3.

## Risks

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                               |
| ---------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------- |
| The 25-participant voice number cannot be measured because no harness exists | High       | High   | Name an owner and scope the LiveKit harness as the first task of B6-9, before any load run               |
| Reference hardware is chosen to fit the numbers rather than stated up front  | Medium     | High   | Publish hardware and commands before the first qualifying run                                            |
| Public-IP ACME eligibility changes under the CA/B Forum or Let's Encrypt     | Medium     | Medium | Keep manual-certificate mode first-class; document the limitation honestly rather than retrying silently |
| Parallel workstreams qualify against different release candidates            | Medium     | High   | Freeze one RC and one fixture set before HP-6; record its SHA in the exit evidence                       |
| Byte-level erasure evidence contradicts the already-published privacy claim  | Low        | High   | B6-11 measures first; B6-15 aligns the wording to the measurement, never the reverse                     |
| Audit carryovers get re-planned as new work                                  | Medium     | Low    | Satisfied preconditions above are re-verified at the RC, not re-planned                                  |

---

_Status: DRAFT — requirements only. Implementation planning pending via /plan._
