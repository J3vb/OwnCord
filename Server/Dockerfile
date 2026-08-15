# syntax=docker/dockerfile:1

# ─── Build stage ────────────────────────────────────────────────────────────
FROM golang:1.26-bookworm AS builder

ARG VERSION=dev

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
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
FROM gcr.io/distroless/static-debian12

COPY --from=builder --chown=65532:65532 /skel/app /app
WORKDIR /app

COPY --from=builder /chatserver /chatserver

# /app/data is the default data_dir (SQLite DB + uploads).
# Mount a named volume here to persist data across container restarts.
VOLUME ["/app/data"]

# Server listens on this port by default (configurable via config.yaml).
EXPOSE 8443

# Refuses the in-place self-update endpoint (the binary is image content;
# upgrades are image pulls). See Server/updater/container.go.
ENV OWNCORD_CONTAINER=1

# Run as non-root (distroless provides uid 65532 = "nonroot").
USER 65532:65532

ENTRYPOINT ["/chatserver"]
