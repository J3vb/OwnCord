# OwnCord Server — developer convenience targets
#
# sqlc-generate  Regenerate type-safe Go from sqlc.yaml (db/dbgen).
# sqlc-verify    Fail if the committed dbgen output is stale (used by CI).
# sqlc-install   Install the pinned sqlc version into $GOBIN.
# otel-up        Start Jaeger + Prometheus for local tracing development.
# otel-down      Stop and remove the OTel dev containers.

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: sqlc-install sqlc-generate sqlc-verify otel-up otel-down

sqlc-install:
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

sqlc-generate:
	sqlc generate

sqlc-verify:
	sqlc generate
	@git diff --exit-code db/dbgen || ( \
		echo "ERROR: generated sqlc output is stale. Run 'make sqlc-generate' and commit the result." ; \
		exit 1 ; \
	)

# Phase B Step 8 — local OTel development stack.
# Starts Jaeger (traces) and Prometheus (metrics) in Docker.
# Jaeger UI:      http://localhost:16686
# Prometheus UI:  http://localhost:9090
# Run the server with: go build -tags otel . && ./owncord-server
otel-up:
	docker compose -f docker-compose.otel.yml up -d

otel-down:
	docker compose -f docker-compose.otel.yml down
