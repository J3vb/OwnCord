package invariants

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFileLimit is the ceiling every _test.go file under Server/ is held to,
// so a reader can load one test file whole. It matches the client's limit for
// *.test.ts. There is no exemption table: a test file over the limit is split
// by topic into a sibling file in the same package.
const TestFileLimit = 1500

// overLimitTestFiles returns "path (N lines)" for every _test.go file under
// root with more than limit lines, skipping the directories the rules skip.
func overLimitTestFiles(root string, limit int) ([]string, error) {
	var over []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(p)
		if err != nil {
			return fmt.Errorf("reading %s: %w", p, err)
		}
		lines := bytes.Count(src, []byte("\n"))
		if lines > limit {
			rel, relErr := filepath.Rel(root, p)
			if relErr != nil {
				rel = p
			}
			over = append(over, fmt.Sprintf("%s (%d lines)", filepath.ToSlash(rel), lines))
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walking %s: %w", root, err)
	}
	return over, nil
}

// TestTestFileSizesAreLive holds the whole tree to TestFileLimit. It first
// proves the sweep can fail, so a walk that visits nothing cannot read green.
func TestTestFileSizesAreLive(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "ws"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, lines int) {
		t.Helper()
		body := "package ws\n" + strings.Repeat("//\n", lines-1)
		if err := os.WriteFile(filepath.Join(dir, "ws", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("at_limit_test.go", TestFileLimit)
	write("over_limit_test.go", TestFileLimit+1)
	write("long_but_plain.go", TestFileLimit+1)
	got, err := overLimitTestFiles(dir, TestFileLimit)
	if err != nil {
		t.Fatalf("sweeping the temp tree: %v", err)
	}
	if len(got) != 1 || !strings.HasPrefix(got[0], "ws/over_limit_test.go") {
		t.Fatalf("temp tree: got %v, want only ws/over_limit_test.go", got)
	}

	over, err := overLimitTestFiles(serverRoot(t), TestFileLimit)
	if err != nil {
		t.Fatalf("sweeping the server tree: %v", err)
	}
	for _, f := range over {
		t.Errorf("%s is over the %d-line test file limit (invariants.TestFileLimit). Split it by topic into a sibling _test.go file.", f, TestFileLimit)
	}
}
