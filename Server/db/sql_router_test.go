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
		// A CTE-led read is misrouted to the writer today — safe but
		// serializing. If isReadOnlySQL ever learns WITH, flip this to true
		// after auditing for writable CTEs (INSERT ... WITH).
		{"WITH cte AS (SELECT 1) SELECT * FROM cte", false},
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
