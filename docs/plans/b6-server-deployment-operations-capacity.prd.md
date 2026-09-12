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

| Metric                   | Target                                                                      | How measured                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered users         | ≥ 250                                                                       | `Server/scripts/k6/ws-load.js` on stated hardware                                                                                                                                                                                       |
| Simultaneous connections | ≥ 100                                                                       | same k6 profile                                                                                                                                                                                                                         |
| Concurrent voice         | ≥ 25                                                                        | `lk load-test` (LiveKit CLI) wrapper script, 25 audio publishers + subscribers, plus k6 driving the OwnCord join/leave path; decided 2026-09-11                                                                                         |
| Latency budgets          | see "Initial latency budgets" below (decided 2026-09-11)                    | load-test dataset + reproducible commands                                                                                                                                                                                               |
| Reference hardware       | 2 vCPU / 4 GB RAM / SSD, Linux x64 (decided 2026-09-11)                     | B6-9's constrained leg in `load-baseline.yml` (`--cpuset-cpus=0,1 --cpus=2 --memory=4g --memory-swap=4g`); numbers publish only from that leg, and the ceiling leg is explicitly non-gating. Published in [capacity.md](../capacity.md) |
| TLS mode matrix          | 4/4 pass (domain, public IP, LAN, offline)                                  | network-mode integration matrix                                                                                                                                                                                                         |
| Artifact matrix          | every asset installs, migrates, becomes healthy, drains, restarts, restores | artifact and container install/boot matrix                                                                                                                                                                                              |
| Operator usability       | an unfamiliar owner completes every HP-6 task from docs alone               | HP-6 operator usability record                                                                                                                                                                                                          |

### Initial latency budgets (decided 2026-09-11)

Measured at the 100-connection profile on the reference hardware. These are
starting budgets: HP-6 measures against them, and B6-9 may tighten (never
loosen) them once the first dataset exists. Anything looser than this is a
finding, not a number to publish. Where the source column says "new", the k6
script does not record that path yet; adding the metric and its p95/p99
thresholds is B6-9 work, before the first qualifying run.

| Path                                                     | p95      | p99      | Source of the number                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST login (`auth_time`)                                 | < 1 s    | < 2 s    | existing k6 p95 threshold; p99 is new                                                                                                                                                                                                                                                                                                                                           |
| WebSocket open → `auth_ok` received                      | < 1 s    | < 2 s    | new k6 metric in B6-9: `ws_connect_time` stops at socket open, before `auth_ok`                                                                                                                                                                                                                                                                                                 |
| Message send → sender acknowledgement (WebSocket)        | < 200 ms | < 500 ms | B3 bench baseline order of magnitude, with headroom. **Corrected in B6-9:** said "(REST)", but no REST endpoint creates a message — every write reaches `service/message_delivery.go` from the WS read pump, so the only send acknowledgement is `chat_send` → `chat_send_ok`                                                                                                   |
| Message send → recipient delivery (all 100 connections)  | < 250 ms | < 500 ms | new: the B3 carryover said sender ack was measured, not this                                                                                                                                                                                                                                                                                                                    |
| Voice join — OwnCord half (`voice_join` → `voice_token`) | < 2 s    | < 4 s    | **Corrected in B6-9:** the combined token-plus-room-join figure is not obtainable as a percentile. k6 has no WebRTC stack and `lk load-test` publishes no join-latency distribution, so the OwnCord half is the budgeted percentile and the LiveKit half is published as the cohort's ramp-inclusive connect wall clock. Voice join is a WS path (`voice_join`), not a REST one |
| Graceful drain to exit 0                                 | < 20 s   | —        | `Server/cmd/smoke` `drainBudget`                                                                                                                                                                                                                                                                                                                                                |

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
<!-- Status: pending | in-progress | complete | deferred -->

