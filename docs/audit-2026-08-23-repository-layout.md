# OwnCord repository-layout and contributor-experience audit

**Audited:** 2026-08-23  
**Audited head:** `5cc0888964e26276d1aca145e83270a2c1b9febd` (`dev`)  
**Decision:** a targeted, isolated layout phase is justified; a wholesale
repository or server rewrite is not  
**Product input:**
[beta-product-requirements-2026-08-23.md](plans/beta-product-requirements-2026-08-23.md)
**Canonical work register:**
[repo-health-issue-register-2026-08-23.md](plans/repo-health-issue-register-2026-08-23.md)

## Executive verdict

OwnCord's top-level server/client separation is understandable and the Go
server's package layout is generally healthy. The repository does not need a
monorepo rewrite, a `Server/` rename, or broad movement of historical documents.

A smaller structural phase is worthwhile before beta feature work because the
new browser/PWA requirement exposes a real boundary problem: the only client is
nested and named as Tauri-specific, while the shared frontend directly imports
native Tauri APIs in at least 20 production files. Contributor entry points,
branch automation, release coverage, generated artifacts, and active-document
navigation also need consolidation.

The structural work must be mechanical and independently reversible. File
moves and path rewrites must not contain functional changes, and the later
platform-boundary extraction must preserve behavior behind tests before adding
the browser implementation.

Priorities follow the health register: P0 is a red required gate, P1 must close
before beta, and P2 is scheduled architecture, quality, or operational debt.

## What should remain stable

- Keep `Server/` and its existing domain packages. Later hotspot extraction is
  architecture work, not repository layout work.
- Keep existing release asset names and updater contracts so alpha-to-beta
  upgrades do not break.
- Keep one shared client UI, store, protocol, and domain implementation. Do not
  fork a second web application.
- Keep build-required generated sources committed: sqlc output, generated
  protocol types, Tauri-generated bindings, and runtime assets required by a
  release build.
- Keep historical audits and plans at their existing paths. Index their status
  instead of moving them and breaking references.
- Keep the canonical findings ledger until a deliberate tracker migration
  provides equivalent history and validation.

## Recommended target

```text
Client/
  package.json
  src/
    platform/
      contracts/
      browser/
      desktop/
  src-tauri/
  tests/
Server/
protocol/
  schema.json
deploy/
docs/
  README.md
  plans/
tools/
```

The current `Client/tauri-client/` content should be flattened into `Client/`
as two adjacent non-functional commits: first pure file moves, then mechanical
rewrites of active paths. `Client/` has no other tracked child, and the current
name incorrectly implies that browser/PWA support should become a separate
application. The capitalized `Client/` and `Server/` names may remain: changing
both for style alone would create widespread path churn without improving a
runtime or contributor boundary.

The protocol schema is executable cross-component source and should move from
`docs/protocol-schema.json` to a small root `protocol/` boundary. Documentation
continues to explain the contract, while root tooling owns generation for both
consumers.

## Findings

