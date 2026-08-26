# OwnCord Server — developer convenience targets
#
# test               Run the test suite the way CI does (race + timeout).
# test-deadlock      Run the deadlock-detection pass CI also runs.
# fuzz               Actually fuzz. CI (and plain `go test`) only replays the
#                    committed seed corpus; this generates new inputs.
# cover              Per-package coverage (what CI uploads) + a function summary.
# cover-all          Cross-package coverage — the honest number. See below.
# sqlc-generate      Regenerate type-safe Go from sqlc.yaml (db/dbgen).
# sqlc-verify        Fail if the committed dbgen output is stale (used by CI).
# sqlc-install       Install the pinned sqlc version into $GOBIN.
# protocol-generate  Regenerate WS message-type constants (Go + TS) from docs/protocol-schema.json.
# protocol-verify    Fail if the committed protocol constants are stale (used by CI).
# otel-up            Start Jaeger + Prometheus for local tracing development.
# otel-down          Stop and remove the OTel dev containers.

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: test test-deadlock fuzz cover cover-all sqlc-install sqlc-generate sqlc-verify \
        protocol-generate protocol-verify otel-up otel-down

test:
	go test -race -timeout 20m ./...

test-deadlock:
	go test -tags deadlock -count=1 ./...

# Every Fuzz* target, one at a time. `go test ./...` (and therefore CI) runs a
# Fuzz function against its committed seed corpus only — one pass per seed,
# zero generated inputs — so the harnesses find nothing new until this runs.
# Go fuzzes exactly one target per package per invocation, hence the loop.
#
# Deliberately local-only: a crasher is written to testdata/fuzz/<Target>/<hash>
# and that file IS a working reproducer. This repo is public, so a crasher stays
# uncommitted until its fix exists, then corpus entry and fix land together as
# one regression test.
#
# No make on Windows? The same loop, straight into Git Bash:
#   for pkg in $(go list ./...); do for fn in $(go test -list='^Fuzz' $pkg \
#     2>/dev/null | grep '^Fuzz'); do go test $pkg -run='^$' -fuzz="^$fn$" \
#     -fuzztime=30s || break 2; done; done
FUZZTIME ?= 30s
fuzz:
	@for pkg in $$(go list ./...); do \
	  for fn in $$(go test -list='^Fuzz' $$pkg 2>/dev/null | grep '^Fuzz'); do \
	    echo "── $$pkg $$fn"; \
	    go test $$pkg -run='^$$' -fuzz="^$$fn$$" -fuzztime=$(FUZZTIME) || exit 1; \
	  done; \
	done

# Matches the CI invocation. Note that `go test ./... -coverprofile` instruments
# each package only for itself, so a package whose code is mostly exercised
# through another package's tests reports far lower than its real coverage
# (`service` reads ~37% here versus ~85% cross-package). Use cover-all for the
# number to reason about; this target exists to reproduce the CI artifact.
cover:
	go test ./... -coverprofile=coverage.out -cover
	@go tool cover -func=coverage.out | tail -1

# Cross-package coverage: every package is instrumented for every test binary,
# so code reached indirectly is counted. Prints the functions no test reaches at
# all — the list to work from when closing gaps.
cover-all:
	go test -count=1 -coverpkg=./... -coverprofile=coverage-all.out ./...
	@echo
	@echo "── functions with no coverage ──────────────────────────────────────"
	@go tool cover -func=coverage-all.out | awk '$$NF=="0.0%"' | sed 's|github.com/owncord/server/||'
	@echo
	@go tool cover -func=coverage-all.out | tail -1

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

protocol-generate:
	go run ./scripts/genprotocol

protocol-verify:
	go run ./scripts/genprotocol
	@git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts || ( \
		echo "ERROR: generated protocol constants are stale. Run 'make protocol-generate' and commit the result." ; \
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