| #        | Milestone                                                | Outcome                                                                                                                                                                                                          | Status      | Plan                                                                                                   | Roadmap WS |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| B6-1     | Standalone release assets                                | An owner downloads a Windows x64/ARM64 executable or Linux x64/ARM64 archive that starts, migrates, becomes healthy, drains and restarts                                                                         | complete    | [b6-1-standalone-release-assets.plan.md](../../.claude/plans/b6-1-standalone-release-assets.plan.md)   | 1          |
| B6-2     | Docker images                                            | An owner runs the `linux/amd64` or `linux/arm64` image with persistent data, health, migration, graceful drain and minimal privilege                                                                             | complete    | [b6-2-docker-images.plan.md](../../.claude/plans/b6-2-docker-images.plan.md)                           | 2          |
| B6-3     | Automatic TLS for domain and public IP                   | An owner points a domain (ACME) or an eligible stable public IPv4/IPv6 at the server and gets HTTPS/WSS with no manual renewal                                                                                   | deferred    | —                                                                                                      | 3          |
| B6-4     | LAN, offline, and manual certificate modes               | A private-LAN or offline owner completes one guided device-trust install; an advanced owner supplies their own certificate instead                                                                               | deferred    | —                                                                                                      | 3          |
| B6-5     | Certificate lifecycle safety                             | Certificate and ACME account keys are protected, renewal state survives restart, certificates hot-reload, and expiry/rotation is exercised with ample margin                                                     | deferred    | —                                                                                                      | 5          |
| B6-6     | Direct port-forward operation and honest limits          | A reverse proxy is never required; blocked-port, CGNAT, hairpin-NAT, dynamic-IP and firewall limits are reported actionably, never disguised as application success                                              | complete    | [b6-6-port-forward-honest-limits.plan.md](../../.claude/plans/b6-6-port-forward-honest-limits.plan.md) | 4          |
| B6-7     | `GET /api/v1/server-info` and the browser-hosting switch | One endpoint answers "what is this server, and is the browser client on"; hosting is off by default and exposes no route or asset when disabled                                                                  | complete    | [b6-7-server-info-browser-switch.plan.md](../../.claude/plans/b6-7-server-info-browser-switch.plan.md) | 6, 16      |
| B6-8     | Alpha-to-beta upgrade and rollback rehearsal             | An owner upgrades and rolls back database, attachments, configuration, credentials and backups on both Docker and standalone, with authenticated downloads still working afterwards                              | complete    | [b6-8-upgrade-rollback-rehearsal.plan.md](../../.claude/plans/b6-8-upgrade-rollback-rehearsal.plan.md) | 7          |
| B6-9     | Published capacity profile                               | The 250/100/25 profile is met and published with hardware, configuration and reproducible commands                                                                                                               | in-progress | [b6-9-published-capacity-profile.plan.md](../../.claude/plans/b6-9-published-capacity-profile.plan.md) | 8, 14      |
| B6-10    | Operational performance measurements                     | Reconnect storms, database-pool wait deltas, recipient-receipt fan-out latency, voice control, upload admission through quota and storage, TLS overhead and graceful shutdown are all measured and published     | pending     | —                                                                                                      | 9          |
| B6-11    | Failure and recovery drills                              | Backup/restore, deletion-marker restore, disk-full, low-headroom, corrupt input, unhealthy dependency, interrupted migration and rollback all pass, with byte-level erasure evidence under active readers        | pending     | —                                                                                                      | 10         |
| B6-12    | Signed, traceable release inputs and outputs             | Containers and build inputs are pinned or auto-reviewed; SBOM, provenance, checksums and a source snapshot are signed; one tag is rehearsed against `gate-evidence` and `environment: release`                   | pending     | —                                                                                                      | 11, 15     |
| B6-13    | Operator documentation                                   | Local logs, support-bundle generation, capacity limits, ports, storage growth, certificate trust, recovery, updates and safe failure are all documented for a stranger                                           | pending     | —                                                                                                      | 12         |
| B6-14    | Service-boundary handle reconciliation                   | Every direct database-handle use, not only imports, has a named service, adapter or transaction-boundary owner, and the guard rejects unclassified access — with replay locking and persister ordering preserved | pending     | —                                                                                                      | 17         |
| B6-15    | Privacy-claim reconciliation                             | BPR-053, requirement traceability and privacy acceptance evidence match the HP-4-approved retained audit-token design and `docs/trust-model.md`, with correlation and key-holder limits recorded consistently    | pending     | —                                                                                                      | 18         |
| **HP-6** | **Operator and capacity acceptance — the owner signs**   | An owner unfamiliar with the code deploys each mode from current documentation, understands the network and trust limits, recovers a backup, rotates trust and interprets failure                                | pending     | —                                                                                                      | HP-6       |
| B6-16    | Register and roadmap reconciliation                      | The issue register and roadmap match what B6 actually shipped                                                                                                                                                    | pending     | —                                                                                                      | exit       |

