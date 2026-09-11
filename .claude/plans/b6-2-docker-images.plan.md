# Plan: B6-2 — Docker images

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-2 — Docker images (roadmap workstream 2)
**Complexity**: Medium
**Drafted**: 2026-09-11 at `dev` `944303ff`

## Summary

`ghcr.io/j3vb/owncord-server` already exists, already runs as uid 65532 on
distroless, and is already boot-smoked from three workflows. Two things the
milestone promises are still missing: the image is **`linux/amd64` only**, and
the smoke proves only "the container starts and answers `healthcheck`" — it
never stops the container, never checks the exit code, never replaces the
container against the same volume, and never asserts a single privilege
property. B6-2 closes both: publish a two-architecture manifest, and deepen
`docker-smoke.sh` into the same lifecycle `cmd/smoke` proves for standalone —
**boots, migrates, becomes healthy, drains cleanly, and comes back on the same
data with minimal privilege**.

This milestone is mostly _deepening_ existing files. The image, the registry
push, the release gating and the three call sites all exist; nothing here is a
new subsystem.

## Verify before you implement

Facts established from source at `944303ff`; re-check any a parallel branch may
have moved.

| Claim                                              | Status        | Evidence                                                                                                                     |
| -------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The published image is amd64 only                  | **Confirmed** | `.github/workflows/release.yml:486-495` — the push step sets no `platforms:`, so buildx emits only the runner's architecture |
| The image already runs unprivileged                | **Confirmed** | `Server/Dockerfile` — `USER 65532:65532` on `gcr.io/distroless/static-debian12` (no shell, no package manager)               |
| The smoke never stops the container                | **Confirmed** | `Server/scripts/docker-smoke.sh:29-45` — `docker run -d`, poll, `docker logs`, exit. Teardown is `docker rm -f` in the trap  |
| The smoke never mounts a volume                    | **Confirmed** | Same block — a bare `docker run`, deliberately. Persistence is therefore asserted nowhere                                    |
| One script backs all three workflows               | **Confirmed** | `ci.yml:604`, `release.yml:483`, `nightly-docker-smoke.yml:75` all call `Server/scripts/docker-smoke.sh`                     |
| The push is already gated on a human               | **Confirmed** | `release.yml:432` — `environment: release` carries a required reviewer                                                       |
| A native ARM64 Linux runner is proven here         | **Confirmed** | `release.yml` `release-client-linux-arm64` and B6-1's `release-server` matrix both use `ubuntu-22.04-arm`                    |
| Both base images are multi-arch                    | **Confirmed** | `golang:1.27-bookworm` and `gcr.io/distroless/static-debian12` publish `linux/arm64` manifests                               |
| The build is pure Go, so cross-compilation is free | **Confirmed** | `Server/go.mod` uses `modernc.org/sqlite`; the Dockerfile already sets `CGO_ENABLED=0`                                       |
| The image declares no `HEALTHCHECK`                | **Confirmed** | `Server/Dockerfile` — the probe exists only in `docker-compose.yml:47-52`, so a bare `docker run` reports no health at all   |
| `docker cp` works without a shell in the image     | **Confirmed** | `docker cp` is implemented by the daemon against the container filesystem, not by exec — the distroless constraint is moot   |
| The default database path is `data/chatserver.db`  | **Confirmed** | `Server/config/config.go:410`                                                                                                |
| `docker cp` works against a **stopped** container  | **Confirmed** | Required by phase 4 below; the drain assertion needs the container to stay around after it exits                             |

## Patterns to Mirror

| Category           | Source                                                | Pattern                                                                                              |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Lifecycle phases   | `Server/cmd/smoke/main.go:82-131`                     | boot → assert artefacts exist → drain → restart on the SAME state → assert nothing was recreated     |
| Restart honesty    | `Server/cmd/smoke/main.go:117-121`                    | "a restart that re-created the database would pass for the wrong reason" — assert reuse, not success |
| Shell smoke style  | `Server/scripts/docker-smoke.sh:14-45`                | `set -euo pipefail`, `trap cleanup EXIT`, 30×1s poll, `::error::` annotations, logs on failure       |
| Shared smoke       | `ci.yml` + `release.yml` + `nightly-docker-smoke.yml` | One script from every call site, so a regression fails pre-merge instead of at tag time              |
| ARM64 runner       | `release.yml` `release-client-linux-arm64`            | `runs-on: ubuntu-22.04-arm`, otherwise identical to the x86_64 job                                   |
| Action pinning     | every `uses:` line                                    | Full commit SHA plus a `# vX.Y.Z` comment                                                            |
| Gated push         | `release.yml:432`                                     | `environment: release` on any job that writes to ghcr.io                                             |
| Compose annotation | `docker-compose.yml:47-52`                            | Every non-obvious directive carries the reason it exists, not what it does                           |

