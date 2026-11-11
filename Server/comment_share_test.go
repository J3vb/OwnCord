package main

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// commentShareTotalCeiling caps the share of non-blank production Go lines
// that are comments across the whole Server tree (docs/code-style.md
// "Comments"). It and the per-package rows below only go down.
const commentShareTotalCeiling = 16.0

// commentShareMinLines is the size below which a package is not judged on its
// own: a handful of lines makes the share noise. It still counts in the total.
const commentShareMinLines = 200

// commentShareCeilings holds the packages allowed above commentShareDefault, in
// percent. ws, auth, permissions, safefetch, syncutil and netclass carry lock
// order and threat reasoning, invariants documents each check, and the rest sat
// just above the default when the rule landed. Lower a row when a package drops
// below it; never raise one or add one.
var commentShareCeilings = map[string]float64{
	"auth":        19.0,
	"internal":    17.5,
	"invariants":  20.0,
	"metrics":     16.5,
	"netclass":    16.5,
	"permissions": 24.5,
	"safefetch":   22.5,
	"syncutil":    20.0,
	"telemetry":   15.5,
	"ws":          20.5,
}

// commentShareDefault is the ceiling for a package with no row.
const commentShareDefault = 15.0

type commentCount struct{ comments, lines int }

func (c commentCount) share() float64 {
	if c.lines == 0 {
		return 0
	}
	return 100 * float64(c.comments) / float64(c.lines)
}

// countCommentShare walks the production Go files under root and counts, per
// top-level package directory, non-blank lines and the ones that are line
// comments. Directives are code, not prose, and generated files are skipped.
func countCommentShare(t *testing.T, root string) map[string]commentCount {
	t.Helper()
	counts := map[string]commentCount{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "testdata", "dbgen", "node_modules", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		pkg := "."
		if dir := filepath.ToSlash(filepath.Dir(rel)); dir != "." {
			pkg = strings.SplitN(dir, "/", 2)[0]
		}
		c, generated, err := countFile(path)
		if err != nil {
			return err
		}
		if generated {
			return nil
		}
		total := counts[pkg]
		total.comments += c.comments
		total.lines += c.lines
		counts[pkg] = total
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return counts
}

func countFile(path string) (commentCount, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return commentCount{}, false, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	var c commentCount
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "// Code generated ") && strings.HasSuffix(line, " DO NOT EDIT.") {
			return commentCount{}, true, nil
		}
		c.lines++
		if strings.HasPrefix(line, "//") && !isDirective(line) {
			c.comments++
		}
	}
	if err := sc.Err(); err != nil {
		return commentCount{}, false, fmt.Errorf("read %s: %w", path, err)
	}
	return c, false, nil
}

func isDirective(line string) bool {
	for _, p := range []string{"//go:", "//nolint", "//invariant:", "//export ", "//line "} {
		if strings.HasPrefix(line, p) {
			return true
		}
	}
	return false
}

func TestCommentShareStaysUnderCeilings(t *testing.T) {
	counts := countCommentShare(t, ".")
	var all commentCount
	pkgs := make([]string, 0, len(counts))
	for pkg, c := range counts {
		all.comments += c.comments
		all.lines += c.lines
		pkgs = append(pkgs, pkg)
	}
	sort.Strings(pkgs)
	for _, pkg := range pkgs {
		if counts[pkg].lines < commentShareMinLines {
			continue
		}
		ceiling, ok := commentShareCeilings[pkg]
		if !ok {
			ceiling = commentShareDefault
		}
		if got := counts[pkg].share(); got > ceiling {
			t.Errorf("%s: %.1f%% of its non-blank lines are comments, over its %.1f%% ceiling (%d of %d). "+
				"Comments say why, not what: see docs/code-style.md \"Comments\".",
				pkg, got, ceiling, counts[pkg].comments, counts[pkg].lines)
		}
	}
	if got := all.share(); got > commentShareTotalCeiling {
		t.Errorf("Server: %.1f%% of non-blank production lines are comments, over the %.1f%% ceiling (%d of %d)",
			got, commentShareTotalCeiling, all.comments, all.lines)
	}
}

func TestCommentShareCeilingsStayInBounds(t *testing.T) {
	for pkg, ceiling := range commentShareCeilings {
		if ceiling <= commentShareDefault {
			t.Errorf("%s: ceiling %.1f%% is not above the default %.1f%%; delete the row", pkg, ceiling, commentShareDefault)
		}
		if _, err := os.Stat(pkg); err != nil {
			t.Errorf("%s: row names a package that does not exist", pkg)
		}
	}
}
