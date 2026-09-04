package db_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// sqlc mixes byte and rune offsets when it strips the `-- name:` comments from
// a query file, so a single non-ASCII character in a comment silently
// truncates the generated SQL of that query and every query after it in the
// file by the byte/rune delta. The damage is invisible at review time (the
// .sql reads fine) and only shows up as a runtime "SQL logic error" from
// whichever query happened to lose its tail.
//
// An em-dash in a comment cost `ORDER BY ... id ASC` its `ASC` and left the
// next query as a spliced fragment of two others. Keeping these files ASCII is
// the cheapest way to make that class of corruption impossible.
func TestQueryFilesAreASCIIOnly(t *testing.T) {
	root := "queries"
	// Not a Skipf: this test IS the guard, and a guard that excuses itself when
	// its subject moves is worse than no guard. If the directory is renamed,
	// the rename fixes this line, not the other way round.
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("no %s directory: %v", root, err)
	}

	var checked int
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".sql") {
			return nil
		}
		checked++
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Errorf("read %s: %v", path, readErr)
			return nil
		}
		for lineNo, line := range strings.Split(string(content), "\n") {
			if utf8.RuneCountInString(line) == len(line) {
				continue
			}
			for _, r := range line {
				if r > 127 {
					t.Errorf("%s:%d contains non-ASCII %q (U+%04X); sqlc truncates generated SQL on non-ASCII. Use ASCII (e.g. \"-\" for an em-dash).",
						path, lineNo+1, r, r)
					break
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if checked == 0 {
		t.Fatalf("no .sql files found under %s; the guard would pass vacuously", root)
	}
}