| ID    | Pri | Finding                                                                                                                                                                                                                                                                 | Required disposition                                                                                                                                                                                                       |
| ----- | --: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RL-01 |  P1 | All tracked client content is under the redundant `Client/tauri-client/` level, and active automation/documentation hard-code that path. The name is misleading now that browser/PWA is approved.                                                                       | Flatten to `Client/` in two adjacent non-functional commits—pure moves, then active-path rewrites—and leave historical evidence untouched.                                                                                 |
| RL-02 |  P1 | At least 20 frontend files directly import `@tauri-apps/*`; API, WebSocket, credentials, profiles, notifications, media, LiveKit, updates, logs, and window state do not have a browser-neutral platform seam.                                                          | Record the target boundary during the layout phase, then introduce typed `platform/contracts`, `platform/desktop`, and `platform/browser` ownership in client phase B7. Add contract tests that run against both adapters. |
| RL-03 |  P1 | The Vite configuration contains Tauri-specific HTML transformation, and there is no independent browser/PWA production build contract.                                                                                                                                  | In client phase B7, split shared build configuration from target adapters and add explicit `build:web` and `build:desktop` gates using one application source tree.                                                        |
| RL-04 |  P2 | Root `package.json` exposes release and hook commands but no discoverable bootstrap, format, generated-code, server, client, or full verification entry points.                                                                                                         | Add a cross-platform root command facade. Decide workspace consolidation from measured install/lockfile behavior rather than requiring Node for ordinary Go-only work.                                                     |
| RL-05 |  P2 | Three JavaScript package/lock roots are maintained separately, while dependency automation does not cover all of them.                                                                                                                                                  | Either adopt a documented npm workspace or add complete per-package automation; retain component-local commands and deterministic lockfile installs.                                                                       |
| RL-06 |  P2 | Tracked `graphify-out/` is about 20 MB, led by a roughly 19.3 MB generated JSON graph. Portable regeneration was not demonstrated in this audit environment because the available launcher failed before a query could run. Repeated refreshes grow normal Git history. | Stop tracking large graph payloads after providing a portable regeneration command and CI/release artifact. Do not rewrite published history. A compact architecture report may remain if it is mechanically verified.     |
| RL-07 |  P2 | `.superpowers/FINDINGS.md` duplicates the canonical ledger as a large generated rendering. The canonical JSON ledger remains necessary today.                                                                                                                           | Keep the authoritative JSON ledger, remove the tracked human rendering after a drift check exists, and generate it on demand or as a downloadable CI artifact.                                                             |
| RL-08 |  P2 | A prebuilt example `hello.wasm` is committed for a plugin system that is experimental and disabled, without a source-drift verification gate.                                                                                                                           | Keep its source, stop tracking the prebuilt example, and compile/verify it deterministically in CI or release checks without making an API compatibility promise.                                                          |
| RL-09 |  P2 | Cross-component protocol source lives under `docs/`, while a server-owned generator writes both Go and TypeScript consumers.                                                                                                                                            | Move the schema/generator entry point to the root protocol/tool boundary and verify both generated outputs from one command.                                                                                               |
| RL-10 |  P1 | `Server/scripts/seed.go` is included in broad Go package discovery and its initialization creates a runtime data directory during test discovery.                                                                                                                       | Move executable tools under a conventional `cmd/` or tool package and remove import/test-time filesystem side effects.                                                                                                     |
| RL-11 |  P2 | A client “unit” test reads server admin HTML directly, hiding a cross-component contract inside the wrong ownership and test tier.                                                                                                                                      | Move the invariant to the owning server test or a clearly named root contract/system-test tier. Inventory siblings before moving only one file.                                                                            |
| RL-12 |  P2 | There is no canonical docs landing page that distinguishes active guidance, reference material, historical audits, and superseded plans. Active files also disagree about Node and branch policy.                                                                       | Add `docs/README.md` and a plan index; mark status without relocating historical evidence. Generate or check high-value version/branch/platform facts.                                                                     |
| RL-13 |  P2 | The Go module declares `github.com/owncord/server`, while the public repository is `github.com/J3vb/OwnCord`.                                                                                                                                                           | Align the module to `github.com/J3vb/OwnCord/Server` in an isolated mechanical change and verify every import, generator, build tag, source archive, and downstream instruction.                                           |
| RL-14 |  P0 | `dev` can receive direct commits without an exact-SHA CI run because push CI covers `main`, while `dev` relies on PR or manual events.                                                                                                                                  | Add protected PR-only integration or run the complete blocking matrix for every `dev` push. This duplicates G-03 and must map to one canonical issue.                                                                      |
| RL-15 |  P1 | Release automation does not cover the approved platform matrix: Windows ARM64 client/server, Linux ARM64 server, and multi-architecture Docker publication are missing.                                                                                                 | Add build, package, install/boot smoke, signing, manifest, and update checks for all BPR-010/BPR-011 targets.                                                                                                              |
| RL-16 |  P1 | A version tag can start publication without proving that the exact tagged commit completed the full beta gate.                                                                                                                                                          | Couple release publication to green exact-SHA evidence and a protected release approval; retain current version, signature, checksum, cold-boot, and source-snapshot strengths.                                            |
| RL-17 |  P1 | Client `.nvmrc` and active contributor docs say Node 20 while CI/release use Node 24; package metadata does not enforce the intended Node/npm versions.                                                                                                                 | Establish one Node 24 source of truth read by local setup, packages, CI, release, and documentation. This duplicates C-01 and must map to one canonical issue.                                                             |
| RL-18 |  P1 | Dependency automation omits root tooling, `tools/mcp-introspect`, and Docker; runtime/build containers use mutable tags.                                                                                                                                                | Cover every dependency root, pin or automatically review container digests, and produce signed SBOM/provenance evidence for releases.                                                                                      |
| RL-19 |  P2 | Formatting/lint coverage omits material Markdown, YAML, JSON, CSS, Rust formatting, repository-wide Go formatting, shell scripts, and workflow syntax. There is no root `.editorconfig`.                                                                                | Add fast, cross-platform format and repository-lint gates with generated/vendor exclusions and one editor baseline.                                                                                                        |
| RL-20 |  P2 | Committed hooks are POSIX shell and invoke `make`, but Windows is an official contributor platform without those prerequisites being explicit.                                                                                                                          | Make hooks thin optional wrappers around cross-platform root commands and document any Git Bash dependency until removed.                                                                                                  |
| RL-21 |  P2 | Community intake does not match the approved model: feature requests still become Issues, and bug forms omit browser/PWA, ARM64, deployment mode, and architecture detail.                                                                                              | Route ideas/feedback to Discussions and modernize bug forms, PR guidance, contributor entry points, and support links.                                                                                                     |
| RL-22 |  P1 | Authorization for externally triggered paid repository automation is not sufficiently constrained.                                                                                                                                                                      | Limit execution to explicitly trusted maintainers, retain least-privilege permissions, add cost-abuse regression tests, and keep the concrete pre-fix mechanism private.                                                   |

