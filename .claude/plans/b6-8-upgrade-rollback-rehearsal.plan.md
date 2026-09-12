# Plan: B6-8 — Alpha-to-beta upgrade and rollback rehearsal

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-8 — Alpha-to-beta upgrade and rollback rehearsal (roadmap workstream 7)
**Satisfies**: BPR-004 (alpha data, attachments, configuration, credentials survive an in-place upgrade), BPR-031 (server upgrades before clients)
**Complexity**: Medium-high
**Drafted**: 2026-09-12 at `dev` `df6cbce3`

## Summary

Everything an owner needs to upgrade already exists — a published alpha.4 with
real server assets, a Docker image, a database backup endpoint, an on-disk data
directory, and a migration runner with a committed alpha-schema canary. What
does not exist is **proof that a real alpha install survives the trip**, and a
**documented rollback** an owner can actually perform.

B6-8 builds one harness that drives a real alpha.4 server through the whole
owner-visible upgrade:

1. boot the **published alpha.4 asset**, complete the setup wizard, upload a
   file, take a backup — a real install with data, attachments, credentials;
2. archive the pre-upgrade state the way the docs will tell owners to;
3. replace the binary (or the container image) with HEAD and reach healthy;
4. assert **nothing was lost**: same session token still authenticates, the
   same attachment downloads byte-identical, `config.yaml` is untouched, the
   three on-disk key files are untouched, the backup is still listed, and the
   version actually changed;
5. **roll back** to alpha.4 from the archive and assert the same set again
   against the old binary.

It is one Go program because the fixture (setup wizard → upload → backup →
re-verify) is identical for both deployment modes, and writing it twice — once
in Go for standalone and once in bash for Docker — is how the two legs drift.
It lives in `Server/cmd/smoke` as new files in the existing package, so the
Windows graceful-stop machinery, the boot/health/drain helpers and the
`::error::` annotation style are reused rather than re-derived.

**Migrations are forward-only. There is no "downgrade" and this plan does not
invent one** — rollback means _restore the pre-upgrade archive, then run the old
binary_, and the deliverable is proof that the documented procedure works plus
honest documentation of what it costs.

## Verify before you implement

Facts established from source at `df6cbce3`; re-check any a parallel branch may
have moved.

