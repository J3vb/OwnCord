# OwnCord Server — developer convenience targets
#
# sqlc-generate  Regenerate type-safe Go for both the sqlite and postgres
#                engines defined in sqlc.yaml (db/dbgen + db/pgdbgen).
# sqlc-verify    Fail if either committed dbgen output is stale (used by CI).
# sqlc-install   Install the pinned sqlc version into $GOBIN.

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: sqlc-install sqlc-generate sqlc-verify

sqlc-install:
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

sqlc-generate:
	sqlc generate

sqlc-verify:
	sqlc generate
	@git diff --exit-code db/dbgen db/pgdbgen || ( \
		echo "ERROR: generated sqlc output is stale. Run 'make sqlc-generate' and commit the result." ; \
		exit 1 ; \
	)
