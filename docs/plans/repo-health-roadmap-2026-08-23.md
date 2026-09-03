# OwnCord public-beta execution roadmap

**Prepared:** 2026-08-23  
**Audited head:** 5cc0888964e26276d1aca145e83270a2c1b9febd on dev  
**Release target:** first public beta after the 1.2.0-alpha line  
**Status:** B0–B3 complete (HP-0 accepted 2026-08-25, HP-1 accepted
2026-08-27, HP-2 accepted 2026-08-29, HP-3 accepted 2026-08-30; B3 exit
signed 2026-09-01 — the "B3 exit" section of
[hp-3-scorecard-2026-08-29.md](hp-3-scorecard-2026-08-29.md)). **B4 executed
2026-09-01 to 2026-09-03** (HP-4 accepted 2026-09-03), all twelve steps
merged to `dev`; its **exit is prepared and awaiting the owner's sign-off** —
the "B4 exit" section of
[hp-4-scorecard-2026-09-02.md](hp-4-scorecard-2026-09-02.md), measured at
`dev` `1133a26`. HP-5 is next; B5–B10 not started. Amended 2026-08-28 — see the `_(added 2026-08-28)_` lines
in B3–B10 and the "Phase execution pattern" section. Amended 2026-08-29 —
[developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md)
is the implementation supplement for the B3, B7 and B9 structural workstreams
(see the `_(added 2026-08-29)_` lines); it is not a phase and adds no gate.
[README.md](README.md) is the status authority when this header and a README
row disagree.  
**Planning model:** quality-gated, with no calendar deadline

Primary inputs:

- [beta product requirements](beta-product-requirements-2026-08-23.md)
- [requirement traceability](beta-requirements-traceability-2026-08-23.md)
- [repository-layout audit](../audit-2026-08-23-repository-layout.md)
- [repository-health issue register](repo-health-issue-register-2026-08-23.md)

## Decision

OwnCord is not beta-ready today. The server has the stronger engineering
baseline, but it still needs security remediation, compatibility contracts,
data-lifecycle work, deployment qualification, and capacity evidence. The
desktop client has a useful foundation, but its required gate is red and the
approved browser, PWA, phone, tablet, moderation, recovery, and privacy
experience is incomplete.

The best route is an ordered server-first program:

1. restore one truthful baseline;
2. perform the justified repository cleanup as an isolated migration;
3. freeze server protocol, trust, and compatibility contracts;
4. strengthen server boundaries before adding beta services;
5. complete server identity, privacy, community, moderation, deployment, and
   operations;
6. bring the shared desktop client onto explicit platform contracts;
7. add the browser/PWA target from the same application;
8. finish cross-client experience, accessibility, and polish;
9. qualify one release candidate against the complete matrix.

This is deliberately not a wholesale rewrite. Existing server packages,
desktop behavior, release asset names, updater contracts, and the shared
client application remain stable unless a phase has evidence for a narrower
change.

## Current evidence snapshot

This is audit evidence, not a release claim. It must be refreshed in B0.
_Superseded 2026-08-25 by
[b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md), which holds the
measured numbers. The table below is kept for the audit trail._

| Area               | Evidence at the audited head                                                                                                                                    | Consequence                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Server             | Default, OpenTelemetry, Wazero-tagged WASM runtime, and combined builds pass; vet, race, deadlock, and tagged tests pass; aggregate CI-style coverage is 74.6%. | Strong baseline, but not a beta qualification.                                       |
| Server limitations | Local Docker evidence was unavailable and local golangci-lint could not load because its Go toolchain differed from the module toolchain.                       | Obtain clean CI or matched-tool evidence; do not waive either gate.                  |
| Client             | Type checks, ESLint, Prettier, Knip, production dependency audit, Vite build, browser smoke, Rust Clippy, and 115 Rust tests pass.                              | Useful desktop foundation.                                                           |
| Client blockers    | Two Vitest tests fail; Playwright completes test cases but does not terminate; Oxlint reports 471 warnings.                                                     | The client gate is red and structural work must not begin on a false-green baseline. |
| Client size        | The livekitSession chunk is about 2.0 MB minified and 1.34 MB gzip; additional LiveKit and main-page chunks are material.                                       | Establish budgets before client decomposition and browser delivery.                  |
| Browser/PWA        | No production browser target, optional server host, PWA, Web Push, or adequate mobile navigation is implemented.                                                | This is a planned product workstream, not an existing capability.                    |
| Exact-SHA CI       | No workflow run was found for the audited dev commit.                                                                                                           | B0 and B1 must close the integration-evidence gap.                                   |
| Security           | A prior untracked report set exists and an independent deep scan is being reconciled.                                                                           | Keep details private until coordinated remediation; publish only safe status.        |

## Non-negotiable execution rules

### Gate-driven, not date-driven

- There is no delivery deadline.
- A phase closes only when every exit condition has dated evidence on the exact
  integration commit.
- An incomplete requirement cannot be renamed done, deferred silently, or
  hidden by changing a threshold.
- Calendar estimates may be added for personal planning, but they never replace
  a gate.

### One coherent invariant per change

Every implementation change should:

1. identify one behavior, boundary, migration, or extraction;
2. start with a failing contract, reproducer, measurement, or code-level proof;
3. change the smallest reviewable surface;
4. update source, tests, generated output, reference documentation, and
   migration notes together;
5. run the complete affected-component gate;
6. record exact-SHA evidence and tracker disposition.

Do not combine a security-boundary change, dependency major, layout move, and
architecture refactor in one pull request. Rename-only changes contain no
functional edits.

### One source of truth per concern

- Product scope: beta-product-requirements-2026-08-23.md.
- Requirement ownership and proof: beta-requirements-traceability-2026-08-23.md.
- Defect status: the canonical OC finding ledger or its approved successor.
- Security-sensitive defects: private GitHub Security Advisories.
- Phase order and gates: this roadmap.
- Historical audits: dated audit files, never reused as current status without
  re-verification.

Planning identifiers are not duplicate defect trackers. Every confirmed defect
must map to one canonical OC issue or one private advisory before remediation.

### Public and private security handling

- Never commit the untracked detailed security reports to the public repository
  while the findings are exploitable.
- Public plans use opaque identifiers, affected security properties, safe
  acceptance criteria, and a status only.
- Reproduction steps, source-to-sink traces, exploit conditions, secrets,
  patches under embargo, and scanner artifacts stay in private advisories.
- Every candidate is independently validated or refuted. Sibling call sites are
  checked before declaring the class fixed.
- A fix is not closed until regression tests, affected-platform tests, and a
  second review pass are green.
- Release notes may describe repaired impact after coordinated remediation
  without exposing unnecessary exploit detail.
- B10 requires zero unresolved security advisory. Accepted risk cannot be used
  for a known exploitable beta blocker.

## Phase dependency chain

    B0 Truth and scope
      ↓
    B1 Repository and contributor foundation
      ↓
    B2 Server protocol, trust, and compatibility
      ↓
    B3 Server architecture and permanent guardrails
      ↓
    B4 Server identity, recovery, privacy, and data lifecycle
      ↓
    B5 Server community, content, and moderation services
      ↓
    B6 Server deployment, operations, and capacity
      ↓
    B7 Shared client platform and desktop parity
      ↓
    B8 Browser, PWA, phone, and tablet
      ↓
    B9 Unified experience, moderation UX, accessibility, and polish
      ↓
    B10 Beta qualification and public release

