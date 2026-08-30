# OwnCord Server — developer convenience targets
#
# test               Run the test suite the way CI does (race + timeout).
# test-deadlock      Run the deadlock-detection pass CI also runs.
# fuzz               Actually fuzz. CI (and plain `go test`) only replays the
#                    committed seed corpus; this generates new inputs.
# sim                Run the seeded hub simulation long: 10,000 steps per seed.
#                    CI runs its 200 x 20 default through `go test -race ./...`.
# bench-baseline     Record a benchmark baseline into docs/plans/. Recorded, not
#                    gated: no CI step reads it (that gate is B6's).
# cover              Per-package coverage (what CI uploads) + a function summary.
# cover-all          Cross-package coverage — the honest number. See below.
# sqlc-generate      Regenerate type-safe Go from sqlc.yaml (db/dbgen).
# sqlc-verify        Fail if the committed dbgen output is stale (used by CI).
# sqlc-install       Install the pinned sqlc version into $GOBIN.
# protocol-generate  Regenerate WS message-type constants (Go + TS) from ../protocol/schema.json.
# protocol-verify    Fail if the committed protocol constants are stale (used by CI).
# docs-generate      Regenerate the route/table/config index blocks in ../docs.
# docs-verify        Fail if those generated blocks are stale (used by CI).
# otel-up            Start Jaeger + Prometheus for local tracing development.
# otel-down          Stop and remove the OTel dev containers.

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: test test-deadlock fuzz sim bench-baseline cover cover-all sqlc-install sqlc-generate sqlc-verify \
        protocol-generate protocol-verify docs-generate docs-verify otel-up otel-down

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

# The seeded hub simulation (ws/hub_sim_test.go), long form: the default 20
# seeds at 10,000 steps each instead of the 200 CI runs. A failure prints a
# ready-to-paste OWNCORD_SIM_SEED=... OWNCORD_SIM_STEPS=... replay line.
#
# No make on Windows? OWNCORD_SIM_STEPS=10000 go test -race -count=1 -run '^TestHubSimulation$' ./ws/
SIMSTEPS ?= 10000
sim:
	OWNCORD_SIM_STEPS=$(SIMSTEPS) go test -race -count=1 -run '^TestHubSimulation$$' ./ws/

# The six Benchmark* the baseline is made of, six repeats each, through
# benchstat into docs/plans/b3-bench-baseline-<date>.md. Deliberately local and
# deliberately in no workflow: baselines are recorded, not gated (B6 owns the
# gate). The script fails if any expected benchmark name is missing from the
# run, so a rename cannot silently shorten the table.
#
# No make on Windows? ./scripts/bench-baseline.sh from Server/ in Git Bash.
BENCH_COUNT ?= 6
bench-baseline:
	BENCH_COUNT=$(BENCH_COUNT) ./scripts/bench-baseline.sh

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
	@go tool cover -func=coverage-all.out | awk '$$NF=="0.0%"' | sed 's|github.com/J3vb/OwnCord/Server/||'
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
	go run ./cmd/genprotocol

protocol-verify:
	go run ./cmd/genprotocol
	@git diff --exit-code ws/message_types.go ../Client/src/lib/protocolTypes.ts || ( \
		echo "ERROR: generated protocol constants are stale. Run 'make protocol-generate' and commit the result." ; \
		exit 1 ; \
	)

# Route, table and config-key indexes in ../docs. Same shape as the two
# generator checks above: regenerate, then fail on any diff. The tool also
# exits non-zero on its own when a config key is documented nowhere.
#
# -tags otel,wazero is not optional: /metrics mounts only when the otel build
# supplies a Prometheus handler, so the default build would generate an index
# missing a production route. The tool refuses to run without it.
docs-generate:
	go run -tags otel,wazero ./cmd/gendocs

docs-verify:
	go run -tags otel,wazero ./cmd/gendocs
	@git diff --exit-code ../docs/api.md ../docs/schema.md ../docs/server-configuration.md || ( \
		echo "ERROR: generated documentation blocks are stale. Run 'make docs-generate' and commit the result." ; \
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
