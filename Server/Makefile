# OwnCord Server — developer convenience targets
#
# sqlc-generate  Regenerate type-safe Go from db/queries/sqlite/*.sql
# sqlc-verify    Fail if committed dbgen output is stale (used by CI)
# sqlc-install   Install the pinned sqlc version into $GOBIN

SQLC_VERSION := $(shell cat sqlc.version)

.PHONY: sqlc-install sqlc-generate sqlc-verify

sqlc-install:
	go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

sqlc-generate:
	sqlc generate

sqlc-verify:
	sqlc generate
	@git diff --exit-code db/dbgen || ( \
		echo "ERROR: db/dbgen is stale. Run 'make sqlc-generate' and commit the result." ; \
		exit 1 ; \
	)
