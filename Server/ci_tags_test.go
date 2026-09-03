package main

// OC-0398: a test file's //go:build constraint only matters if some `go
// test` invocation in CI actually satisfies it *and* runs that file's
// package. Server/admin/logstream_alloc_test.go carries `!race &&
// !deadlock` — a constraint neither of the two universal legs (`go test
// -race ./...`, `go test -tags deadlock ./...`) can ever satisfy, since each
// leg makes exactly one of those two tags true. The wazero/otel tag-gated
// step didn't run ./admin/... at all. Net effect: the file compiled and ran
// in zero CI legs, silently, while every leg reported green.
//
// This test is deliberately untagged so it itself runs in both universal
// legs (and in a plain `go test ./...` from the Makefile / ci-check skill):
// the check that "every tagged test runs somewhere" must not itself be a
// test that runs nowhere.
import (
	"fmt"
	"go/build/constraint"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// goTestInvocation is one `go test ...` line pulled out of ci.yml: the set
// of build tags it activates (including the implicit "race" tag from
// -race) and the package patterns it runs.
type goTestInvocation struct {
	line     string
	tags     map[string]bool
	packages []string
}

var goTestLineRe = regexp.MustCompile(`\bgo test\b(.*)$`)

func parseGoTestInvocations(ciYML string) []goTestInvocation {
	var out []goTestInvocation
	for _, raw := range strings.Split(ciYML, "\n") {
		m := goTestLineRe.FindStringSubmatch(strings.TrimSpace(raw))
		if m == nil {
			continue
		}
		inv := goTestInvocation{line: strings.TrimSpace(raw), tags: map[string]bool{}}
		fields := strings.Fields(m[1])
		for i := 0; i < len(fields); i++ {
			f := fields[i]
			switch {
			case f == "-race":
				inv.tags["race"] = true
			case f == "-tags":
				if i+1 < len(fields) {
					for _, tag := range strings.Split(fields[i+1], ",") {
						inv.tags[tag] = true
					}
					i++
				}
			case strings.HasPrefix(f, "-tags="):
				for _, tag := range strings.Split(strings.TrimPrefix(f, "-tags="), ",") {
					inv.tags[tag] = true
				}
			case strings.HasPrefix(f, "./"), f == "...":
				inv.packages = append(inv.packages, f)
			}
		}
		if len(inv.packages) > 0 {
			out = append(out, inv)
		}
	}
	return out
}

// packageCovered reports whether one of the invocation's package patterns
// (e.g. "./...", "./plugin/...") includes the package at pkgDir (e.g.
// "admin", "" for the Server root) the way `go test`'s "..." wildcard does.
func packageCovered(patterns []string, pkgDir string) bool {
	pkgDir = filepath.ToSlash(pkgDir)
	for _, p := range patterns {
		if p == "./..." || p == "..." {
			return true // covers every package, including the Server root
		}
		p = strings.TrimSuffix(strings.TrimPrefix(p, "./"), "/...")
		if pkgDir == p || strings.HasPrefix(pkgDir, p+"/") {
			return true
		}
	}
	return false
}

// knownGOOSGOARCH are build-constraint tag names this guard does not
// require an explicit ci.yml `-tags` line for: they're satisfied by which
// runner OS/arch the server-build-test matrix happens to be on, not by a
// CI-managed feature flag like race/deadlock/wazero/otel. Reviewer note on
// OC-0398: "linux/OS-lists (db, ws) are each covered by an existing leg" —
// this is why, and it stays out of scope for this guard.
var knownGOOSGOARCH = map[string]bool{
	"windows": true, "linux": true, "darwin": true, "freebsd": true,
	"openbsd": true, "netbsd": true, "solaris": true, "plan9": true,
	"js": true, "wasip1": true, "android": true, "ios": true, "unix": true,
	"amd64": true, "386": true, "arm": true, "arm64": true, "wasm": true,
	"mips": true, "mips64": true, "mips64le": true, "mipsle": true,
	"ppc64": true, "ppc64le": true, "riscv64": true, "s390x": true,
}

// isConstraintCovered reports whether some invocation both runs pkgDir's
// package and sets tags such that expr evaluates true. Tags outside
// knownGOOSGOARCH must come from an invocation's own -tags/-race flags —
// they are never assumed true, so a positive custom tag with no matching
// ci.yml line (e.g. a future `//go:build integration`) is correctly
// reported uncovered rather than silently passing.
func isConstraintCovered(expr constraint.Expr, pkgDir string, invocations []goTestInvocation) bool {
	for _, inv := range invocations {
		if !packageCovered(inv.packages, pkgDir) {
			continue
		}
		if expr.Eval(func(tag string) bool {
			if knownGOOSGOARCH[tag] {
				return true
			}
			return inv.tags[tag]
		}) {
			return true
		}
	}
	return false
}

// buildConstraintLine returns a test file's //go:build line, scanning every
// line up to the package clause rather than assuming it's line 1 — Go
// itself allows a leading comment block and blank lines before the
// constraint, as long as it precedes `package`.
func buildConstraintLine(src []byte) string {
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "package ") {
			return ""
		}
		if strings.HasPrefix(trimmed, "//go:build") {
			return trimmed
		}
	}
	return ""
}