| Claim                                                                          | Status        | Evidence                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migrations are forward-only — no down migrations exist                         | **Confirmed** | `Server/db/migrate.go` — `MigrateFS` only applies unrecorded `.sql` files in lexicographic order; the word "down" appears nowhere in the file                                              |
| A real alpha server binary is downloadable                                     | **Confirmed** | `v1.2.0-alpha.4` assets: `chatserver.exe`, `chatserver-linux-amd64.tar.gz`, `checksums.sha256`, `server-update-manifest.json`                                                              |
| No alpha **container image** was ever published                                | **Confirmed** | `release.yml:511-520` pushes only on a tag, and the push job is B6-2 work merged 2026-09-11 — after the alpha.4 tag. The "from" image must be built from the alpha.4 source tree           |
| The alpha.4 tree still contains a buildable Dockerfile                         | **Confirmed** | `git show v1.2.0-alpha.4:Server/Dockerfile` — `golang:1.26-bookworm` builder, distroless runtime, `USER 65532:65532`                                                                       |
| `POST /admin/api/setup` creates the owner and returns a session token          | **Confirmed** | `docs/api.md:2987` — public, rate-limited 5/min, response carries `token`; present at alpha.4 (`v1.2.0-alpha.4:Server/admin/api.go:83`)                                                    |
| One admin-authenticated endpoint reports the running version on **both** sides | **Confirmed** | `Server/api/diagnostics_handler.go:29` (`Version`) at `GET /api/v1/diagnostics/connectivity`; the same route exists at `v1.2.0-alpha.4:Server/api/router.go:158`                           |
| No unauthenticated endpoint reports a version                                  | **Confirmed** | `docs/api.md:2808` — C-2 deliberately keeps build identity off `/api/v1/server-info`, `/api/v1/info` and `/health`                                                                         |
| Attachment downloads are session-authenticated                                 | **Confirmed** | `Server/api/upload_handler.go:186` — `AuthMiddleware(sessions)` on `GET /api/v1/files/{id}`                                                                                                |
| Three credential files live on disk, outside the database                      | **Confirmed** | `Server/auth/totp_encrypt.go:40` (`totp.key`), `erasure_key.go:19` (`erasure.key`), `push_vapid_key.go:33` (`push_vapid.key`) — all under `data/`                                          |
| A database backup does **not** contain those key files                         | **Confirmed** | `Server/auth/erasure_key.go:15` says so in as many words; `push_vapid_key.go:37` adds "rotating it invalidates every stored subscription"                                                  |
| A database backup does **not** contain uploads                                 | **Confirmed** | `docs/deployment.md:372` — "The built-in backup covers the **database only**"                                                                                                              |
| Uploads, backups, certs and keys all live under `data/`                        | **Confirmed** | `config.go:436` (`data/uploads`), `:534` (`data/backups`), `:543` (`data/acme_certs`), `:493` (`data_dir: "data"`)                                                                         |
| The self-signed certificate carries **no SANs**                                | **Confirmed** | `Server/auth/tls.go:54-67` — the template sets `Subject`/`CommonName` only, no `DNSNames`, no `IPAddresses`. No `RootCAs` pool can verify it, so the harness must use `InsecureSkipVerify` |
| gosec is excluded for `cmd/smoke/main.go` **by exact filename**                | **Confirmed** | `Server/.golangci.yml:106-107` — `path: cmd/smoke/main\.go`. New files in that package are **not** covered; the exclusion must widen to the directory                                      |
| Docker's default bridge subnet is inside the admin perimeter                   | **Confirmed** | `config.go:409-415` — `172.16.0.0/12` is a default `admin_allowed_cidrs` entry, so `/admin/api/*` answers from the host over a published port                                              |
| In-place self-update is refused in containers                                  | **Confirmed** | `docs/deployment.md:160` — 503 `CONTAINER_DEPLOYMENT`; image replacement is the only Docker upgrade path                                                                                   |
| The updater's GitHub base URL is **not** operator-configurable                 | **Confirmed** | `Server/updater/updater.go:115` `SetBaseURL` has no non-test caller — a fake release server cannot be pointed at, so the self-update _handoff_ is not rehearsable offline                  |
| An alpha-schema dataset is already committed                                   | **Confirmed** | `Server/testdata/snapshots/v1.2.0-alpha.4.sqlite` + `Server/db/alpha_snapshot_test.go` — 31 migrations baked in, proven to migrate on HEAD                                                 |
| alpha.4 shipped **no** ARM64 server asset                                      | **Confirmed** | The asset list above — ARM64 server assets arrive with B6-1 (PR #1580), i.e. at the _next_ tag. ARM64 upgrade cannot be rehearsed from a published alpha                                   |
| The smoke harness owns the Windows graceful stop                               | **Confirmed** | `Server/cmd/smoke/main.go:16-22` + `stop_windows.go` — MSYS `kill -TERM` terminates rather than draining; reuse this, never re-derive it                                                   |

## Patterns to Mirror

| Category             | Source                                 | Pattern                                                                                              |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Lifecycle phases     | `Server/cmd/smoke/main.go:82-131`      | boot → assert artefacts → drain → restart on the SAME state → assert nothing was recreated           |
| Honest assertions    | `Server/cmd/smoke/main.go:113-116`     | "a restart that re-created the database would pass for the wrong reason" — assert reuse, not success |
| Failure annotation   | `Server/cmd/smoke/main.go:50-53`       | `::error::` prefix and the failing server's log tail                                                 |
| Budgets in one place | `Server/cmd/smoke/main.go:36-41`       | `bootTimeout` / `drainBudget` / `pollEvery` as named constants, matched by `docker-smoke.sh`         |
| Container phases     | `Server/scripts/docker-smoke.sh:1-30`  | Replacement, not `docker start` — "replacement is also the only upgrade path OwnCord supports"       |
| Shared call sites    | `ci.yml` + `release.yml` + the nightly | One harness from every call site, so a regression fails pre-merge instead of at tag time             |
| Commentary style     | `Server/scripts/docker-smoke.sh:17-30` | Every non-obvious step carries _why it exists_, not what it does                                     |

## Files to Change

| File                                      | Action | Why                                                                                               |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `Server/cmd/smoke/main.go`                | UPDATE | Flag parsing: `-upgrade`, `-from`, `-docker`; the existing one-positional-arg mode is unchanged   |
| `Server/cmd/smoke/upgrade.go`             | CREATE | The eight rehearsal phases and their assertions                                                   |
| `Server/cmd/smoke/fixture.go`             | CREATE | REST fixture + state capture: setup wizard, upload, backup, digest sets                           |
| `Server/cmd/smoke/target.go`              | CREATE | The standalone/container seam — start, drain, swap version, archive, restore                      |
| `Server/cmd/smoke/fixture_test.go`        | CREATE | Unit coverage for the pure parts: digest-set comparison and its failure message                   |
| `Server/.golangci.yml`                    | UPDATE | Widen the gosec exclusion from `cmd/smoke/main\.go` to `cmd/smoke/`                               |
| `.github/workflows/upgrade-rehearsal.yml` | CREATE | Nightly + `workflow_dispatch` + `workflow_call`; resolves the previous release, runs both legs    |
| `.github/workflows/release.yml`           | UPDATE | Call the rehearsal before anything is signed or pushed                                            |
| `.github/workflows/ci.yml`                | UPDATE | Standalone leg only, in the existing `smoke-server-binary` matrix — harness regressions pre-merge |
| `docs/deployment.md`                      | UPDATE | A real "Upgrade and Rollback" section: the procedure, and what the archive must contain           |
| `CHANGELOG.md`                            | UPDATE | Unreleased entry — upgrade/rollback rehearsal and the documented rollback procedure               |
| `docs/plans/b6-*.prd.md`                  | UPDATE | B6-8 row → `in-progress`, then `complete` + this plan's link                                      |

## Tasks

### Task 1: Flags and the target seam

- **Action**: Add flag parsing to `main.go` — `-upgrade`, `-from <binary|image>`,
  `-docker` — keeping today's `smoke <binary>` invocation working unchanged
  (flags first, then one positional). In `target.go` define the only thing the
  two deployment modes disagree about:

  ```go
  // target is one deployment mode under rehearsal. The fixture and every
  // assertion are identical for both; only starting, stopping and swapping a
  // version differ, which is the whole reason this seam exists.
  type target interface {
  	start(version string) error // "old" | "new" — reaches healthy or errors
  	drain() error               // graceful stop, exit 0 inside drainBudget
  	baseURL() string
  	archive(dir string) error   // copy the live data dir out, as an owner would
  	restore(dir string) error   // put it back
  }
  ```

  with `standaloneTarget` (processes in a temp dir, reusing `start`/`waitHealthy`/
  `drain` from `main.go`) and `dockerTarget` (containers on a named volume,
  shelling out to `docker`, mirroring `docker-smoke.sh`'s phases).

- **Why**: two real implementations, and the alternative is the fixture written
  twice in two languages — which is exactly how the standalone and container
  legs drift apart.
- **Mirror**: `Server/cmd/smoke/main.go`'s existing `server` type; do not
  duplicate `stop_windows.go`.
- **Validate**: `go run ./cmd/smoke ./chatserver` still passes unchanged, and
  `go run ./cmd/smoke -upgrade -from x y` fails with a clear usage error while
  the phases are still stubs.

### Task 2: The REST fixture and the state capture

- **Action**: In `fixture.go`, an HTTP client over the server's self-signed
  listener, then the fixture:

  ```go
  // The generated certificate carries no SANs at all (Server/auth/tls.go), so
  // no RootCAs pool can verify it. This client talks to a server this harness
  // just launched on loopback; there is nothing to be MITM'd by.
  tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // #nosec G402
  ```

  - `POST /admin/api/setup` with `{"username","password","wizard":{"server_name","motd"}}`
    — **wizard fields that live in `config.yaml` (port, TLS) are deliberately
    omitted**, because setting them makes the server restart itself mid-fixture
    (`restart_required`) and rewrites the file whose hash is under test;
  - `POST /api/v1/uploads` (multipart) with a fixed 64 KiB payload → record `id`;
  - `POST /admin/api/backup` → then `GET /admin/api/backups` → record the name;
  - `GET /api/v1/diagnostics/connectivity` → record `version`.

  Then `captureState(dir, baseURL, token)` returning a comparable struct:
  `config.yaml` SHA-256; the SHA-256 of each of `data/totp.key`,
  `data/erasure.key`, `data/push_vapid.key`; the SHA-256 of every file under
  `data/uploads`; the backup list; the bytes returned by
  `GET /api/v1/files/{id}`; and the reported version. `compare(before, after)`
  returns an error naming _which_ item changed.

- **Why**: these five are exactly the nouns in the milestone — data, attachments,
  configuration, credentials, backups — plus "authenticated downloads still
  working afterwards", which is the download re-issued with the **pre-upgrade**
  token.
- **Test first**: `fixture_test.go` covers `compare` — equal states pass, a
  changed key file names `push_vapid.key` and not merely "state differs", a
  changed attachment names the file id. No server is started in this test.
- **Validate**: `go test ./cmd/smoke/` passes; `golangci-lint run` is clean once
  Task 6's exclusion widening lands (do that one first if the linter complains).

### Task 3: The upgrade phases (standalone)

- **Action**: In `upgrade.go`, phases 1-5 against `standaloneTarget`:

  1. start `old`, run the fixture, `captureState` → `before`;
  2. `archive()` the whole data directory plus `config.yaml` — the pre-upgrade
     copy the docs will tell owners to take;
  3. `drain()` the old server and assert `healthcheck` no longer passes;
  4. `start("new")` on the **same** directory — the binary is replaced, nothing
     else is touched;
  5. `captureState` → `after`, and assert:
     - `after.version != before.version` — **an upgrade that silently kept
       running the old binary would otherwise pass every other assertion**;
     - every other field is byte-identical to `before`, via `compare`;
     - the pre-upgrade session token still authenticates (`GET /api/v1/auth/me`
       → 200) — this is the credential assertion with teeth;
     - the database was not recreated: the fixture's owner row is still there
       and the pre-upgrade backup is still listed.

- **Why**: phase 4 is the milestone in one line. Phases 1-2 exist so that what
  it upgrades is a real install rather than an empty directory, and phase 5's
  version check is what stops the whole rehearsal passing vacuously.
- **Mirror**: `main.go:113-121`'s "would pass for the wrong reason" reasoning —
  put the same note beside the version assertion.
- **Validate**: `go run ./cmd/smoke -upgrade -from ./chatserver-alpha4 ./chatserver`
  prints each phase and exits 0 locally against a downloaded alpha.4 asset.

### Task 4: The rollback phases (standalone)

- **Action**: Phases 6-8:

  6. `drain()` the new server;
  7. `restore()` the Task 3 archive over the data directory — database from the
     pre-upgrade backup, uploads, all three key files, `config.yaml` — then
     `start("old")` again;
  8. `captureState` → `rolledBack`, and assert it equals `before` **including
     `version`**: the old binary is serving, the pre-upgrade token still
     authenticates, and the attachment downloads byte-identical.

  Then a final `drain()`. On failure, print the offending field and the tail of
  the rolled-back server's log.

- **Why**: "declared rollback" only means something if someone has executed it.
  This is also where the honest limits surface: whatever an owner does not put
  in the archive is what they lose, and the harness proves the archive contents
  Task 7 documents are sufficient — no more, no less.
- **Validate**: the same command as Task 3 now completes all eight phases; then
  deliberately drop `data/uploads` from the archive and confirm the rehearsal
  **fails** at phase 8 naming the attachment. Put the archive back afterwards —
  that inverted run is a one-off proof, not a committed test.

### Task 5: The container leg

- **Action**: Implement `dockerTarget`: a named volume, `docker run -d -p` with
  `--cap-drop=ALL --security-opt=no-new-privileges`, health polled through
  `docker inspect`, `archive`/`restore` via `docker cp` against a **stopped**
  container, and "swap version" = remove the container and run a new one from
  the other image on the same volume. The harness takes two image references
  (`-docker -from <old-image> <new-image>`); building the alpha.4 image belongs
  to the workflow, not here.
- **Why**: image replacement is the only Docker upgrade path OwnCord supports
  (`docs/deployment.md:160`), so the container leg must replace rather than
  restart — the same reason `docker-smoke.sh` phase 5 already gives.
- **Gotcha**: `MSYS_NO_PATHCONV=1` is global to a command, not to one argument —
  it breaks the **host** side of `docker cp`. Every host path goes through `tar`
  or the shell, never straight to `docker` (the B6-2 post-merge note).
- **Validate**:
  ```bash
  git worktree add /tmp/alpha4 v1.2.0-alpha.4
  docker build -t owncord-server:alpha4 /tmp/alpha4/Server
  docker build -t owncord-server:head Server/
  go run ./cmd/smoke -upgrade -docker -from owncord-server:alpha4 owncord-server:head
  ```

### Task 6: Lint exclusion and workflow wiring

- **Action**:
  - `.golangci.yml`: `path: cmd/smoke/main\.go` → `path: cmd/smoke/`, with the
    existing comment extended to say the harness now also launches containers
    and talks to its own server over a SAN-less self-signed certificate.
  - `.github/workflows/upgrade-rehearsal.yml`: nightly `schedule`,
    `workflow_dispatch` and `workflow_call`. It resolves the previous release
    (`gh release list --limit 1 --exclude-drafts`, or the input), downloads the
    asset with `gh release download`, **verifies it against `checksums.sha256`**,
    builds HEAD, and runs both legs. The Go harness itself never talks to GitHub —
    it takes paths and image refs, so it stays hermetic and offline-runnable.
  - `release.yml`: call the rehearsal before the signing and push jobs, upgrading
    _from the previous release_ _to the tag being built_.
  - `ci.yml`: add the standalone leg to the existing `smoke-server-binary`
    matrix, which already builds the binary and runs `cmd/smoke`. The container
    leg stays out of PR time — it costs an alpha-source image build.
- **Why**: the same reason `docker-smoke.sh` is called from three workflows — a
  regression in the harness should fail pre-merge, not at tag time. Release time
  is where the evidence actually matters; the nightly keeps it from rotting.
- **Validate**: `gh workflow run upgrade-rehearsal.yml` on the branch goes green
  on both legs; `actionlint` and ShellCheck **0.9.0** (`koalaman/shellcheck:v0.9.0`
  — `:stable` is 0.11.0 and misses SC2015) pass.

### Task 7: Document the procedure and its honest limits

- **Action**: Replace `docs/deployment.md`'s two-line "Upgrading" with an
  **Upgrade and Rollback** section stating, for standalone and Docker:
  - **Before upgrading**, archive: the backup from `/admin/api/backup`, plus
    `data/uploads/`, plus `data/totp.key`, `data/erasure.key`,
    `data/push_vapid.key`, plus `config.yaml`. Spell out what each omission
    costs — no uploads means every attachment 404s; no `erasure.key` means a
    restore cannot recognise erased accounts; no `push_vapid.key` invalidates
    every push subscription; no `totp.key` locks every 2FA user out.
  - **Rollback is restore-then-downgrade, not a downgrade.** Migrations are
    forward-only: there is no supported way to run an older binary against a
    database a newer one has migrated. Anything written after the archive was
    taken is lost — that is the cost of rolling back, stated plainly.
  - **Upgrade the server before the clients** — keep the existing paragraph.
  - A pointer to the rehearsal as the evidence, so a reader can see the
    procedure is executed and not merely asserted.
- **Why**: BPR-004 is a promise to owners, and an owner meets it through the
  documentation, not through the harness. The harness only keeps the
  documentation true.
- **Validate**: `cd Server && go run -tags otel,wazero ./cmd/gendocs` leaves no
  diff (the section is hand-written prose, not a `gendocs:` block, but the
  regeneration must stay clean), and prettier passes.

## Validation

Run the `ci-check` skill, not an ad-hoc `go build && go test` — CI compiles four
build-tag variants and runs a deadlock pass.

| Gate                                     | Command                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Harness unit tests                       | `cd Server && go test ./cmd/smoke/`                                        |
| Existing smoke unchanged                 | `cd Server && go build -o chatserver . && go run ./cmd/smoke ./chatserver` |
| Standalone rehearsal                     | `go run ./cmd/smoke -upgrade -from ./chatserver-alpha4 ./chatserver`       |
| Container rehearsal                      | Task 5's four commands                                                     |
| Lint (incl. the widened gosec exclusion) | `ci-check` skill                                                           |
| Workflow syntax                          | `actionlint`, `koalaman/shellcheck:v0.9.0`                                 |

## Risks

| Risk                                                                          | Likelihood | Impact | Mitigation                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| The rehearsal passes while still running the **old** binary                   | Medium     | High   | Phase 5 asserts the reported version changed; nothing else in the run can substitute for it                                    |
| Rate limits (setup 5/min, uploads 10/min) trip during the fixture             | Low        | Medium | One setup call and one upload per run; the harness never retries them in a loop                                                |
| A future release drops an alpha.4 column and the old binary fails on rollback | Medium     | Medium | That is the rehearsal's job to surface. It fails at phase 8 with the old server's log, which is the signal to document a floor |
| The alpha.4 asset disappears or its checksum file changes                     | Low        | Medium | The workflow verifies the download against `checksums.sha256` and fails loudly rather than rehearsing an unknown binary        |
| Nightly flake from a slow cold boot (LiveKit auto-download)                   | Medium     | Low    | The fixture writes `voice.auto_download_livekit: false` into the config before the first boot; `bootTimeout` stays at 90s      |
| The container leg's `docker cp` archive misses volume-only state              | Low        | High   | `archive`/`restore` copy `/app/data` wholesale, not a file list — the same directory the named volume maps                     |

## Out of scope

- **Interrupted upgrade and interrupted migration** — B6-11's failure drills.
- **Backup/restore as a drill** (disk-full, corrupt input, restore under active
  readers) — also B6-11. B6-8 uses a backup, it does not qualify backups.
- **The self-update handoff** (`.old` rotation, NSSM/systemd relaunch). The
  updater's GitHub base URL is test-only, so no offline rehearsal can drive it;
  it stays covered by `Server/updater`'s tests and by the release-time manual
  step already described in `docs/deployment.md`.
- **ARM64 upgrade** — alpha.4 published no ARM64 server asset, so there is no
  published alpha to upgrade _from_. It becomes rehearsable one release after
  B6-1's assets ship; say so rather than faking a from-side.
- **Client-side upgrade** — B7.

## Open questions for the owner

1. **Should the container leg run in PR CI as well as nightly?** Not taken here:
   it needs an alpha-source image build (~3-5 min) on every PR. The standalone
   leg covers harness regressions pre-merge; the container leg runs nightly and
   at release.
2. **Should a failed rehearsal block a release?** This plan assumes **yes** —
   `release.yml` calls it before anything is signed or pushed, matching how
   `docker-smoke.sh` already gates the image push.

## Acceptance

- [ ] A published alpha.4 server is upgraded to HEAD and back, on standalone and Docker, by one harness
- [ ] Data, attachments, configuration, all three credential files and backups are asserted byte-identical across the upgrade
- [ ] A pre-upgrade session token still authenticates, and the pre-upgrade attachment still downloads byte-identical, after the upgrade
- [ ] The reported version actually changed across the upgrade, and changed back across the rollback
- [ ] The rollback procedure is documented with what each omission costs, and the forward-only migration limit is stated plainly
- [ ] The rehearsal runs nightly, on `workflow_dispatch`, and at release before anything is signed
- [ ] `ci-check` green across all four build-tag variants