## Strong foundations to preserve

- CI already exercises Go build tags, race/deadlock behavior, TypeScript/Rust
  checks, a limited browser harness, mocked-desktop Playwright, Docker smoke,
  vulnerability checks, and coverage artifacts. These are foundations, not
  evidence that a production browser/PWA client exists.
- GitHub Actions are SHA-pinned and generally use narrow permissions.
- Release automation already checks version agreement, cold-boots the built
  server, signs metadata, verifies signatures, generates checksums, and
  publishes an AGPL source snapshot.
- `.gitattributes` enforces stable line endings and ignore files cover most
  ordinary build/runtime output.
- Component documentation is detailed; the primary problem is discoverability
  and stale duplicated facts, not absence of technical knowledge.

## Isolated implementation sequence

1. Restore the two currently red client test contracts, make the full and
   isolated Playwright runs terminate after completion, and establish the exact
   baseline checks. Structural validation must start green.
2. Add the docs/plan index and root cross-platform command facade, then align
   Node 24 and branch/CI truth.
3. Relocate or stop tracking non-product generated artifacts after their
   replacement generation/artifact paths are proven.
4. Flatten `Client/tauri-client/` to `Client/` as two adjacent commits in one
   PR: pure file moves, then mechanical active-path rewrites. Neither commit
   changes behavior.
5. Record the browser-neutral contract map and owners. Implement the adapters,
   native extraction, and web production build later in client phase B7 after
   the server-first phases close.
6. Move protocol ownership to the root and verify both generated consumers.
7. Reclassify cross-stack tests and executable tools; remove test-time
   filesystem side effects.
8. Correct platform/release/dependency automation independently of the moves.
9. Run the full server, client, Rust, browser, generated-code, Docker, and
   release-path matrix on the exact resulting SHA.

## Exit gate

- a fresh Windows or Linux contributor can find one setup path and run scoped
  or full checks without guessing directories;
- existing desktop behavior and release/update names are unchanged;
- the browser-neutral contract design, owners, and B7 validation plan are
  approved without prematurely refactoring client runtime behavior;
- every supported release architecture has an owned automation path;
- every active commit on `dev` has exact-SHA CI evidence;
- generated sources and large analysis artifacts have explicit, reproducible,
  separately verified ownership;
- no active documentation contradicts branch, Node, platform, support, plugin,
  or beta-scope policy;
- the complete baseline is green and the worktree contains no accidental build
  or generated output.

## Migration risks and controls

| Risk                                                      | Control                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Hard-coded client paths are missed                        | Inventory active references before the move; run workflow, hook, generator, docs-link, package, and release-manifest checks afterward. |
| Browser and desktop behavior diverge                      | One shared application plus tested platform contracts; no copied feature implementations.                                              |
| Root tooling makes Node mandatory for server contributors | Keep direct Go commands supported and make the root facade a convenience/orchestration layer.                                          |
| Release or updater compatibility breaks                   | Do not rename binaries/assets; smoke installation, update manifests, signatures, and in-place upgrades.                                |
| Rename obscures functional review                         | Pure-move and mechanical-path-rewrite commits are followed by separately reviewed adapter changes.                                     |
| Generated analysis output disappears without replacement  | Prove local generation and downloadable CI artifacts before untracking; retain published Git history.                                  |

No production source was moved or changed during this audit.