func TestCITagGatedTestsAreReachable(t *testing.T) {
	ciYML, err := os.ReadFile(filepath.Join("..", ".github", "workflows", "ci.yml"))
	if err != nil {
		t.Fatalf("read .github/workflows/ci.yml: %v (this test expects to run from Server/, as CI and the ci-check skill do)", err)
	}
	invocations := parseGoTestInvocations(string(ciYML))
	if len(invocations) == 0 {
		t.Fatalf("parsed zero `go test` lines out of .github/workflows/ci.yml — the parser or the file's shape moved; fix parseGoTestInvocations")
	}

	var uncovered []string
	err = filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if name == "dbgen" || name == "node_modules" || name == "testdata" ||
				(name != "." && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_"))) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		line := buildConstraintLine(src)
		if line == "" {
			return nil // untagged: already compiled by any plain `./...` leg
		}
		expr, err := constraint.Parse(line)
		if err != nil {
			t.Errorf("%s: unparseable build constraint %q: %v", path, line, err)
			return nil
		}
		pkgDir := filepath.ToSlash(filepath.Dir(path))
		if pkgDir == "." {
			pkgDir = ""
		}
		if !isConstraintCovered(expr, pkgDir, invocations) {
			uncovered = append(uncovered, fmt.Sprintf("%s: %q never runs in any CI `go test` leg for package ./%s/...", path, line, pkgDir))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk Server/ for _test.go files: %v", err)
	}
	if len(uncovered) > 0 {
		t.Fatalf("%d test file(s) with a //go:build constraint that no CI leg satisfies for their package — add a `go test` line to the tag-gated step in .github/workflows/ci.yml (and to .claude/skills/ci-check/SKILL.md) that covers each:\n%s",
			len(uncovered), strings.Join(uncovered, "\n"))
	}
}

// --- Unit coverage for the three gaps the OC-0398 review found in the
// first guard attempt (see .superpowers/findings-ledger.json). Each sub-test
// below is the minimal repro for one gap, independent of the real ci.yml.

func TestGuardClosesReviewedGaps(t *testing.T) {
	t.Run("scans past a leading file comment, not just line 1", func(t *testing.T) {
		src := []byte("// Copyright header.\n// Another line.\n\n//go:build integration\n\npackage foo\n")
		if got := buildConstraintLine(src); got != "//go:build integration" {
			t.Fatalf("buildConstraintLine did not find the constraint past a leading comment: got %q", got)
		}
	})

	t.Run("a positive tag with no matching -tags line anywhere is uncovered, not assumed fine", func(t *testing.T) {
		// No invocation ever sets "integration" — this is the shape of a
		// future //go:build integration file that no CI leg passes.
		invocations := parseGoTestInvocations("run: go test -race ./...\nrun: go test -tags deadlock -count=1 ./...\n")
		expr, err := constraint.Parse("//go:build integration")
		if err != nil {
			t.Fatal(err)
		}
		if isConstraintCovered(expr, "foo", invocations) {
			t.Fatal("a tag no invocation ever sets must not be reported covered")
		}
	})

	t.Run("package match must come from the invocation that actually sets the tag, not any line mentioning the path", func(t *testing.T) {
		// admin/... is only named on an untagged line; a -race line that
		// also happens to run ./... must not "cover" a positive-tag file
		// in admin just because ./... textually contains the package.
		invocations := parseGoTestInvocations("run: go test -race ./...\nrun: go test -count=1 ./admin/...\n")
		expr, err := constraint.Parse("//go:build wazero")
		if err != nil {
			t.Fatal(err)
		}
		if isConstraintCovered(expr, "admin", invocations) {
			t.Fatal("neither invocation sets the wazero tag; a same-package match on an unrelated line must not count as coverage")
		}
	})

	t.Run("./... covers the Server root package, not just subpackages", func(t *testing.T) {
		// Regression: an earlier version of packageCovered trimmed "./..."'s
		// "./" prefix first, leaving "..." (3 chars), then looked for a
		// "/..." suffix (4 chars) that was never there — so the most common
		// pattern in ci.yml matched nothing at all.
		if !packageCovered([]string{"./..."}, "") {
			t.Fatal(`"./..." must cover every package, including the Server root ("")`)
		}
		if !packageCovered([]string{"./..."}, "db") {
			t.Fatal(`"./..." must cover every package, including a subpackage like "db"`)
		}
	})
}