## Files to Change

| File                                         | Action | Why                                                                                     |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `Server/Dockerfile`                          | UPDATE | Cross-compile per `TARGETARCH` (no QEMU), declare a `HEALTHCHECK`                       |
| `Server/scripts/docker-smoke.sh`             | UPDATE | Boot → migrate → healthy → privilege → drain → **replace container on the same volume** |
| `Server/docker-compose.yml`                  | UPDATE | `cap_drop`, `no-new-privileges`; drop the healthcheck now inherited from the image      |
| `.github/workflows/release.yml`              | UPDATE | Smoke both architectures natively, then push one two-platform manifest                  |
| `.github/workflows/ci.yml`                   | UPDATE | Add the arm64 row so an ARM regression fails pre-merge                                  |
| `.github/workflows/nightly-docker-smoke.yml` | UPDATE | Stay in sync with `ci.yml`'s job, as its own comment requires                           |
| `docs/deployment.md`                         | UPDATE | Name both architectures and the privilege posture an owner gets                         |
| `CHANGELOG.md`                               | UPDATE | Unreleased entry — ARM64 image, deeper container smoke, hardened compose                |
| `docs/plans/b6-*.prd.md`                     | UPDATE | B6-1 row → `complete`; B6-2 row → `in-progress` + this plan                             |

## Tasks

### Task 1: Cross-compile the image per target architecture

- **Action**: Pin the builder stage to the **build** platform and select the Go
  target from the **target** platform:
  `FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS builder`, then
  `ARG TARGETARCH` and `GOARCH=${TARGETARCH}` on the `go build` line. The final
  stage stays unpinned so buildx picks the right distroless base per platform.
- **Why**: without `--platform=$BUILDPLATFORM`, a two-platform buildx run
  emulates the whole **compiler** under QEMU for the arm64 leg — minutes of
  wall clock for a binary the amd64 toolchain can cross-compile in seconds,
  because nothing here is cgo.
- **Mirror**: the existing `CGO_ENABLED=0 GOOS=linux` line; only `GOARCH` is new.
- **Validate**: `docker buildx build --platform linux/amd64,linux/arm64 Server/`
  completes, and `docker buildx imagetools inspect` lists two manifest entries.

### Task 2: Give the image its own `HEALTHCHECK`

- **Action**: `HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["/chatserver", "healthcheck"]`.
  Remove the now-duplicated block from `docker-compose.yml`, leaving the comment
  that explains _why_ the binary is its own probe (no shell, no curl) and that
  plain compose only surfaces unhealthy rather than acting on it.
- **Why**: the milestone says an owner runs **the image**. Today health exists
  only for owners who use the shipped compose file; a bare `docker run`,
  Kubernetes, Podman or a Portainer stack sees no health state at all. Defining
  it once on the image means compose inherits it and the two cannot drift.
- **Validate**: `docker inspect -f '{{.State.Health.Status}}'` reports `healthy`
  after a bare `docker run` — which is also what Task 3's smoke asserts.

### Task 3: Deepen the container smoke to the full lifecycle

- **Action**: Rewrite `docker-smoke.sh` around a named volume, in phases that
  mirror `cmd/smoke`:

  1. **Cold boot** on an empty volume with
     `--cap-drop=ALL --security-opt=no-new-privileges:true`, poll to healthy.
  2. **Migrate**: `docker cp` proves `/app/config.yaml` and
     `/app/data/chatserver.db` were created — a booted server that wrote no
     database migrated nothing.
  3. **Privilege**: assert `Config.User` is `65532:65532`,
     `HostConfig.Privileged` is false, and `ALL` is in `CapDrop` — the
     properties, not the flags we happened to pass.
  4. **Drain**: `docker stop`, then assert exit code **0** within the 20s budget.
     A container killed by the 10s SIGKILL fallback exits 137 and fails here.
  5. **Replace**: `docker rm` the container and start a **new** one on the
     **same** volume; it must reach healthy, the marker file written in phase 2
     must survive, and the database must still be there.

- **Why a new container rather than `docker start`**: `docker start` reuses the
  container's own writable layer, so it would pass even if the volume were never
  mounted. Replacing the container is also the real upgrade path
  (`docker compose pull && up -d`), which is what `docs/deployment.md:129` tells
  owners is the **only** supported upgrade.
- **Why the marker file**: it is the one assertion that cannot pass for the
  wrong reason. A second boot re-creates `config.yaml` legitimately (it lives in
  the image layer, not the volume) and re-migrating into an empty volume would
  also produce a `chatserver.db` — so neither file alone distinguishes "the
  volume persisted" from "the server started over".
