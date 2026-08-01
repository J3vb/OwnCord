package db

import (
	"context"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// fuzzTestHelper is the slice of *testing.T / *testing.F that
// fuzzOpenMigratedMemory needs; both embed testing.common and satisfy it.
type fuzzTestHelper interface {
	Helper()
	Fatalf(format string, args ...any)
	Cleanup(func())
}

// fuzzOpenMigratedMemory opens an in-memory DB with the full schema (including
// messages_fts) applied, so the fuzz target can run sanitizeFTSQuery's output
// through a real FTS5 MATCH and catch anything that still makes SQLite choke
// -- not just anything that looks dangerous on paper.
func fuzzOpenMigratedMemory(t fuzzTestHelper) *DB {
	t.Helper()
	database, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(':memory:'): %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return database
}

// FuzzSanitizeFTSQuery guards BUG-090 (byte-boundary truncation producing
// invalid UTF-8) against regressions and checks the broader contract: the
// output is always valid UTF-8, built only from the documented charset, at
// most 200 runes, and never makes messages_fts MATCH return a syntax error.
func FuzzSanitizeFTSQuery(f *testing.F) {
	seeds := []string{
		"",
		"hello world",
		`hello "world" AND (test) NOT foo*`,
		"foo NEAR bar",
		"foo NEAR/2 bar",
		"content:foo",
		"*",
		"**",
		"((()))",
		"-",
		"- - -",
		"AND",
		"OR",
		"NOT",
		"NEAR",
		"a OR b AND c",
		strings.Repeat("漢", 199) + "x", // 200 runes, 3-byte each: right at the boundary
		strings.Repeat("漢", 200),       // exactly 200 CJK runes
		strings.Repeat("漢", 210),       // BUG-090: truncation used to split a rune
		strings.Repeat("a", 199) + "漢", // ASCII run then one multi-byte rune at the cut
		strings.Repeat("😀", 210),       // 4-byte runes (surrogate-pair range)
		strings.Repeat("a-b ", 100),
		"col1:foo col2:bar",
		"\"unterminated quote",
		"a\x00b",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	database := fuzzOpenMigratedMemory(f)

	f.Fuzz(func(t *testing.T, q string) {
		got := sanitizeFTSQuery(q)

		if !utf8.ValidString(got) {
			t.Fatalf("sanitizeFTSQuery(%q) produced invalid UTF-8: %q", q, got)
		}
		if n := utf8.RuneCountInString(got); n > 200 {
			t.Fatalf("sanitizeFTSQuery(%q) returned %d runes, want <= 200", q, n)
		}
		for _, r := range got {
			if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != ' ' && r != '-' {
				t.Fatalf("sanitizeFTSQuery(%q) kept disallowed rune %q in %q", q, r, got)
			}
		}
		// NOTE: the 200-rune truncation happens AFTER the TrimSpace call, so
		// truncated output may legitimately end in whitespace (or, more
		// interestingly, a lone trailing "-") -- that is not itself a
		// contract violation as long as FTS5 still accepts it below.

		// The real contract: whatever comes out must not make FTS5 choke on
		// the MATCH clause. A "no rows" result is fine; a query-syntax error
		// is the bug (an FTS5 operator keyword or bare "-" slipping through
		// unescaped).
		if _, err := database.SearchMessages(context.Background(), got, nil, 10); err != nil {
			t.Fatalf("SearchMessages with sanitized query %q (from %q) errored: %v", got, q, err)
		}
	})
}
