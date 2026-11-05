package db

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

// rowCounter returns a function that runs a single-integer query against
// database, for the before/after counts a rollback rehearsal asserts on.
func rowCounter(t *testing.T, database *DB) func(q string, args ...any) int {
	t.Helper()
	return func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := database.QueryRowContext(context.Background(), q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
}

// applyRollbackFile runs every statement of the named embedded reversal
// against database, skipping comment-only statements.
func applyRollbackFile(t *testing.T, database *DB, name string) {
	t.Helper()
	raw, err := rollback.FS.ReadFile(name)
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	for _, stmt := range splitStatements(string(raw)) {
		if sqlText(stmt) == "" {
			continue
		}
		if _, err := database.writer.ExecContext(context.Background(), stmt); err != nil {
			t.Fatalf("%s statement %q: %v", name, stmt, err)
		}
	}
}