- **Keep**: the bare-run contract the current script's comment defends — no
  config mount, no env. The volume is mounted at `/app/data`, which the
  Dockerfile already declares a `VOLUME`, so this changes nothing about the
  "boots on its own" property the alpha.3 failure taught us to keep testing.
- **Mirror**: `Server/cmd/smoke/main.go` phase for phase, and the existing
  script's annotation and teardown style.
- **Validate**: run it locally against a locally built image; then point it at a
  deliberately broken image and confirm each phase fails with its own message.

### Task 4: Smoke both architectures, then push one manifest

- **Action**: Split `release-server-docker` into a `smoke-server-docker` matrix
  job (`ubuntu-latest`/amd64 and `ubuntu-22.04-arm`/arm64, each building with
  `load: true` and running the smoke **natively**) and keep the push job, now
  `needs: smoke-server-docker`, building `platforms: linux/amd64,linux/arm64`
  into a single manifest.
- **Why native runners, not QEMU**: the point of the milestone is a **smoked**
  image. A container run under binfmt emulation does not prove the arm64 image
  works on arm64 hardware — it proves QEMU can interpret it, and it hides
  exactly the class of defect B6-1's workstream-13 blockers were (architecture
  assumptions), while making the drain timing meaningless.
- **Keep**: `environment: release` on the push job, and nothing pushed before
  every smoke leg is green.
- **Mirror**: `release.yml`'s existing job/`needs` graph and B6-1's matrix.
- **Validate**: `actionlint`, and a `workflow_dispatch` dry run on a fork.

### Task 5: Pre-merge coverage and documentation

- **Action**: Turn `ci.yml`'s `server-docker-build` and
  `nightly-docker-smoke.yml`'s job into the same two-row matrix, so an arm64
  regression fails on the PR rather than at tag time. Document both
  architectures, the inherited healthcheck, and the privilege flags an owner
  should pass.
- **Mirror**: the "keep in sync" comment already binding those two jobs.
- **Validate**: `ci-check` skill, then `npm run format` on the touched markdown.

## Validation

```bash
# Build and smoke locally (amd64 leg)
docker build -t owncord-smoke:candidate Server/
bash Server/scripts/docker-smoke.sh owncord-smoke:candidate

# Two-platform build resolves and produces two manifest entries
docker buildx build --platform linux/amd64,linux/arm64 Server/

# Full gate before pushing — four build-tag variants plus the deadlock pass.
# Use the ci-check skill, not an ad-hoc `go build && go test`.

# Formatting of the touched workflow and markdown files
npm run format
```

## Risks

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                                                      |
| ------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-22.04-arm` unavailable, leaving the arm64 image unsmoked          | Low        | High   | The runner is already proven in `release.yml`. If it disappears, publish arm64 **labelled "built, not smoked"**, never silently |
| Pushing a manifest is not atomic with the smoke; a smoked digest ≠ pushed | Medium     | Medium | The push rebuilds from the same commit with GHA cache, so the layers are identical. B6-12 replaces this with a digest pin       |
| `--cap-drop=ALL` breaks a capability the server actually needs            | Low        | High   | Exactly what phase 1 of the smoke exists to catch; the container binds 8443, above the privileged-port range                    |
| Adding a `HEALTHCHECK` changes `docker run` exit semantics for owners     | Low        | Low    | Health state is advisory; nothing in compose acts on it, which the comment already says                                         |
| A second container on the same volume hides a lock the drain never freed  | Low        | High   | Phase 5 only starts after phase 4 asserted exit code 0 — an unclean exit fails before the volume is reused                      |
| The two-platform push doubles build minutes                               | High       | Low    | Cross-compilation (Task 1) keeps the arm64 leg at Go-compile speed; only the smoke legs run real containers                     |

## Open questions for the owner

1. **Should the arm64 image ship in B6-2, or only be qualified?** This plan
   assumes **ship** — the milestone says an owner _runs_ the `linux/arm64`
   image, and B6-1 resolved the same question for standalone assets by shipping.
2. **Is `read_only: true` wanted on the compose service?** Not taken here: the
   server writes its default `config.yaml` into `/app`, so a read-only root
   filesystem turns the documented "boots on its own" behaviour into a boot
   failure for any owner who has not yet mounted a config. `cap_drop: ALL` plus
   `no-new-privileges` gets the privilege reduction without that trade.

## Acceptance

- [ ] The published manifest carries `linux/amd64` **and** `linux/arm64` — awaits a tag run
- [ ] Both architectures are smoked on native runners before anything is pushed
- [ ] The smoke proves boot, migration, health, minimal privilege, clean drain and volume reuse
- [ ] A bare `docker run` reports a health status without a compose file
- [ ] `cap_drop: ALL` and `no-new-privileges` are the documented default posture
- [ ] The same script still backs `ci.yml`, `release.yml` and the nightly
- [ ] `ci-check` green across all four build-tag variants
