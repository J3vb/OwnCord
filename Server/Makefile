# OwnCord Server — developer convenience targets
#
# sqlc-generate  Regenerate type-safe Go for both the sqlite and postgres
#                engines defined in sqlc.yaml (db/dbgen + db/pgdbgen).
# sqlc-verify    Fail if either committed dbgen output is stale (used by CI).
# sqlc-install   Install the pinned sqlc version into $GOBIN.
# otel-up        Start Jaeger + Prometheus for local tracing development.
# otel-down      Stop and remove the OTel dev containers.

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: sqlc-install sqlc-generate sqlc-verify otel-up otel-down

sqlc-install:
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

sqlc-generate:
	sqlc generate

# Verify only db/dbgen: the committed db/pgdbgen files carry hand-added
# `//go:build postgres` tags that `sqlc generate` strips, so a pgdbgen diff
# is expected noise. pgdbgen is scheduled for removal with the Postgres
# scaffolding; restore it after generating so verify leaves a clean tree.
sqlc-verify:
	sqlc generate
	@git checkout -- db/pgdbgen
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