The phase exits are serial. Parallelism is allowed only inside the active phase
or for non-mutating preparation of the next phase. Server behavior and
operations are therefore stable through B6 before browser feature work begins.

## Common entry and exit contract

An item is ready for implementation only when it has:

- impact, priority, affected requirement, and explicit non-goals;
- a reproducer, failing test, measurement, or reviewed code proof;
- known protocol, migration, privacy, and rollback effects;
- dependencies and an owner;
- a verification plan capable of failing before the change.

An item is done only when:

- its acceptance evidence is green on supported environments;
- the full affected server, client, browser, Rust, deployment, and generated
  contract gates remain green;
- no new warning, advisory, documentation drift, or generated drift appears;
- the exact integration commit has CI evidence;
- tracker, requirement map, and phase scorecard agree;
- rollback, compatibility, and data-migration notes exist where applicable.

## Phase execution pattern

_Added 2026-08-28._ What B0 and B1 proved, written once so later phases do not
rediscover it.

1. Each phase gets an execution plan, `docs/plans/bN-<slug>-<date>.md`, at its
   start, and a scorecard, `docs/plans/hp-N-scorecard-<date>.md`, at its hold
   point. The plan re-verifies this roadmap's claims against HEAD before
   implementing anything — B1 refuted several audit findings on contact — and
   records each verdict. [README.md](README.md) rows are the status authority;
   a plan header that disagrees with its README row is stale.
2. A phase cannot exit while any `OC-*` finding tagged to it in the
   [issue register](repo-health-issue-register-2026-08-23.md) is open, unless
   the finding is re-tagged to a later phase with a written reason in the
   scorecard. The tags exist today; this rule is what enforces them, and it is
   what makes "zero open P0/P1 at B10" a measured fact rather than a hope.
3. Record pre-squash pull-request SHAs at merge time whenever a hold point
   reviews commit structure. `dev` is squash-only, so a pure-move/rewrite or
   fixture/behaviour split survives only on `refs/pull/<n>/head`
   ([hp-1-scorecard-2026-08-27.md](hp-1-scorecard-2026-08-27.md)).
4. `dev` requires branches to be up to date before merging (`strict: true`,
   applied in B2-0). One pull request per plan step, branched from `dev`.

## B0 — Restore truth, freeze scope, and reconcile the audit

**Objective:** replace stale or contradictory status with one reproducible
baseline before source restructuring or feature development.

**Primary requirements:** BPR-002 and BPR-003.

### Entry gate

- The audited commit is recorded.
- Product decisions and supported targets are fixed in the beta requirements.
- Existing source, audit documents, and untracked security evidence are
  preserved.

### Workstreams

1. Freeze a machine-readable baseline manifest containing commit, tool
   versions, dependency locks, test totals, coverage, warnings, bundle sizes,
   release targets, and environment limitations.
2. Repair the two failing client unit contracts without weakening their
   assertions.
3. Reproduce and fix the Playwright shutdown defect so the required suite exits
   unaided on Windows and CI.
4. Run the complete server matrix with a matched lint toolchain and obtain
   Docker smoke evidence in an environment with a daemon.
5. Run the complete client, browser-smoke, Rust, dependency, generated-code,
   and packaging-preflight gates.
6. Reconcile every open ledger entry, issue-register item, layout finding,
   product gap, and security candidate. Record duplicate, refuted, accepted,
   blocked, or confirmed status with evidence.
7. Complete the independent deep security scan and deduplicate it against prior
   evidence without publishing sensitive details.
8. Define which checks are required per pull request, integration commit,
   nightly run, and release candidate.
9. Freeze beta scope. New nonessential ideas go to the post-beta backlog.

### Hold point HP-0 — Baseline acceptance

No layout or feature source change begins until the owner can inspect one
scorecard and answer:

- what is green, red, unavailable, and unverified;
- which confirmed issues block each later phase;
- which checks protect the integration branch;
- which security details remain private.

### Exit gate

- The required baseline server and client checks are green on one exact commit.
- Playwright terminates normally and Docker/lint evidence is available.
- Every audit candidate has a canonical disposition; no unverified candidate is
  counted as fixed or ignored.
- All product requirements appear exactly once in the traceability map.
- The exact dev integration commit receives the defined blocking matrix.
- The worktree contains no accidental generated or build output.
- The beta scope and post-beta boundary are explicit.

### Required evidence

- baseline manifest and phase scorecard;
- CI links for the exact SHA;
- server/client command and result matrix;
- red-to-green test evidence for the two unit failures and E2E shutdown;
- private security reconciliation record;
- canonical issue and requirement exports.

### Safe parallelism

Server validation, client validation, requirement mapping, and independent
security review may run in parallel because they are read-only or isolated.
Fixes to shared test infrastructure are serialized. No product feature work is
safe during B0.

## B1 — Isolated repository and contributor foundation

**Objective:** make the repository discoverable, cross-platform, and ready for
one shared desktop/browser application without mixing layout churn with
behavior changes.

**Primary requirements:** BPR-100 through BPR-103.

### Entry gate

- HP-0 is accepted.
- All baseline gates are green.
- The layout-audit target and migration controls are approved.

### Workstreams

1. Add a root cross-platform command facade for bootstrap, scoped checks, full
   checks, generation, and release preflight while preserving direct Go
   commands for server-only contributors.
2. Add a documentation landing page and active-plan index. Establish one source
   of truth for Node 24, branch policy, supported platforms, generated files,
   and security reporting.
3. Add a root editor baseline and complete formatting/lint coverage for
   Markdown, YAML, JSON, CSS, Rust, Go, scripts, and workflows.
4. Make hooks optional thin wrappers around the root commands so Windows
   contributors are not required to infer POSIX or Make prerequisites.
5. Decide and implement complete dependency automation for every lock root,
   container, action, and build image.
6. Prove portable regeneration or CI artifact replacement before untracking
   large graph and rendered-ledger payloads. Do not rewrite published history.
7. Flatten Client/tauri-client into Client as two adjacent non-functional
   commits: first pure file moves, then mechanical rewrites of active
   automation, release, generator, hook, and documentation paths. Leave
   historical audit links intact.
8. Move executable protocol ownership from docs into a root protocol boundary
   and verify both Go and TypeScript consumers from one command.
9. Move executable Go tools to conventional ownership and remove
   package-discovery filesystem side effects.
10. Reclassify cross-component tests into their real owner or an explicit
    contract/system tier.
11. Align or deliberately document the Go module namespace.
12. Protect dev with exact-SHA CI, require full evidence before tag
    publication, modernize issue forms and Discussions routing, and restrict
    paid comment-triggered workflows to trusted associations.
13. Document the future platform contract folders without moving native
    behavior yet. Functional adapter extraction belongs to B7.

### Hold point HP-1 — Structural diff review

Review the pure-move commit, the adjacent path-rewrite commit, active path
inventory, generated-artifact ownership, command facade, and protocol
relocation as mechanical changes. If behavior changed, split it out and re-run
the structural review.

### Exit gate

- Fresh Windows and Linux contributors can find one setup path and run scoped
  or complete checks without guessing directories.
- Desktop behavior, release asset names, and update contracts are unchanged.
- The pure-move and mechanical-path-rewrite commits are independently
  reviewable and active path references are complete.
