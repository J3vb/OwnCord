# syntax=docker/dockerfile:1

# ─── Build stage ────────────────────────────────────────────────────────────
FROM golang:1.25-bookworm AS builder

ARG VERSION=dev

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -o /chatserver \
    -ldflags "-s -w -X main.version=${VERSION}" \
    .

# ─── Final stage ─────────────────────────────────────────────────────────────
# gcr.io/distroless/static-debian12: no shell, includes CA certs (needed for
# TLS/ACME) and timezone data. Attack surface is minimal.
FROM gcr.io/distroless/static-debian12

WORKDIR /app

COPY --from=builder /chatserver /chatserver

# /app/data is the default data_dir (SQLite DB + uploads).
# Mount a named volume here to persist data across container restarts.
VOLUME ["/app/data"]

# Server listens on this port by default (configurable via config.yaml).
EXPOSE 8443

# Run as non-root (distroless provides uid 65532 = "nonroot").
USER 65532:65532

ENTRYPOINT ["/chatserver"]
