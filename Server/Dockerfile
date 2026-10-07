# syntax=docker/dockerfile:1

# ─── Build stage ────────────────────────────────────────────────────────────
# Pinned to the BUILD platform, not the target: a linux/amd64,linux/arm64
# buildx run would otherwise emulate the whole Go toolchain under QEMU for the
# arm64 leg. Nothing here is cgo (modernc.org/sqlite is pure Go), so the host
# toolchain cross-compiles both targets natively via GOARCH below.
# The tag is for humans; the digest is what actually builds. Dependabot's
# `docker` block moves both together, so the tag and the digest cannot drift.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS builder

ARG VERSION=dev
# Supplied by BuildKit per target platform ("amd64", "arm64"). Left empty by a
# plain non-BuildKit `docker build`, where an empty GOARCH means "host arch" —
# which is the right answer for that case.
ARG TARGETARCH

# Bundled LiveKit SFU, so one container serves chat and voice: the server starts
# it as its companion process (voice.livekit_binary, set via ENV below). Fetched
# before the Go sources so a code change never re-downloads it. Pinned per
# architecture by digest and verified with sha256sum, so the build fails rather
# than ship an unverified binary. Bump LIVEKIT_VERSION and both digests together
# with ws.DefaultLiveKitVersion and the livekit image in docker-compose.yml
# (digests: the release's checksums.txt; TestDockerfileBundlesPinnedLiveKit
# pins the version match).
ARG LIVEKIT_VERSION=1.13.7
ARG LIVEKIT_SHA256_AMD64=6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2
ARG LIVEKIT_SHA256_ARM64=5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) sha="${LIVEKIT_SHA256_AMD64}" ;; \
      arm64) sha="${LIVEKIT_SHA256_ARM64}" ;; \
      *) echo "no bundled livekit-server for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    f="livekit_${LIVEKIT_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSL -o "/tmp/${f}" "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/${f}"; \
    echo "${sha}  /tmp/${f}" | sha256sum -c -; \
    tar -xzf "/tmp/${f}" -C / livekit-server; \
    rm "/tmp/${f}"

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
COPY --from=builder /livekit-server /livekit-server

# /app/data is the default data_dir (SQLite DB + uploads).
# Mount a named volume here to persist data across container restarts.
VOLUME ["/app/data"]

# Server listens on this port by default (configurable via config.yaml).
EXPOSE 8443
# Voice media (bundled LiveKit): TCP fallback and the single UDP port above.
EXPOSE 7881/tcp 7882/udp

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

# One container serves chat + voice: the server runs the bundled LiveKit as its
# companion process, as on bare metal. Voice media goes over ONE UDP port so a
# single `-p 7882:7882/udp` (plus 7881/tcp) is all a bare `docker run` needs
# instead of the 50000-60000 range. Override either via the same variables; the
# two-container docker-compose.yml clears them because LiveKit is separate there.
ENV OWNCORD_VOICE_LIVEKIT_BINARY=/livekit-server \
    OWNCORD_VOICE_UDP_PORT=7882

# Run as non-root (distroless provides uid 65532 = "nonroot").
USER 65532:65532

# Compose's 10s default would SIGKILL a drain mid-flush. Declared on the image
# so every runtime gets the server's own stop signal.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/chatserver"]