- Generated sources and analysis artifacts have explicit reproducible owners.
- The protocol schema generates and verifies both consumers from the root.
- Every dev integration commit carries full-matrix evidence: the required
  matrix runs on the pull-request head, and `strict: true` makes the squash
  commit's tree the tree that matrix tested.
  `scripts/verify-integration-tree.sh` proves it per squash SHA;
  `verify-gate-evidence.mjs --selftest` pins the strict flag in the recorded
  configuration (`b0-dev-branch-protection.sh`, the apply artifact). GitHub's
  live setting is admin-scoped and unreadable from CI, so nothing here
  detects a flipped live flag as such: what the milestone tree-identity run
  detects is any stale merge such a flip has let land — after the fact, and
  only if one lands. Closing that window is an owner action, not a check:
  the owner re-runs `b0-dev-branch-protection.sh` at each hold point, which
  reasserts the recorded configuration over any live drift. _(Reworded
  2026-08-31, owner decision — previously "exact-SHA CI", which dev pushes
  never ran; PR-head evidence with enforced tree identity is the accepted
  form. Precision and the reapply step added the same day, from Codex's P1
  on the follow-up PR.)_
- Issues, Discussions, pull requests, and private security reporting match the
  approved community model.
- Full B0 evidence remains green after the migration.

### Required evidence

- before/after path manifest and rename similarity report;
- fresh-clone setup smoke on Windows and Linux;
- root-command output and direct server-command parity;
- docs link checker and repository lint results;
- generated-source drift check;
- identical-tree integration evidence (see the exit gate) and
  protected-release evidence.

### Safe parallelism

Documentation/index work, root command design, generated-artifact
investigation, and community-template updates may proceed in parallel. The
client flatten, protocol move, and executable-tool move are separate serialized
changes. No functional platform extraction is mixed into them.

## B2 — Freeze server protocol, trust, and compatibility contracts

**Objective:** establish the security and version boundaries that all later
server services and clients must obey.

**Primary requirements:** BPR-031, BPR-032, BPR-040, BPR-050, BPR-051, and
BPR-080 through BPR-083.

**Execution plan** _(added 2026-08-28)_:
[b2-protocol-trust-compat-2026-08-28.md](b2-protocol-trust-compat-2026-08-28.md).

### Entry gate

- B1 is complete and protocol source has one owner.
- Confirmed security findings have private owners and acceptance tests.
- Existing alpha protocol fixtures and updater contracts are captured.

### Workstreams

1. Define explicit protocol-epoch and capability negotiation. The upgraded
   server accepts epochs N, N-1, and N-2 and rejects older epochs with a safe
   actionable response. Patch releases within an epoch remain compatible, and
   prerelease/release metadata declares its epoch.
2. Define server-first update ordering and signed update metadata contracts.
   A new client is not required to speak to an old server.
3. Add version fixtures and compatibility tests that survive later code
   refactors and generated-type changes.
4. Document and enforce the trust model: server-readable stored text/files;
   authenticated transport; participant E2EE for voice, video, and screen
   sharing.
5. Reconcile authentication, channel visibility, send, typing, moderation,
   voice moderation, and session-admission predicates so effective permissions
   have canonical production ownership.
6. Record safe audit events for security-sensitive actions without storing
   content or secrets unnecessarily.
7. Prove accounts are server-local and no global identity, central directory,
   federation, or OwnCord-operated runtime dependency is introduced.
8. Keep the WASM runtime experimental and disabled by default. Document that
   beta makes no stable plugin API promise.
9. Inventory cohesive post-beta plugin candidates: provider integrations,
   slash commands and automation, webhooks, optional moderation automation,
   UI tabs, import/export bridges, and observability exporters.
10. Keep authentication, authorization, TLS, safe fetch, quotas, E2EE, update
    verification, deletion, recovery, and moderation audit in core.

### Hold point HP-2 — Protocol and threat-model sign-off

Freeze protocol versions, downgrade behavior, trust claims, E2EE membership
rules, permission predicates, and deferred-system boundaries before database or
service expansion. Security details remain in private review.

### Exit gate

- Clients from epochs N, N-1, and N-2 pass the server compatibility matrix;
  N-3 fails safely and actionably. The server-bundled browser client matches
  the server epoch rather than becoming an independent generation. _(HP-2
  accepted this condition at the slim one-epoch scope — owner decision
  2026-08-29, formalized 2026-08-31 in BPR-032 as amended.)_
- Protocol and update metadata changes are generated, documented, and
  downgrade-tested.
- Effective permission and resource-existence sibling cases have parity tests.
- Voice/video/screen E2EE membership and key-change behavior pass adversarial
  tests.
- No central identity, directory, federation path, or required external
  service exists.
- WASM is disabled by default and release artifacts do not imply API stability.
- No unresolved B2 security advisory remains.

### Required evidence

- compatibility fixture matrix and protocol changelog;
- threat model and private security validation;
- permission and E2EE integration tests;
- update-order and incompatibility UX contract tests;
- configuration/default audit for plugins and central dependencies.

### Safe parallelism

Compatibility fixtures, trust-model review, plugin-boundary inventory, and
central-dependency audit can start in parallel. Production protocol changes,
permission consolidation, and E2EE changes are serialized behind HP-2.

## B3 — Strengthen server architecture and permanent guardrails

**Objective:** remove temporal coupling and duplicate domain rules before beta
services increase the server's surface.

**Primary requirements:** none. B3 is a mandatory engineering-enabling phase
for every later requirement.

### Entry gate

- B2 contracts are frozen and covered by compatibility tests.
- Server baseline, race, deadlock, and security tests are green.
- Hotspots and direct database call sites have an owned inventory.

### Workstreams

1. Add baseline-ratcheted aggregate and critical-package coverage floors.
2. Add focused benchmarks and deterministic hub simulations for reconnect,
   supersession, replay, acknowledgement, subscription, fan-out, and failure
   ordering.
3. Add fuzz seeds and model/property tests around protocol parsing, permissions,
   uploads, recovery tokens, and state transitions.
4. Move auth middleware and routes behind narrow services while preserving
   enumeration defenses and database sentinel mappings.
5. Classify every direct database call above the domain layer as migrate,
   explicit transaction/composition boundary, or accepted adapter. Move one
   domain family at a time.
6. Move required hub collaborators into validated constructor options. Runtime
   mutation remains only for genuinely replaceable state.
7. Replace mirrored send/visibility rules with canonical value-taking
   predicates.
8. Split construction, start, stop, drain, and router mounting into explicit
   ownership with one composite close contract.
9. Decompose handshake/replay, broadcast, command, voice, query, and auth
   hotspots along tested lock and transaction boundaries.
10. Generate or verify machine-readable protocol, API, schema, and
    configuration documentation.
11. Establish performance baselines for permission invalidation, read-state
    writes, broadcast/replay, database waits, reconnect storms, and upload
    admission.
12. _(added 2026-08-28)_ Build the alpha-shaped test dataset: a deterministic
    alpha-shape profile in `Server/cmd/seed` plus one anonymised
    `v1.2.0-alpha.4` database snapshot at a documented path. B4's HP-4 drills,
    B6's upgrade rehearsal and B10's in-place upgrade all consume it; until B3
    builds it, nobody owns it.
13. _(added 2026-08-28)_ Workstreams 2 and 3 are the design already written in
    [bug-detection-improvements.md](bug-detection-improvements.md), Tiers 3a,
    3b and 3c. Execute that design; do not write another.
14. _(added 2026-08-28)_ Workstream 1's coverage floor starts at B0's measured
    74.6% CI aggregate and ratchets from there.