**Ordering.** Unlike HP-5, **HP-6 sits at the end of the phase**, not in the
middle: it gates B7's client expansion rather than later B6 steps. B6-14 and
B6-15 must land _before_ HP-6 (workstreams 17 and 18 both say so). Packaging
(B6-1, B6-2), TLS (B6-3 – B6-5), capacity (B6-9, B6-10), failure drills (B6-11)
and supply chain (B6-12) can run in parallel once configuration and storage
contracts are frozen — but HP-6 must be reached with **one** release candidate
and **one** data-fixture set.

### TLS block deferred to the release (owner decision, 2026-09-11)

**B6-3, B6-4 and B6-5 are deferred** — the owner's call is that certificate work
belongs to the actual release rather than to this qualification phase. Nothing
about them is refuted or descoped; they are simply not being built now.

What the deferral costs, stated plainly so it is not rediscovered at the hold
point:

- **B6 cannot be signed off at HP-6 as written.** Success Metrics requires a
  "TLS mode matrix — 4/4 pass (domain, public IP, LAN, offline)". With B6-3 – B6-5
  deferred that row is unmeasured, so HP-6 either records it as an accepted
  limitation or waits for the TLS work. That is an owner decision at the hold
  point, not something a later milestone silently resolves.
- **B6-6 (direct port-forward operation) narrows.** It can still qualify
  port-forwarding, CGNAT, hairpin-NAT and firewall limits honestly, but it
  cannot claim a working HTTPS/WSS path on a public IP, because nothing issues
  that certificate yet. Scope B6-6 to reachability and honest limits, and say so.
- **What already works is unaffected; what was never qualified stays
  unqualified.** `tls.mode` already offers `self_signed`, `acme` and `manual`,
  and `docs/deployment.md` documents all three — that is pre-B6 behaviour and
  nothing here removes it. The deferral is about the _qualification_ B6-3 – B6-5
  would have added: a public-IP certificate flow, a guided LAN/offline
  device-trust install, and proof that renewal state survives restart,
  certificates hot-reload and rotation happens with margin. Until then, treat
  domain ACME as "implemented, not exercised at release quality", and do not
  claim a public-IP or offline TLS story at all.
- **The research does not expire, but the facts might.** The certmagic /
  `autocert` finding recorded under "Public-IP certificate consequences" below
  was established 2026-09-11 against Let's Encrypt's then-current profile rules.
  Re-verify it when the TLS work is picked up; a six-day certificate policy is
  exactly the kind of thing that moves.

## Open Questions

- [x] **Decided 2026-09-11:** the "stated hardware" is a 2 vCPU / 4 GB RAM /
      SSD Linux x64 machine — the cheapest VPS or single-board class an owner
      is likely to buy. It is reproduced, not owned: B6-9 adds a leg to
      `load-baseline.yml` that runs the server inside a
      `docker run --cpus=2 --memory=4g` cgroup, so anyone can re-run it. **Built
      in B6-9** as `--cpuset-cpus=0,1 --cpus=2 --memory=4g --memory-swap=4g`,
      with the load generators pinned by `taskset` to the two CPUs the server
      does not have. `--cpus` alone was not sufficient and the decision's
      wording understated it: `--cpus` is a CFS quota, while `runtime.NumCPU()`
      reads the affinity mask, so without the cpuset the server sizes
      `GOMAXPROCS` and its bcrypt admission budget for cores the cgroup will
      not give it (verified: `--cpus=2` alone reported 32 CPUs on a 32-core
      host, the cpuset reported 2). The hardware, the configuration and the
      commands are published in [capacity.md](../capacity.md), committed before
      the first qualifying run. The developer's 16-core box (B3 bench baseline)
      is a ceiling check, never the reference.
- [x] **Decided 2026-09-11:** the repository owner (J3vb) owns the voice load
      harness, as B6-9 task 1. It is not written from scratch: LiveKit's CLI
      already ships `lk load-test` (simulated audio/video publishers and
      subscribers with per-track latency and packet-loss stats). B6-9 wraps it
      in a script that drives 25 audio publishers + 25 subscribers against the
      bundled `livekit-server`, while k6 drives the OwnCord join/leave/token
      path. The "no harness exists" claim in workstream 14 was about k6; it is
      closed by using the SFU vendor's own tool.
