# Developer-experience and component-layout refactor plan

**Status:** Draft, scheduled; not started as of 2026-08-29  
**Measured against:** `068b5ff6` (`feat/b2-2-protocol-epoch`)  
**Current sequencing:** B2-2 merged to `dev` 2026-08-29 (PR #1438 =
`9c9b8be6`, B2-3 and B2-4 folded in); B2-5 is next; no work in this plan
starts before HP-2  
**Phase ownership:** server work executes in B3 (roadmap workstream 17); client
platform and layout work executes in B7 (workstream 16), with the CSS source
split in B9 (workstream 11)  
**Authority:** this is an implementation supplement. The
[repository-health roadmap](repo-health-roadmap-2026-08-23.md) remains the
authority for phase order, entry gates, hold points, and release status.

## Decision

OwnCord should refactor its internal server and client responsibilities, but it
should not perform another top-level repository reorganization.

The B1 repository-foundation work already resolved the broad layout and
onboarding problems: the client is flattened under `Client/`, cross-component
protocol ownership lives under `protocol/`, active documentation is indexed,
and root commands expose bootstrap, scoped checks, generation, formatting, and
release preflight. Keep the current top-level `Client/`, `Server/`, `protocol/`,
`deploy/`, `docs/`, `scripts/`, and `tools/` boundaries.

The remaining friction is inside the two application components:

- server transports, application lifecycle, persistence, and domain decisions
  are coupled across large packages and files;
- the client has outgrown the broad `lib/components/pages/stores` split and
  lacks the already-designed desktop/browser platform seam;
- high-change code and its unit tests are often far apart;
- several files own multiple unrelated reasons to change.

This plan uses incremental responsibility extraction, dependency rules, and
vertical slices. It explicitly rejects a wholesale rewrite, arbitrary
line-count splitting, and a big-bang feature-folder migration.

## Outcomes

The refactor succeeds when a new contributor can:

1. find the correct server or client responsibility without tracing unrelated
   orchestration code;
2. identify the owning tests next to, or clearly indexed from, the code;
3. run a focused local check and the correct stack-level gate without guessing
   directories;
4. add a REST endpoint, WebSocket behavior, client feature, or native capability
   through one documented dependency path;
5. understand which files are generated and which command regenerates them;
6. make changes without accidentally coupling domain behavior to HTTP,
   WebSocket, database, Tauri, or browser implementation details.

## Non-goals

- Rename `Client/` or `Server/` for casing or style.
- Introduce a new monorepo framework or require Node for Go-only work.
- Move all server packages under `internal/` for appearance alone.
- Replace the existing Go service and storage layers wholesale.
- Fork desktop and browser into separate applications.
- Move all existing client unit tests in one mechanical migration.
- Change release asset names, updater contracts, protocol behavior, or generated
  file ownership as a side effect of layout work.
- Mix product features, security fixes, file moves, and architecture extraction
  in the same change.

## Current-state evidence

### Repository foundations to preserve

- Root `package.json` exposes `bootstrap`, full and scoped checks, formatting,
  generation, and release preflight through `scripts/run.mjs`.
- `CONTRIBUTING.md`, `docs/contributing.md`, `docs/README.md`, and the component
  `CLAUDE.md` files provide discoverable contributor entry points.
- `Server/CLAUDE.md` documents the current Go package responsibilities and the
  required default, `otel`, `wazero`, race, and deadlock variants.
- `Client/CLAUDE.md` documents the single WebSocket-to-store dispatch invariant,
  Tauri constraints, test tiers, and generated-code boundaries.
- `protocol/schema.json` owns generated Go and TypeScript protocol constants.
- Client Vitest already includes both `tests/**/*.test.ts` and colocated
  `src/**/*.test.ts`, so gradual test colocation needs no new runner.

### Server pressure points

Tracked production Go files currently cluster as follows:

| Package   | Production files | Approximate production lines | Observation                                                                                                                    |
| --------- | ---------------: | ---------------------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| `ws`      |               45 |                       11,700 | Hub, connection, replay, broadcast, voice, persistence, and permission behavior share one package.                             |
| `db`      |               32 |                        6,700 | Hand-written persistence and generated sqlc ownership are correctly separated, but many upper layers still import it directly. |
| `api`     |               20 |                        6,400 | HTTP handlers still own persistence and domain decisions in several families.                                                  |
| `admin`   |               19 |                        4,300 | Admin transport/UI handling frequently reaches directly into persistence.                                                      |
| `service` |               18 |                        4,200 | A useful domain seam exists, but it does not yet own all use cases.                                                            |

Additional evidence:

- 44 production files across `ws`, `admin`, and `api` directly import `db`:
  17, 16, and 11 respectively.
- `Server/main.go` exceeds 1,000 physical lines and owns configuration, data
  preparation, database initialization, telemetry, plugins, event persistence,
  auditing, maintenance, HTTP serving, shutdown, health checks, and replay
  seeding.
- `ws/hub_broadcast.go`, `ws/serve.go`, and `ws/hub.go` are large coordination
  hotspots where locking, ordering, replay, visibility, and lifecycle behavior
  intersect.
- The existing issue register already assigns direct database ownership,
  lifecycle/hub extraction, constructor completeness, and canonical permission
  predicates to B3 (`S-08` through `S-12`).

### Client pressure points

Tracked TypeScript and CSS currently cluster as follows:

| Area             | Files | Approximate lines | Observation                                                                                                                   |
| ---------------- | ----: | ----------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/components` |    60 |            18,400 | Shared UI, feature UI, orchestration, and native-facing behavior are mixed.                                                   |
| `src/lib`        |    63 |            15,400 | The name has become a catch-all for transport, voice, E2EE, profiles, native APIs, validation, and application orchestration. |
| `src/styles`     |     5 |             7,400 | `app.css` alone exceeds 5,600 physical lines and contains many feature-specific sections.                                     |
| `src/pages`      |    19 |             5,900 | Page files and partial page subfolders show useful decomposition already in progress.                                         |
| `src/stores`     |     9 |             2,900 | Stores are broadly imported by components, pages, and library modules.                                                        |

Additional evidence:

- Production source contains approximately 405 `@lib/*`, 146 `@stores/*`, and
  88 `@components/*` import references.
- 20 production frontend files import `@tauri-apps/*`; the planned
  `src/platform/` seam does not exist yet.
- Major responsibility hotspots include `livekitSession.ts`, `livekitE2EE.ts`,
  `dispatcher.ts`, `MessageList.ts`, `AccountTab.ts`, `MainPage.ts`, and
  `app.css`.
- 190 ordinary unit-test files live under `tests/unit`. This makes test tiers
  obvious, but it often separates a module from the fastest explanation of its
  behavior.
- Existing findings `C-11` and `C-12` already assign import-cycle removal and
  cohesive hotspot extraction to B7/B9.

## Architecture standards

### General change discipline

1. Separate pure moves, path rewrites, dependency changes, behavior changes,
   and generated output into reviewable commits.
2. Extract by responsibility and dependency direction, not by a maximum line
   count.
3. Introduce and test a seam before moving callers through it.
4. Migrate one server domain family or one client platform capability per pull
   request.
5. Preserve behavior with characterization, contract, race, deadlock, mutation,
   browser, and end-to-end tests as appropriate to the boundary.
6. Add a static rule for a boundary before relying on documentation alone.
7. Prefer explicit names over generic `utils`, `common`, `helpers`, `manager`,
   or repository-wide `interfaces` packages.
8. Define narrow interfaces beside their consumers. Do not build one shared
   interface catalog.
9. Keep generated sources committed and generated from their documented source
   of truth; never hand-edit generated consumers.

### Server dependency direction

Target dependency flow:

```text
main / internal/app
        |
        v
api / admin / ws transports
        |
        v
service use cases and consumer-owned interfaces
        |
        v
db and other infrastructure adapters
```

Rules:

- `api`, `admin`, and WebSocket message handlers translate transport input and
  output; they do not decide reusable domain policy.
- Services own application use cases, authorization orchestration, transaction
  intent, and stable domain error mapping.
- Persistence packages implement narrow service-owned needs. Direct database
  access above services must be classified as an explicit transaction,
  composition, migration, or transport-adapter exception.
- `main.go` remains the compatible `go build .` entry point but becomes a thin
  composition root.
- `internal/app/` may own construction, start, drain, stop, maintenance, and
  composite cleanup because those responsibilities are application-private.
- Keep `ws` as one package while its locking invariants require shared private
  state. First split responsibilities into clearly named files; create
  subpackages only when doing so does not force exports or introduce cycles.

### Client dependency direction

Target dependency flow:

```text
app -> features -> shared
 |         |
 +---------+----> platform/contracts
                         ^
                         |
              platform/desktop or browser
```

Rules:

- `app/` owns bootstrap, composition, navigation, and the single point that
  registers domain dispatcher modules.
- `features/` owns cohesive user capabilities such as connection, messaging,
  channels, direct messages, voice, and settings.
- `shared/` contains pure reusable UI, DOM, validation, formatting, and token
  code. It cannot import feature state or platform implementations.
- `platform/contracts/` contains asynchronous, host-neutral interfaces only.
- `platform/desktop/` is the only ordinary production location allowed to
  import Tauri APIs.
- `platform/browser/` implements browser behavior or returns an explicit
  unsupported result. It must not imitate certificate pinning, OS keychain
  protection, or global push-to-talk.
- Features may expose narrow public entry points. They may not import another
  feature's internal modules.
- `lib/` and `stores/` are transitional boundaries. Shrink them as ownership is
  proven; do not bulk-move them merely to make the target tree appear complete.

## Directional target layout

This tree describes responsibility ownership. It is not a single move list.

```text
Server/
  main.go                     # thin executable and composition entry
  internal/
    app/                      # construction, lifecycle, maintenance, cleanup
  api/                        # HTTP transport adapters
  admin/                      # admin transport and server-owned admin UI
  ws/                         # WebSocket transport and connection mechanics
  service/                    # domain use cases and narrow interfaces
  db/                         # persistence adapters
    dbgen/                    # generated sqlc output
    queries/                  # sqlc source queries
  cmd/                        # standalone operator/developer tools

Client/src/
  app/                        # bootstrap, composition, routing, dispatch root
  platform/
    contracts/               # host-neutral asynchronous interfaces
    desktop/                 # Tauri implementations
    browser/                 # browser implementations or explicit refusals
  features/
    connection/
    messaging/
    channels/
    direct-messages/
    voice/
    settings/
  shared/
    ui/
    dom/
    validation/
    styles/
  lib/                        # transitional; retain generated protocol path
  stores/                     # transitional global state
```

## Execution plan

### Phase 0 — Complete B2 and freeze the contracts

**Timing:** now; this is prerequisite work, not layout work.

1. Merge B2-2 to `dev` as its own completed protocol-epoch slice.
2. Continue the serialized B2-3 and B2-4 work and finish the remaining B2
   workstreams according to the active B2 plan.
3. Accept HP-2 only after protocol, trust, permission, E2EE, updater, and
   compatibility evidence is green on one exact `dev` SHA.
4. Do not mix any B3/B7 structural move into a B2 change.

**Exit gate:** HP-2 accepted; protocol fixtures and compatibility behavior are
stable enough to guard later extraction.

### Phase 1 — Record boundary inventories and automated rules

**Timing:** B3 entry preparation after HP-2.

1. Inventory every production database import in `api`, `admin`, `auth`, `ws`,
   root composition, and plugin code.
2. Assign each call one disposition: move behind a service, retain as an
   explicit adapter, retain as a transaction/composition boundary, or remove.
3. Inventory hub construction setters, lifecycle collaborators, lock ownership,
   start/stop ordering, and failure paths.
4. Record before-state dependency graphs for the first server vertical slice.
5. Refresh the client native-import, Rust-command, import-cycle, test-warning,
   timer/listener, bundle, coverage, and mutation baselines before B7.
6. Add the narrowest mechanical dependency checks supported by the evidence.

**Exit gate:** every crossing in scope has an owner and disposition; the checks
can detect a newly introduced violation without false positives.

### Phase 2 — Execute the first server vertical slice

**Timing:** B3, before repeating the pattern elsewhere.

Use authentication as the first slice because `S-10` already identifies raw
database ownership in auth routes as the intended pilot.

1. Characterize authentication, enumeration defense, session, TOTP, sentinel
   error, and failure behavior before moving dependencies.
2. Define a narrow auth use-case interface beside the HTTP consumer.
3. Move authentication orchestration behind the service boundary.
4. Keep persistence details in `db`; preserve error semantics at the service
   boundary.
5. Retain thin request decoding, response encoding, and middleware adaptation in
   `api`.
6. Record the before/after dependency graph and exact checks.

**Hold point:** HP-3 reviews the complete route-to-service-to-storage slice.
Repeat the pattern only if it reduces coupling without weakening B2 contracts.

### Phase 3 — Extract server lifecycle and hotspot responsibilities

**Timing:** B3 after HP-3 accepts the first slice.

1. Keep `main.go` as the executable entry but move application-private wiring
   into `internal/app/`:
   - configuration and data preparation;
   - construction and validated dependencies;
   - background workers and maintenance;
   - server start, drain, stop, and composite cleanup;
   - failure and restart coordination.
2. Replace required post-construction hub setters with validated constructor
   options. Leave setters only for genuinely replaceable runtime state.
3. Split WebSocket responsibilities inside the existing package before
   considering subpackages:
   - handshake authentication;
   - fresh-connect initialization;
   - replay selection and delivery;
   - registry and supersession;
   - visibility and permission refresh;
   - broadcast delivery and backpressure;
   - voice session and moderation lifecycle.
4. Replace mirrored permission and visibility decisions with canonical
   value-taking predicates and parity tests.
5. Move one remaining domain family at a time behind services, with explicit
   transaction exceptions where necessary.

**Exit gate:** lifecycle ownership is explicit; required construction cannot be
incomplete; every upper-layer database access is removed or justified; race,
deadlock, replay, reconnect, failure-injection, coverage, and benchmark gates
remain green.

### Phase 4 — Establish the client platform seam

**Timing:** B7, after the complete beta server is stable through B6. Do not pull
this work forward merely because the target directories are documented.

1. Re-run the client mutation baseline before decomposition.
2. Introduce typed asynchronous contracts for HTTP, WebSocket, credentials,
   settings/profiles, notifications, media, LiveKit proxies, logs/filesystem,
   window state, updater/process, opener, file selection, PTT, deep links, and
   application metadata.
3. Add desktop implementations and move the 20 native import sites behind them
   one responsibility at a time.
4. Add contract tests before creating browser implementations.
5. Add a static rule that rejects Tauri imports outside approved desktop and
   bootstrap ownership.
6. Split shared Vite configuration from target-specific behavior and add
   explicit `build:desktop` and `build:web` gates from one application tree.
7. Delete dead Rust command surfaces identified by the platform-contract map.

**Hold point:** HP-7 proves desktop parity before browser implementations are
filled in.

### Phase 5 — Decompose client features and hotspots

**Timing:** B7 for architecture and desktop parity; B9 for later feature UX and
style rationalization.

Use the target layout for new or extracted code, not as a reason to bulk-move
every existing file.

1. `dispatcher.ts`: retain one composition entry, but register messaging,
   presence, channel, DM, voice, and compatibility handlers from cohesive
   modules. Preserve the rule that WebSocket-driven store writes enter through
   dispatcher ownership.
2. `livekitSession.ts`: separate session attempt ownership, room lifecycle,
   device/media control, remote tracks, and debug/statistics behavior without
   weakening supersession rules.
3. `livekitE2EE.ts`: separate identity/key management, epoch transitions,
   worker lifecycle, participant state, and error reporting along existing
   staleness guards.
4. Messaging: separate virtual-list state, loading/windowing, renderers,
   attachments/media/embeds, reactions, and row lifecycle.
5. Settings: split account profile, avatar, password, TOTP, status, deletion,
   notifications, appearance, accessibility, voice, logs, and advanced/native
   capabilities into owned feature sections.
6. CSS: preserve selectors and built output while moving source sections into
   tokens/base, shared shell, messaging, sidebar, voice/video, settings,
   overlays, and responsive/accessibility files. Do not mix visual redesign
   into the source split.
7. Remove production import cycles or document the smallest unavoidable seam
   with a boundary test.
8. Centralize timer, listener, and teardown ownership for long-lived features.

**Exit gate:** client dependency rules pass; desktop behavior is unchanged;
import cycles and unexplained warnings are gone or explicitly accepted;
coverage, mutation, teardown, bundle, browser, and E2E evidence does not
regress.

### Phase 6 — Improve test proximity without losing test tiers

1. Colocate unit tests with every newly created or materially extracted source
   module using `src/**/*.test.ts`.
2. Move an existing unit test only when its owning production module is already
   being extracted and the move remains reviewable.
3. Keep cross-component contracts under `tests/contract`, multi-module
   integration under `tests/integration`, real-browser tests under
   `tests/browser`, and Playwright under `tests/e2e`.
4. Document any fixture shared across tiers and give it one owner.
5. Do not weaken assertions to make a mechanical move pass.

**Exit gate:** a developer opening a moved or new module can find its focused
tests immediately; stack-level test commands and coverage still include every
tier intended by CI.

### Phase 7 — Finish the contributor path

1. Add a concise change map to active contributor or architecture guidance:
   - add or change a REST endpoint;
   - add or change a WebSocket event;
   - change the generated protocol;
   - add a server domain operation;
   - add a client feature or setting;
   - add a desktop or browser capability;
   - add a migration or query;
   - choose the correct test tier.
2. Add root shortcuts only for measured high-frequency development paths. Keep
   direct Go commands first-class and Node-free for server-only contributors.
3. Print scoped commands and working directories, as `scripts/run.mjs` already
   does for verification.
4. Keep architectural ownership in one maintained map rather than adding a
   README to every directory.
5. Exercise the guide with one fresh-contributor scenario and record every
   point where the contributor must guess.

**Exit gate:** a fresh Windows or Linux contributor can bootstrap the relevant
stack, locate a common change path, run a focused test, and run the appropriate
full stack check without undocumented knowledge.

### Phase 8 — Exact-SHA structural qualification

Run the complete relevant matrix on the exact resulting SHA:

- all four Go build-tag variants;
- Go vet, race, deadlock, generated protocol, generated database, and lint;
- client typecheck, lint, format, unit, integration, contract, browser, and E2E;
- Rust format, tests, and Clippy;
- desktop and web production builds when B7 owns both;
- Docker and release-path checks required by the owning phase;
- generated and documentation drift checks;
- dependency-boundary and import-cycle checks;
- clean process termination and clean worktree verification.

**Exit gate:** every artifact and report points to the same commit; there is no
accidental generated or build output; file moves are behavior-neutral; accepted
exceptions have an owner, rationale, and review trigger.

## Pull-request and commit strategy

Each migration unit should normally use this order:

1. add or tighten characterization/contract tests;
2. add the new boundary and its dependency rule;
3. move one responsibility without changing behavior;
4. mechanically rewrite imports and paths;
5. remove the old path after all consumers move;
6. run scoped checks, then the phase-required full matrix;
7. update the boundary inventory and architecture/change map.

Pure moves and mechanical path rewrites should be adjacent commits. Functional
changes discovered during extraction belong in separate pull requests unless a
failing safety test proves they are inseparable.

## Measures and acceptance criteria

### Server

- Every production database import above persistence/service ownership is
  removed or recorded as an explicit allowed boundary.
- Authentication completes one reviewed vertical slice before the pattern is
  copied.
- Application construction, start, drain, stop, restart, and cleanup have
  explicit owners and failure tests.
- Required hub collaborators are validated at construction.
- Permission and visibility security properties have one production predicate
  per property.
- No extraction regresses race, deadlock, replay, reconnect, coverage, or
  benchmark evidence.

### Client

- Ordinary production Tauri imports exist only under approved desktop adapter
  and bootstrap ownership.
- Desktop and web targets compile from the same application source.
- Platform contracts are asynchronous and make unsupported capabilities
  explicit.
- Production dependencies are acyclic, or the smallest approved exception has
  a boundary test and rationale.
- New and extracted unit-test ownership is colocated; higher test tiers remain
  centralized.
- Hotspot decomposition preserves dispatcher, voice supersession, E2EE
  staleness, teardown, and generated-protocol invariants.
- CSS source ownership is feature-oriented without visual behavior changes in
  the structural migration.

### Contributor experience

- Root and per-stack commands remain discoverable and cross-platform.
- Server-only development remains possible without Node.
- A maintained change map answers where common additions belong and which tests
  prove them.
- Generated source ownership is visible from every relevant entry point.
- A fresh-contributor exercise completes without undocumented directory or
  command discovery.

## Risks and controls

| Risk                                               | Control                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A large move hides behavior changes                | Separate characterization, move, path rewrite, and behavior commits; restart structural review when a move commit changes logic. |
| Go subpackages force exports or cycles             | Split files inside the owning package first; create a subpackage only after dependency direction is proven.                      |
| Service interfaces become generic abstractions     | Define the smallest interface beside its consumer and implement one real use case before repeating it.                           |
| Desktop behavior changes during adapter extraction | Add contract tests first and reach HP-7 desktop parity before filling browser implementations.                                   |
| Browser adapters weaken security claims            | Return explicit unsupported states for certificate pinning, OS-keychain equivalence, and global PTT.                             |
| Feature folders become a cosmetic bulk migration   | Use the target only for new/extracted responsibilities; leave transitional `lib` and `stores` until ownership is proven.         |
| Test moves reduce coverage or confuse tiers        | Move unit tests only with their production modules; keep contract/integration/browser/E2E tiers centralized.                     |
| CSS splitting becomes a redesign                   | Preserve selectors and rendered output; perform visual changes separately with visual/accessibility evidence.                    |
| Root tooling makes Node mandatory                  | Keep direct Go commands documented and supported; root npm remains an optional facade for server-only work.                      |
| Generated output is edited during moves            | Preserve the source-of-truth workflows and run drift checks after every affected migration.                                      |

## First actionable slice

After B2-2 merges and HP-2 is accepted:

1. write the B3 database-call and lifecycle inventory;
2. record the before-state dependency graph;
3. add characterization tests for auth enumeration and error mappings;
4. execute the authentication route-to-service-to-storage vertical slice;
5. review it at HP-3 before extracting any other server family.

Do not create `Client/src/platform/` or begin client feature moves during this
slice. The client implementation work remains B7; the existing platform map is
the design input until its entry gate is met.