15. _(added 2026-08-28)_ Adopt an `authz-chokepoint` rule in
    `Server/invariants` only if B2-5's predicate inventory shows a mechanical
    shape. The rule was dropped once for lack of evidence; B2-5 produces it.
16. _(added 2026-08-28)_ Run the Docker smoke nightly on `dev`. The CI job is
    `main`-gated, so `dev` never proves the image.
17. _(added 2026-08-29)_ Workstreams 4–9 execute from
    [developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md),
    Phases 1–3 and its "First actionable slice": the database-call and
    lifecycle inventory first (Phase 1 is this phase's entry-gate item 3),
    then the authentication route→service→storage slice (`S-10`) as the HP-3
    subject, then `internal/app/` lifecycle extraction and the in-package `ws`
    split. Keep `ws` one package while its lock invariants need shared private
    state; keep `main.go` the `go build .` entry. That plan's Phase 8
    exact-SHA matrix is the evidence checklist for every structural change
    here. Its Phase 7 change map lands its server rows in B3.

### Hold point HP-3 — First vertical-slice review

Complete one domain extraction from route through service, storage, tests, and
documentation. Confirm that it reduces coupling without weakening B2 contracts
before repeating the pattern.

### Exit gate

- Every direct database use above the domain layer is justified or removed.
- Required hub wiring cannot be omitted after construction.
- Permission rules have one production implementation per security property.
- Start, stop, drain, and failure ownership is explicit and tested.
- Race, deadlock, compatibility, fuzz seeds, model simulation, coverage, and
  load baselines remain green.
- No measured regression exists outside a recorded tradeoff accepted at HP-3.

### Required evidence

- boundary and database-call inventory with dispositions;
- before/after dependency graph for each extraction;
- coverage, benchmark, race, deadlock, fuzz, and model-test reports;
- lifecycle failure-injection report;
- generated-contract drift check.

### Safe parallelism

Guardrail tooling and baseline measurement may run while the first vertical
slice is prepared. After HP-3, unrelated domain families may proceed in
parallel only when they do not share schema migrations, permission predicates,
or hub lifecycle ownership.

## B4 — Complete identity, recovery, privacy, and data lifecycle

**Objective:** make local accounts and stored data recoverable, revocable,
retained, and erasable without central services or misleading privacy claims.

**Primary requirements:** BPR-041 through BPR-046 and BPR-052 through BPR-055.

### Entry gate

- B3 domain, database, audit, and lifecycle boundaries are established.
- Backup/restore fixtures and representative alpha data are captured.
- Destructive operations have private threat and failure models.

### Workstreams

1. Implement invite-only default registration with explicit approval-based and
   open modes.
2. Require authentication for messages, files, calls, and moderation; keep
   anonymous guest access absent.
3. Keep email optional and SMTP nonessential for registration or recovery.
4. Implement a locally generated recovery kit with only protected,
   non-reversible server-side verification material and one-time rotation.
5. Implement short-lived administrator-assisted recovery after local identity
   verification, with safe audit, affected-session revocation, and rate limits.
6. Preserve TOTP multi-factor authentication and emergency recovery codes as
   beta features. Optional SMTP recovery may be enabled, but no external
   service becomes an availability dependency. Prohibit security questions.
7. Expose device/session listing, new-login events, individual revocation, and
   sign-out-everywhere server contracts for later client consumption.
8. Implement atomic admission budgets for password confirmation and other
   expensive authentication work.
9. Implement complete account erasure for profile, credentials, sessions,
   messages, reactions, uploads, and other authored data.
10. Retain only unlinkable event category, time, action class, and integrity
    proof after cryptographically erasing the subject mapping. Preserve durable
    deletion markers sufficient to prevent backup resurrection.
11. Implement indefinite default message retention plus server/channel
    policies and attachment cleanup.
12. Keep diagnostics local, make support-bundle export user initiated, and
    prevent automatic product or usage telemetry.
13. _(added 2026-08-28)_ HP-4's destructive drills run against the B3
    alpha-shaped dataset, not ad-hoc copies.
14. _(added 2026-08-28)_ OC-0321 is a must-close: a TOTP key-file read error is
    treated as absence and the key is replaced. Data-loss class.
15. _(added 2026-08-28)_ Workstream 7 is smaller than written: per-session
    listing and individual revocation already exist server-side. B4 adds the
    new-login event and sign-out-everywhere only.

### Hold point HP-4 — Irreversible-data review

Before enabling deletion or retention cleanup, review migration, transaction,
backup, restore, interrupted-operation, disk-full, and legal/operator wording.
Run the destructive tests against disposable copies of real-shaped alpha data.

### Exit gate

- All registration modes enforce their documented default and transitions.
- Recovery works without SMTP, rotates secrets, revokes sessions, rate-limits
  attempts, and produces content-free audit evidence.
- Multi-device session contracts list and revoke only the correct account's
  devices.
- Deletion removes every required data class and backup restore cannot
  resurrect the account.
- Retention removes messages and attachments consistently without bypassing
  legal/operator holds if such a mechanism is explicitly introduced.
- Support bundles are user initiated, reviewed for secrets, and no automatic
  telemetry traffic occurs. _Amended 2026-09-02 (B4 owner decision 10): B4
  delivers the no-telemetry proof and the support-bundle data contract —
  user initiation and secret review as binding rules; the bundle export
  itself, and the runtime evidence that it obeys those rules, complete at
  B6/B9 under BG-15, where this bullet's bundle half is re-checked._
- Alpha-shaped data migrates forward and rolls back according to the declared
  boundary.

### Required evidence

- registration-mode state tests;
- recovery abuse, replay, concurrency, and restart tests;
- session inventory/revocation integration tests;
- deletion data-lineage checklist and post-restore proof;
- retention clock/attachment cleanup tests;
- network capture demonstrating no automatic telemetry;
- migration and rollback rehearsal report.

### Safe parallelism

Registration/session work and local-diagnostics work may proceed in parallel.
Recovery, deletion, and retention share schema and audit concerns and are
serialized until HP-4 fixes their data contracts.

## B5 — Add community, content, and moderation services

**Objective:** complete the server-side services needed for safe community
operation before building their full cross-client experience.

**Primary requirements:** BPR-060 through BPR-063 and BPR-070 through BPR-073.

### Entry gate

- B4 identity, audit, deletion, retention, and session behavior is stable.
- Canonical permission predicates and bounded-work primitives exist.
- Abuse cases and data ownership for each service are documented.

### Workstreams

1. Implement a Message Requests state machine for first contact: pending,
   safely previewed, accepted, ignored, deleted, or blocked. Acceptance creates
   a server-local trusted-sender relationship.
2. Retain and polish the existing link-preview, GIF-search, YouTube/media
   embed, and rich-content set behind privacy-preserving bounded retrieval.
   Provider expansion is optional and otherwise post-beta.
3. Enforce redirect, resolved-address, type, size, duration, streaming,
   concurrency, cache, and offline policies for every external fetch. Avoid
   residual full-body buffering.
4. Add durable upload/storage quotas, reserved disk headroom, cleanup, and
   operator-visible pressure behavior.
5. Enforce NSFW labels and per-user acknowledgement server-side. Do not return
   or fetch concealed third-party media before consent.
6. Implement local report intake for messages, users, and attachments with
   evidence snapshots, surrounding-context rules, assignment, status, internal
   notes, action links, retention, and immutable audit history.
7. Implement narrowly permissioned warning, timeout, removal, kick, and ban.
   Keep TLS, backup, update, and other operator controls owner-only.
8. Implement rate-limited appeals, status transitions, moderator decisions,
   user-visible status, and audit.
9. Implement per-server Web Push subscription storage and dispatch plumbing
   with owner enablement, user consent, generic-content defaults, VAPID
   rotation, and stale-subscription cleanup. There is no OwnCord relay.
10. Keep automation optional. Human moderation authority and audit remain core
    even if automation becomes a post-beta plugin candidate.
11. _(added 2026-08-28; re-tagged here by B2-9 on 2026-08-29)_ SEC-03 (bounded
    per-response and aggregate preview/media reads) is first in line. It is P1
    and confirmed. Shape: the C-09 contract in `docs/trust-model.md` clause 6
    (time, streaming byte ceiling, content-type list, concurrency cap) plus
    aggregate budgets and byte-weighted cache eviction; implement the byte
    accounting once, at the boundary B7's native broker will own.

### Hold point HP-5 — Abuse and privacy review

Review spam, block bypass, malicious previews, private-address resolution,
redirects, decompression, oversized streams, storage exhaustion, report
confidentiality, moderator privilege, appeal abuse, and notification leakage
before exposing the endpoints.

### Exit gate

- Message Requests cannot bypass block, permission, retention, or deletion
  rules.
- External retrieval passes address, redirect, streaming-size, timeout,
  concurrency, media-type, and offline adversarial tests.
- NSFW content and third-party fetches remain unavailable before consent.
- Report, moderation, and appeal state machines enforce least privilege and
  immutable safe audit.
- Storage quotas and disk headroom fail safely under concurrency and restart.
- Push subscriptions are per server/device, opt-in, revocable, and contain no
  sensitive default payload.
- No unresolved B5 security advisory remains.

### Required evidence

- state-machine and property tests for requests, reports, actions, and appeals;
- private safe-fetch and quota security validation;
- storage-pressure and cleanup tests;
- role/permission matrix;
- push endpoint and subscription lifecycle tests;
- retention/deletion integration for every new data class.

### Safe parallelism

Message Requests, moderation, and content retrieval may be separate teams only
after shared permission, audit, rate-limit, and retention interfaces are
frozen. Push storage may proceed independently but dispatch waits for those
privacy defaults.

## B6 — Qualify server deployment, operations, and capacity

**Objective:** prove an owner can securely deploy, upgrade, recover, and
operate the completed server on every supported mode without an OwnCord
service.

**Primary requirements:** BPR-011 through BPR-016 and BPR-030.

### Entry gate

- Server behavior through B5 is feature-complete for beta.
- Configuration, migration, storage, and release contracts are frozen.
- Representative domain, public-IP, LAN, offline, and failure test
  environments are available.

### Workstreams

1. Build and smoke Windows x64/ARM64 executables and Linux x64/ARM64 archives
   as fully tested standalone release assets.
2. Publish and smoke Docker images for linux/amd64 and linux/arm64 with
   persistent-data, health, migration, graceful-drain, and minimal-privilege
   behavior.
3. Implement owner-friendly HTTPS/WSS modes:
   - public domain with automatic ACME;
   - stable public IPv4/IPv6 with an eligible public-CA flow;
   - private LAN/offline with an OwnCord local CA and explicit device trust;
   - manual certificate mode for advanced owners.
4. Keep reverse proxies optional. Validate direct port-forwarded operation and
   document blocked-port, CGNAT, hairpin-NAT, dynamic-IP, and firewall limits
   honestly.
5. Protect certificate/account keys, persist renewal state, hot-reload
   certificates, renew with ample margin, and exercise expiry/rotation.
6. Add the disabled-by-default optional browser-hosting switch and stable
   origin/path contract. B8 supplies the final signed client bundle.
7. Rehearse alpha-to-beta database, attachment, configuration, credential, and
   backup upgrade/rollback on Docker and standalone deployments.
8. Publish hardware-specific measurements proving at least 250 registered
   users, 100 simultaneous connections, and 25 concurrent voice participants.
9. Measure reconnect storms, database waits, message fan-out, voice control,
   upload/download pressure, TLS overhead, and graceful shutdown.
10. Exercise backup/restore, deletion-marker restore, disk-full, low-headroom,
    corrupt input, unhealthy dependency, interrupted migration, and rollback.
11. Pin or automatically review containers and build inputs; produce signed
    SBOM, provenance, checksums, and source-snapshot evidence.
12. Document local logs, support-bundle generation, capacity limits, ports,
    storage growth, certificate trust, recovery, updates, and safe failure.
13. _(added 2026-08-28)_ Must-close before any ARM64 server asset ships:
    OC-0320 (self-update selects linux-amd64 regardless of architecture),
    OC-0332 (a bare IPv6 address breaks the updater URL), OC-0344 (the
    HTTP→HTTPS redirect assumes port 443) and OC-0339 (an empty configuration
    section is reported as unknown).
14. _(added 2026-08-28)_ The 250/100/25 run starts from
    `Server/scripts/k6/ws-load.js`. k6 cannot drive voice; a 25-participant
    LiveKit load harness is a real gap and needs a named owner before HP-6.
15. _(added 2026-08-28)_ R-09: the exact-SHA gate already runs at tag time
    (the `gate-evidence` job in `release.yml`, B1-7); `environment: release`
    lands in B2-0. B6 rehearses one tag against both before HP-6.
16. _(added 2026-08-28; amended 2026-08-31)_ Add `GET /api/v1/server-info`
    with the browser-hosting flag alongside workstream 6's default-off
    hosting switch, so one endpoint answers "what is this server, and is
    the browser client on". B2-2's slim decision (2026-08-29) dropped the
    endpoint from B2 — this workstream introduces it, it does not extend it.

Public IP certificates are feasible only for eligible stable public addresses
and currently require short-lived certificate handling. Private or reserved IP
addresses cannot receive public-CA certificates, so LAN/offline mode needs
explicit local trust. Implementation and test plans must follow the current
[Let's Encrypt IP certificate guidance](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability),
[ACME challenge guidance](https://letsencrypt.org/docs/challenge-types/), and
[CA/B Forum requirements](https://cabforum.org/working-groups/server/baseline-requirements/requirements/).

### Hold point HP-6 — Operator and capacity acceptance

An owner unfamiliar with the code must deploy each mode from current
documentation, understand unavoidable network/trust limitations, recover a
backup, rotate trust, and interpret failure. The reference load profile must
meet its budgets on stated hardware before client expansion begins.

### Exit gate

- Every server artifact installs or starts, migrates, becomes healthy, serves
  WSS/API traffic, drains, restarts, and restores data.
- Domain, public-IP, LAN, and offline TLS modes pass their owned matrix.
- Direct port forwarding works where the network permits it; limitations are
  actionable and never disguised as application success.
- Browser hosting is disabled by default and cannot accidentally expose an
  incomplete bundle.
- The 250/100/25 profile is met with published hardware, configuration, p95/p99
  latency, resource, and failure measurements.
- Backup/restore, disk pressure, certificate rotation, update, and rollback
  drills pass.
- Release inputs and outputs are traceable and signed.

### Required evidence

- artifact and container install/boot matrix;
- ACME staging, public-IP, local-CA, expiry, and rotation reports;
- network-mode integration matrix;
- load-test dataset and reproducible commands;
- upgrade/rollback/restore drill;
- SBOM, provenance, signatures, checksums, and source snapshot;
- operator usability record.

### Safe parallelism

Packaging, TLS modes, capacity measurement, failure drills, and supply-chain
work can proceed in parallel after configuration and storage contracts freeze.
The same release candidate and data fixtures must be used before HP-6 closes.

## B7 — Establish the shared client platform and desktop parity

**Objective:** move desktop behavior behind explicit platform contracts,
strengthen client architecture, and consume the completed server services
without regressing the current application.

**Primary requirements:** BPR-033 through BPR-035.

### Entry gate

- The complete beta server is stable through B6.
- Generated protocol and compatibility fixtures are available to clients.
- Desktop behavior, bundle, startup, memory, and test baselines are recorded.

### Workstreams

1. Define typed contracts for HTTP, WebSocket, credentials, profiles,
   notifications, media, LiveKit, update, logs, filesystem, and window
   behavior.
2. Move native Tauri use behind the desktop adapter one responsibility at a
   time. Add contract tests before implementing browser adapters.
3. Split target-neutral Vite configuration from desktop packaging and create
   explicit desktop and web compile gates from one source tree.
4. Clear the 471-warning Oxlint baseline, unexplained Knip hints, unexpected
   test logs, and unjustified coverage exclusions. Ratchet all gates.
5. Add client startup, route, LiveKit, RNNoise, and feature bundle budgets.
   Dynamically load/cache optional voice processing outside startup paths.
6. Break production import cycles and decompose voice/session, E2EE, dispatcher,
   message, store, and large UI modules by ownership, not arbitrary line count.
7. Centralize timer/listener ownership and test teardown, reconnect,
   supersession, replay, ordering, and long-session memory.
8. Implement the server-led compatible-update notice and safe incompatible
   state.
9. Keep one active server connection while preserving isolated saved profiles
   and quick switching.
10. Add device/session list, new-login notice, individual revoke, and
    sign-out-everywhere UI.
11. Add desktop flows for registration modes, recovery, deletion, retention
    disclosure, and local support-bundle export.
12. Build and smoke Windows x64/ARM64 and Linux x64/ARM64 desktop artifacts,
    using native Windows ARM64 evidence and declared Linux ARM64 evidence.
13. _(added 2026-08-28)_ Delete the two Rust commands nothing invokes,
    `probe_credential_store` and `ptt_get_key`
    ([platform-contracts.md](../architecture/platform-contracts.md)).
14. _(added 2026-08-28; amended 2026-08-31)_ Workstream 8 consumes B2's
    `protocol_epoch_unsupported` frame and the `GET /api/v1/server-info`
    endpoint B6 workstream 16 adds (B2-2 shipped without it); it defines no
    new contract.
15. _(added 2026-08-28)_ Re-run Stryker (C-16) before workstream 6 decomposes
    modules, so the mutation baseline is honest.
16. _(added 2026-08-29)_ Workstreams 1–3, 6 and 7 execute from
    [developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md),
    Phases 4–6: `platform/contracts` + `platform/desktop` first (the 20 native
    import sites move one responsibility at a time, contract tests before
    any browser adapter), then hotspot decomposition (`dispatcher.ts`,
    `livekitSession.ts`, `livekitE2EE.ts`, messaging, settings), with unit
    tests colocated as `src/**/*.test.ts` only for modules being extracted.
    `lib/` and `stores/` are transitional — shrink them, never bulk-move.
    Do not create `Client/src/platform/` before this phase's entry gate is
    met. The plan's Phase 7 change map lands its client rows here.

### Hold point HP-7 — Desktop parity before browser behavior

The desktop adapter must reproduce the existing app plus approved B2–B6 client
flows with no direct Tauri imports outside owned adapter/bootstrap files.
Review performance, accessibility foundations, and packaging before filling in
browser implementations.

### Exit gate

- One application compiles through explicit desktop and web contract surfaces.
- Native APIs are isolated and contract-tested.
- Required client checks are green with zero unapproved warnings and honest
  coverage.
- E2E exits unaided and teardown/leak tests pass.
- Compatible updates, incompatible-version failure, profile switching, and
  multi-device session management work end to end.
- Desktop artifacts pass install, boot, connect, update, rollback, media, and
  recovery smoke on the supported architecture matrix.
- Startup, bundle, voice-join, and long-session budgets meet or improve the
  accepted baseline.

### Required evidence

- adapter inventory and contract-test matrix;
- import-cycle and native-import checks;
- unit, browser-smoke, E2E, Rust, Clippy, build, and dependency reports;
- bundle manifest and runtime performance measurements;
- signed desktop artifact smoke matrix;
- server-version/session/recovery integration recordings.

### Safe parallelism

Test-gate cleanup and adapter contract design may proceed together. Adapter
migrations are serialized by responsibility. After the contracts stabilize,
UI flows for updates, profiles, sessions, and recovery may run in parallel.
Architecture extraction never shares a change with new feature behavior.

## B8 — Deliver browser, PWA, phone, and tablet support

**Objective:** implement the optional server-hosted browser client from the
shared application, with honest secure-context, offline, push, and mobile
behavior.

**Primary requirements:** BPR-020 through BPR-025.

### Entry gate

- HP-7 confirms desktop parity and stable platform contracts.
- B6 browser-hosting, TLS, and origin contracts are available.
- B5 push service and privacy defaults are available.

### Workstreams

1. Implement browser adapters for network, credential/session storage,
   notifications, media, LiveKit, logs, updates, and unsupported native
   capabilities.
2. Package the web application as a server-owned optional asset, disabled by
   default and served from one canonical HTTPS origin when enabled.
3. Add an installable manifest, icons, standalone presentation, update
   behavior, and a service worker scoped to application assets.
4. Do not cache API responses, credentials, message content, attachments, or
   moderator evidence unless a later reviewed design explicitly requires it.
5. Implement Web Push opt-in, per-device subscriptions, generic notification
   payloads, click routing, revocation, VAPID rotation, and stale-subscription
   cleanup without an OwnCord relay.
6. Design responsive phone and tablet navigation rather than merely hiding
   desktop sidebars. Cover touch targets, virtual keyboards, safe areas,
   orientation, zoom, and constrained media.
7. Handle secure-context requirements for service workers, media capture,
   screen sharing, and push. Provide local-CA onboarding, fingerprint,
   installation, rotation, and removal guidance for LAN/offline devices.
8. Make unsupported browser or OS behavior explicit and actionable.
9. Test current Chromium, Firefox, and WebKit engines in automation, then test
   real supported browsers/devices for release qualification.
10. Preserve one active server connection and per-server account/profile
    isolation.
11. _(added 2026-08-28)_ No certificate pinning in a browser. Workstream 7's
    LAN/offline path uses publicly trusted or local-CA certificates only —
    never a TOFU shim ([platform-contracts.md](../architecture/platform-contracts.md),
    hard case one).
12. _(added 2026-08-28; amended 2026-08-31)_ The browser client reads
    `GET /api/v1/server-info` (endpoint and flag from B6 workstream 16 —
    B2-2 shipped without it) for the hosting flag and epoch; no separate
    discovery endpoint.

Service workers, camera/microphone, Web Push, and screen capture require secure
contexts in normal browser use. The plan follows the relevant
[Secure Contexts](https://www.w3.org/TR/secure-contexts/),
[Service Workers](https://www.w3.org/TR/service-workers/),
[Media Capture](https://www.w3.org/TR/mediacapture-streams/),
[Push API](https://www.w3.org/TR/push-api/), and
[Screen Capture](https://www.w3.org/TR/screen-capture/) standards. Automated
WebKit coverage is useful but does not replace real Safari/iPhone/iPad
qualification.

### Hold point HP-8 — Browser/mobile preview acceptance

Run an owner-enabled preview on desktop browser, Android phone/tablet, and
iPhone/iPad. Confirm installation, navigation, auth, media, push availability,
offline state, local trust, update, and disable/removal behavior before
declaring browser parity.

### Exit gate

- Browser hosting remains unavailable until an owner explicitly enables it.
- Desktop/browser share domain behavior and protocol contracts; divergence is
  limited to documented API constraints.
- PWA installation, asset update, cache invalidation, and offline fallback are
  safe.
- Phone/tablet workflows remain usable with touch, virtual keyboard, safe
  areas, rotation, zoom, and constrained media.
- Push requires owner and user opt-in, uses no OwnCord relay, and degrades
  honestly where unavailable or offline.
- Secure-context and LAN trust onboarding is actionable.
- Chromium, Firefox, WebKit automation and real-device qualification are green
  for the declared support matrix.

### Required evidence

- web build and server-host toggle tests;
- manifest/service-worker/cache inspection;
- push subscription, payload, revocation, and cleanup tests;
- browser engine and real-device matrix;
- responsive screenshots plus keyboard/touch/screen-reader records;
- secure-context, local-CA, offline, and update tests.

### Safe parallelism

Service-worker/PWA work, responsive layout foundations, push client work, and
browser media adapters may proceed in parallel after shared adapter and origin
contracts freeze. Final cache, permission, and navigation integration is
serialized before HP-8.

## B9 — Complete unified feature UX, accessibility, and polish

**Objective:** expose every approved server capability consistently across
desktop, browser, PWA, phone, and tablet while preserving OwnCord's identity.

**Primary requirements:** BPR-064 and BPR-090 through BPR-092. B9 also closes
the client experience for BPR-060 through BPR-063 and BPR-070 through BPR-073.

### Entry gate

- Desktop and browser platform matrices are green.
- B5 service contracts are stable and security-reviewed.
- Design tokens, interaction patterns, and accessibility test rules are agreed.

### Workstreams

1. Add the Message Requests inbox with safe preview, accept, ignore, delete,
   and block behavior.
2. Polish link previews, GIF search, YouTube/media embeds, and external-content
   consent/loading/error behavior across network modes.
3. Replace the current NSFW concealment-only behavior with a gate that prevents
   content and third-party fetch before acknowledgement.
4. Add a permission-gated Moderation Center for report queue, evidence/context,
   assignment, status, notes, actions, audit history, and appeal handling.
5. Add warning, timeout, removal, kick, ban, and appeal status experiences that
   reveal only authorized information.
6. Organize English UI text behind translation-ready boundaries without
   promising another beta language.
7. Preserve recognizable OwnCord navigation and visual identity while
   rationalizing spacing, states, feedback, responsive behavior, and
   performance.
8. Treat accessibility as a blocking property: keyboard, pointer, touch,
   screen reader, focus, contrast, reduced motion, zoom, reflow, announcements,
   errors, virtual keyboard, and media controls.
9. Clearly label desktop-only features, unsupported browser APIs, offline
   state, notification limitations, update state, and degraded media.
10. Run privacy, moderation, deletion, retention, block, session, and
    compatibility journeys across every client surface.
11. _(added 2026-08-29)_ Workstream 7's `app.css` split follows
    [developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md),
    Phase 5 item 6: move source sections into owned files with selectors and
    built output preserved. Visual changes are separate changes with visual
    and accessibility evidence, never mixed into the source split.

### Hold point HP-9 — Feature freeze and accessibility acceptance

No new beta feature enters after this point. Review every requirement journey
on all applicable surfaces, triage every accessibility defect, and freeze
strings, protocol, migrations, and user-visible behavior for the release
candidate.

### Exit gate

- Every approved feature has end-to-end desktop and browser evidence, with
  documented browser exceptions.
- Message Requests, moderation, appeals, NSFW consent, and external content
  preserve server security and privacy rules.
- Accessibility tests and manual assistive-technology checks have no release
  blocker.
- Phone/tablet layouts expose all required navigation and actions.
- English strings are centralized/structured for later translation.
- No UI claims unsupported offline, media, push, update, or network behavior.
- Performance budgets and OwnCord visual identity are preserved.

### Required evidence

- requirement-journey matrix and recordings;
- automated accessibility reports and manual keyboard/screen-reader/touch
  checklist;
- visual regression and responsive evidence;
- privacy/network inspection for consent-gated content;
- moderation role matrix and audit walkthrough;
- translation-readiness scan and bundle/performance report.

### Safe parallelism

Message Requests, moderation UX, content/NSFW UX, and translation extraction
may proceed in parallel behind stable B5 contracts. Accessibility reviewers
work continuously across all streams. Shared navigation, design tokens, and
global state changes are serialized.

## B10 — Qualify and publish the public beta

**Objective:** prove one immutable release candidate satisfies the complete
product, security, platform, upgrade, operations, and community contract before
publishing it on GitHub.

**Primary requirements:** BPR-001, BPR-004, BPR-005, and BPR-010. B10
re-verifies every BPR.

### Entry gate

- HP-9 freezes features, protocol, migrations, and strings.
- All B0–B9 exit gates are green.
- One release-candidate commit and version are selected.
- No unresolved security advisory or unverified release blocker exists.

### Qualification work

1. Run the complete required matrix on the exact release-candidate SHA.
2. Require 30 consecutive green integration runs, excluding only documented
   external infrastructure cancellations.
3. Hold a 14-day release-candidate soak with long sessions, reconnects,
   upgrades, restarts, media, push, retention, deletion, moderation, and
   operator review.
4. Test in-place upgrade from representative 1.2.0-alpha data, attachments,
   configuration, credentials, and client settings, plus rollback within the
   declared boundary.
5. Re-run the accepted protocol epochs plus actionable out-of-window
   rejection — the slim scope of the 2026-08-29 B2-2 decision (BPR-032 as
   amended 2026-08-31); the matrix widens only if a later epoch bump
   reintroduces a window.
6. Re-run the full Windows x64/ARM64 and Linux x64/ARM64 desktop matrix, server
   artifacts, multi-architecture Docker, browser engines, Android
   phone/tablet, and iPhone/iPad matrix.
7. Re-run domain, public-IP, LAN, offline, optional browser hosting, PWA,
   Web Push, backup/restore, disk-full, certificate rotation, and update
   scenarios.
8. Reproduce the 250/100/25 reference capacity profile and compare it with B6.
9. Confirm zero open P0/P1 defect, zero unresolved advisory, and explicit
   owner/rationale/review trigger for every accepted lower risk.
10. Verify release version agreement, source snapshot, licenses, SBOM,
    provenance, checksums, signatures, update manifests, cold boot, install,
    update, rollback, and download.
11. Verify public setup, security, privacy, operator, recovery, moderation,
    accessibility, support, feedback, and contribution documentation.
12. Prepare safe release notes and coordinated fixed-vulnerability disclosure.
    Do not publish private exploit material by default.
13. _(added 2026-08-28)_ `ci.yml` cancels in-progress runs on every ref,
    `main` included, so item 2's thirty consecutive runs cannot be counted as
    written. Exempt `main` from `cancel-in-progress` before the count starts.
14. _(added 2026-08-28)_ The 14-day soak runs on named hosts: the owner's LAN
    self-hosted instance and one Docker instance.
15. _(added 2026-08-31)_ Record BPR-051's non-developer comprehension read on
    the R-08 release scorecard: a non-developer reads `docs/trust-model.md`
    §"The short answer" and their answer to "who can read my messages?" fills
    the HP-2 Q3 blanks (and the B2-7 evidence block — both must agree).
    Owner decision 2026-08-31: tracked as a release-gate row so a missing
    reader blocks the beta, not B3–B9 work.

### Hold point HP-10 — Human go/no-go

The owner reviews one final scorecard. Publication is allowed only when every
required artifact points to the same commit, all evidence is green, the private
security queue is empty, and rollback is rehearsed. A known blocker means
no-go, regardless of elapsed time.

### Exit gate

- The exact release candidate passes all phase and requirement evidence.
- Thirty consecutive integration runs and the 14-day soak are green.
- Zero P0/P1 and zero unresolved security advisory remain.
- All supported artifacts install, start, connect, update, roll back, and
  verify.
- Upgrade preserves required server data and client settings.
- Capacity, performance, accessibility, privacy, deletion, recovery,
  moderation, browser/PWA, and operations budgets pass.
- GitHub release assets, source, metadata, checksums, signatures, SBOM, and
  provenance agree.
- Public documentation and community intake are ready.

### Required evidence

- immutable release scorecard linked to the exact commit and tag;
- integration-run history and 14-day soak log;
- complete platform/deployment/device matrix;
- migration, rollback, restore, and deletion proof;
- security closure attestations;
- signed artifact and metadata verification;
- anonymous download/install smoke;
- final requirements traceability export with no missing or failed row.

### Safe parallelism

Platform, deployment, browser/device, capacity, accessibility, and
documentation qualification may run in parallel against the same immutable
candidate. Tagging and publication are serialized after HP-10.

## Safe parallelism summary

| Phase | Work that may overlap                                                  | Work that stays serialized                                              |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| B0    | Read-only validation, requirement mapping, independent security review | Shared test-infrastructure fixes and baseline acceptance                |
| B1    | Docs, command design, artifact investigation, community templates      | Each move/rename and its full verification                              |
| B2    | Fixtures, threat review, plugin inventory, dependency audit            | Protocol, permission, and E2EE production changes                       |
| B3    | Guardrail tooling and measurement                                      | First vertical slice; shared schema/lifecycle/permission work           |
| B4    | Registration/session and local diagnostics                             | Recovery, deletion, retention data contracts until HP-4                 |
| B5    | Requests, moderation, content, and push after shared contracts         | Shared authz/audit/rate-limit/retention integration                     |
| B6    | Packaging, TLS, load, failure drills, supply chain                     | Final candidate convergence and operator acceptance                     |
| B7    | Gate cleanup and contract design; later independent UI flows           | Adapter moves and architecture extractions                              |
| B8    | PWA, responsive, push, and media adapters after contracts              | Final cache/permission/navigation integration                           |
| B9    | Feature UIs behind stable services                                     | Navigation, design tokens, global state, final accessibility acceptance |
| B10   | Qualification lanes on one immutable candidate                         | Tag, publication, and coordinated disclosure                            |

Preparation for the next phase may include design notes, fixtures, and
non-mutating research. It may not merge production behavior before the current
exit gate.

## Release-blocker policy

- P0: a required gate is red, the integration is not safely releasable, or an
  active compromise/data-loss/release-integrity failure exists. Stop work that
  could obscure the cause; remediate security-sensitive cases privately.
- P1: supported-path security, correctness, privacy, compatibility,
  accessibility, install, upgrade, or operations failure. Must close before the
  owning phase exits.
- P2: material quality or maintainability risk. Must be fixed in its planned
  phase or accepted explicitly with owner, rationale, review date, and trigger.
- P3: nonblocking improvement. May move post-beta only when it does not violate
  a frozen requirement or permanent quality ratchet.

New P0/P1 discoveries enter the active phase immediately. Other new feature
ideas remain post-beta unless they are required for security, correctness,
accessibility, platform parity, or completion of an approved requirement.

## Phase scorecard

Every hold point and phase exit records at least:

| Metric                         |                     Baseline |          Target | Actual | Exact evidence |
| ------------------------------ | ---------------------------: | --------------: | -----: | -------------- |
| Required checks green          |                refresh in B0 |            100% |        |                |
| Open P0 / P1                   |                refresh in B0 |           0 / 0 |        |                |
| Unresolved security advisories |                private count |               0 |        |                |
| Requirement rows passing       |            0 fully qualified | 100% applicable |        |                |
| Server aggregate/core coverage |              74.6% aggregate |         ratchet |        |                |
| Client honest coverage         |                refresh in B0 |         ratchet |        |                |
| Static-analysis warnings       |                   471 Oxlint |    0 unapproved |        |                |
| Unit/browser/E2E/Rust          | two unit failures; E2E hangs | green and exits |        |                |
| Largest startup/lazy chunks    |                refresh in B0 |          budget |        |                |
| Desktop/browser/device matrix  |                   incomplete |  100% supported |        |                |
| Server 250/100/25 profile      |                     unproven |             met |        |                |
| Upgrade/rollback/restore       |                     unproven |           green |        |                |
| Generated/doc drift            |                refresh in B0 |               0 |        |                |

The actual values and links belong in phase evidence, not as optimistic edits
to this plan.

## Current implementation slice

_Updated 2026-08-29._ B0 and B1 are complete (HP-0 accepted 2026-08-25, HP-1
accepted 2026-08-27). The active slice is B2, executed from
[b2-protocol-trust-compat-2026-08-28.md](b2-protocol-trust-compat-2026-08-28.md)
in this order:

1. B2-0 — alpha.4 verified, `dev` synced with `main`, release hygiene, `dev`
   set to `strict: true` — **done 2026-08-28**;
2. B2-1 — epoch-1 fixtures captured **before** any protocol change — **done
   2026-08-28**;
3. B2-8 — the B2-tagged findings, because they touch the same replay/resume
   files as B2-2 — **done 2026-08-28**;
4. B2-2 — protocol epoch and negotiation, with B2-3 and B2-4 folded in
   (one accepted epoch, so no matrix) — **done 2026-08-29**, PR #1438 =
   `9c9b8be6`;
5. B2-5 (PR #1440 = `67fdd18d`), B2-6 (PR #1441 = `2b2d58ab`), B2-7
   (PR #1443 = `88c7a824`) and B2-9 — **done 2026-08-29**;
6. HP-2 — **accepted 2026-08-29**
   ([hp-2-scorecard-2026-08-29.md](hp-2-scorecard-2026-08-29.md)); B2 is
   closed;
7. B3 — **started 2026-08-29**, execution plan
   [b3-server-architecture-guardrails-2026-08-29.md](b3-server-architecture-guardrails-2026-08-29.md);
   B3-0 (boundary inventory) is the first step, then the auth slice to HP-3.

Do not begin B3 domain extraction, client platform extraction, or browser work
before HP-2 closes. When it does, B3 opens with the "First actionable slice"
of
[developer-experience-layout-refactor-2026-08-29.md](developer-experience-layout-refactor-2026-08-29.md):
inventory, before-state graph, auth characterization tests, the auth vertical
slice, HP-3. Nothing from that plan touches the client before B7.

The original 2026-08-23 slice (B0 only, then B1 as isolated changes) was
executed as written; see
[b0-baseline-2026-08-25.md](b0-baseline-2026-08-25.md) and
[b1-repository-foundation-2026-08-25.md](b1-repository-foundation-2026-08-25.md).