- [x] **Decided 2026-09-11:** initial p95/p99 budgets are in "Initial latency
      budgets" under Success Metrics. Tighten from data; never loosen.
- [x] **Decided 2026-09-11:** ARM64 assets ship in B6. B6-1 (PR #1580) added
      Windows ARM64 and Linux ARM64 server assets, ARM64-aware self-update and
      the shared `cmd/smoke` harness to the release matrix. B6-1 stays
      `in-progress` until the first tag run proves the three unchecked
      acceptance rows (build/smoke/upload of all four assets, manifest and
      checksums, signatures); B6-12's rehearsed tag is where that evidence is
      recorded and the row flips to `complete`.
- [x] **Decided 2026-09-08:** generated step plans live at ECC's default
      `.claude/plans/`, whitelisted in `.gitignore` so they are tracked and
      reviewable in the PR. Prettier reads `.gitignore`, so those plans are
      format-gated like any other tracked markdown; `npm run format` fixes
      drift. This PRD stays in `docs/plans/` as the tracked entry point.
- [x] **Re-checked 2026-09-11:** yes, and it is now settled rather than
      pending. Let's Encrypt made IP-address certificates generally available
      on 2026-01-15. They are issued only under the `shortlived` profile
      (160 h validity, roughly 6.7 days), validated by `http-01` or
      `tls-alpn-01` only (no `dns-01`), for public IPv4 and IPv6. Consequences
      for B6-3, B6-5 and B6-6 are in "Public-IP certificate consequences"
      below.

### Public-IP certificate consequences (2026-09-11)

- **The current client cannot do it.** `golang.org/x/crypto/acme/autocert`
  (v0.56.0, `Server/auth/tls.go` `loadACME`) has no profile selection and its
  `Manager` accepts hostnames only; `loadACME` explicitly rejects IPs today.
  B6-3 needs an ACME client that sets the order profile. `certmagic` (v0.25.x)
  exposes `ACMEIssuer.Profile`; B6-3 starts with a spike proving it issues for
  a public IP against the Let's Encrypt staging directory, and falls back to a
  thin issuer on `x/crypto/acme` (which already has IP authorizations but no
  profile field) only if certmagic refuses public-IP subjects.
- **Renewal is every ~4 days, not every ~60.** B6-5's "renewal state survives
  restart" becomes a hard requirement, and a server that was off for more than
  a week boots with an expired certificate: it must re-issue before serving,
  and B6-6 must report a failed re-issue as a reachability problem, not as
  application success.
- **Domain mode stays on the 90-day `classic` profile.** The two modes must
  not share a renewal schedule.

## Risks

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The 25-participant voice number cannot be measured because no harness exists | Closed     | High   | `Server/scripts/voice-load.sh` (B6-9) wraps `lk load-test` at 25 + 25 and **asserts** the subscriber summary: `lk` exits 0 over a fully lossy room, and its default `--layout speaker` silently caps each subscriber at ~6 tracks, so a 25x25 room reports 150/625 with 0% loss unless the layout is set and the total checked |
| Reference hardware is chosen to fit the numbers rather than stated up front  | Medium     | High   | Publish hardware and commands before the first qualifying run                                                                                                                                                                                                                                                                  |
| Public-IP ACME eligibility changes under the CA/B Forum or Let's Encrypt     | Medium     | Medium | Keep manual-certificate mode first-class; document the limitation honestly rather than retrying silently                                                                                                                                                                                                                       |
| Parallel workstreams qualify against different release candidates            | Medium     | High   | Freeze one RC and one fixture set before HP-6; record its SHA in the exit evidence                                                                                                                                                                                                                                             |
| Byte-level erasure evidence contradicts the already-published privacy claim  | Low        | High   | B6-11 measures first; B6-15 aligns the wording to the measurement, never the reverse                                                                                                                                                                                                                                           |
| Audit carryovers get re-planned as new work                                  | Medium     | Low    | Satisfied preconditions above are re-verified at the RC, not re-planned                                                                                                                                                                                                                                                        |

---

_Status: DRAFT — requirements only. Implementation planning pending via /plan._
