package db

import "testing"

// TestIsReadOnlySQL locks the read/write routing classification. Expectations
// are explicit values, NOT derived from sqlc annotations — `INSERT …
// RETURNING` is a `:one` query yet must route to the writer. Anything not
// recognized as read-only must fall to the writer (correct, if slower), so
// the dangerous direction is a write classified as a read.
func TestIsReadOnlySQL(t *testing.T) {
	cases := []struct {
		sql  string
		want bool
	}{
		{"SELECT * FROM users", true},
		{"select id from sessions where token = ?", true},
		{"  \n\tSELECT 1", true},
		{"-- leading comment\nSELECT 1", true},
		{"-- c1\n-- c2\nPRAGMA user_version", true},
		{"PRAGMA integrity_check", true},

		{"INSERT INTO users (username) VALUES (?)", false},
		{"INSERT INTO messages (...) VALUES (...) RETURNING id", false},
		{"UPDATE users SET status = ?", false},
		{"DELETE FROM sessions WHERE expires_at < ?", false},
		{"VACUUM INTO 'x'", false},
		{"ANALYZE", false},
		{"BEGIN IMMEDIATE", false},
		// A CTE-led read goes to the reader; a CTE that leads a write, or
		// carries a write word anywhere, stays on the writer.
		{"WITH cte AS (SELECT 1) SELECT * FROM cte", true},
		{"-- name: X :many\nwith page as (select id from channels) select * from page", true},
		{"WITH c AS (SELECT deleted, updated_at FROM messages) SELECT * FROM c", true},
		{"WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c", false},
		{"WITH c AS (SELECT 1) UPDATE t SET x = 1", false},
		{"WITH c AS (SELECT 1) DELETE FROM t", false},
		{"WITH c AS (SELECT 1) REPLACE INTO t VALUES (1)", false},
		{"WITH c AS (SELECT 1) insert or replace into t values (1)", false},
		{"WITH c AS (SELECT 1) SELECT 1;\nDELETE FROM t", false},
		{"WITH c AS (SELECT 1) DELETE FROM t RETURNING id", false},
		{"WITH(SELECT 1)DELETE FROM t", false},
		{"WITHOUT ROWID", false},
		// Prefix must be a whole keyword, not a prefix match.
		{"SELECTIVE_TABLE_OP something", false},
		{"", false},
		{"-- only a comment", false},
	}
	for _, tc := range cases {
		if got := isReadOnlySQL(tc.sql); got != tc.want {
			t.Errorf("isReadOnlySQL(%q) = %v, want %v", tc.sql, got, tc.want)
		}
	}
}
