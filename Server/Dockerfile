# syntax=docker/dockerfile:1

# ─── Build stage ────────────────────────────────────────────────────────────
# Pinned to the BUILD platform, not the target: a linux/amd64,linux/arm64
# buildx run would otherwise emulate the whole Go toolchain under QEMU for the
# arm64 leg. Nothing here is cgo (modernc.org/sqlite is pure Go), so the host
# toolchain cross-compiles both targets natively via GOARCH below.
# The tag is for humans; the digest is what actually builds. Dependabot's
# `docker` block moves both together, so the tag and the digest cannot drift.
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS builder

ARG VERSION=dev
# Supplied by BuildKit per target platform ("amd64", "arm64"). Left empty by a
# plain non-BuildKit `docker build`, where an empty GOARCH means "host arch" —
# which is the right answer for that case.
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -o /chatserver \
    -ldflags "-s -w -X main.version=${VERSION}" \
    .

# Skeleton for the runtime image's working dir. The server writes its default
# config.yaml to the cwd and the SQLite DB, cert and uploads under data/, and
# it runs as uid 65532 — so both must be owned by that uid or a bare
# `docker run` dies on boot with "writing default config: permission denied"
# (a WORKDIR created by the final stage is root-owned, and Docker seeds the
# VOLUME's anonymous volume from the image dir, ownership included). Staged
# here because distroless has no shell to chown with.
RUN mkdir -p /skel/app/data && chown -R 65532:65532 /skel/app

# ─── Final stage ─────────────────────────────────────────────────────────────
# gcr.io/distroless/static-debian12: no shell, includes CA certs (needed for
# TLS/ACME) and timezone data. Attack surface is minimal.
# Pinned by digest for the same reason as the builder: the tag is a label, the
# digest is the artifact that ships. Dependabot's `docker` block moves both.
FROM gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2

COPY --from=builder --chown=65532:65532 /skel/app /app
WORKDIR /app

COPY --from=builder /chatserver /chatserver

# /app/data is the default data_dir (SQLite DB + uploads).
# Mount a named volume here to persist data across container restarts.
VOLUME ["/app/data"]

# Server listens on this port by default (configurable via config.yaml).
EXPOSE 8443

# The binary is its own probe: distroless has no shell, no curl and no wget.
# Declared on the IMAGE rather than only in docker-compose.yml so every runtime
# — a bare `docker run`, Podman, Kubernetes, a Portainer stack — gets a health
# state, and so the compose file cannot drift from it. Health is advisory:
# Docker surfaces `unhealthy` (docker ps, events) but does not act on it; pair
# with an external watchdog if you want automatic restarts on a hang.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["/chatserver", "healthcheck"]

# Refuses the in-place self-update endpoint (the binary is image content;
# upgrades are image pulls). See Server/updater/container.go.
ENV OWNCORD_CONTAINER=1

# Run as non-root (distroless provides uid 65532 = "nonroot").
USER 65532:65532

# Compose's 10s default would SIGKILL a drain mid-flush. Declared on the image
# so every runtime gets the server's own stop signal.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/chatserver"]
