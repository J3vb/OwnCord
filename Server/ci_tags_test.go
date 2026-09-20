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
	// run is the -run pattern, decoded, or "" when the invocation runs every
	// test in the packages it names. A pattern narrows what a leg EXECUTES, so
	// a leg that sets the right tags and then filters out the one test that
	// needed them is not coverage. Without this field a future
	// `!race && !deadlock` test added beside the RingBuffer one would be
	// compiled into the plain leg and then filtered out by its -run, silently,
	// which is the same shape of hole as OC-0398 itself.
	run string
}

var goTestLineRe = regexp.MustCompile(`\bgo test\b(.*)$`)

func parseGoTestInvocations(ciYML string) []goTestInvocation {
	var out []goTestInvocation
	for raw := range strings.SplitSeq(ciYML, "\n") {
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
					for tag := range strings.SplitSeq(fields[i+1], ",") {
						inv.tags[tag] = true
					}
					i++
				}
			case strings.HasPrefix(f, "-tags="):
				for tag := range strings.SplitSeq(strings.TrimPrefix(f, "-tags="), ",") {
					inv.tags[tag] = true
				}
			case f == "-run":
				if i+1 < len(fields) {
					inv.run = unquote(fields[i+1])
					i++
				}
			case strings.HasPrefix(f, "-run="):
				inv.run = unquote(strings.TrimPrefix(f, "-run="))
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

// unquote strips one layer of shell quoting. The pattern is read as text out of
// a YAML `run:` block, so a pattern written as -run "^TestX$" arrives with its
// quotes still attached; without this the regex would be anchored on a literal
// quote and match nothing, and the guard would fail on a correct ci.yml.
func unquote(s string) string {
	if len(s) >= 2 {
		first, last := s[0], s[len(s)-1]
		if (first == '\'' && last == '\'') || (first == '"' && last == '"') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

var testFuncRe = regexp.MustCompile(`(?m)^func (Test[A-Za-z0-9_]*)\(`)

// topLevelTests returns the top-level test functions a file declares — the
// names `-run` is matched against. TestMain is excluded because -run never
// applies to it, so requiring a pattern to name it would be a false alarm.
func topLevelTests(src []byte) []string {
	var names []string
	for _, m := range testFuncRe.FindAllSubmatch(src, -1) {
		if name := string(m[1]); name != "TestMain" {
			names = append(names, name)
		}
	}
	return names
}

// runCovers reports whether an invocation's -run pattern would execute every
// test named in tests. An empty pattern runs everything and so covers them all,
// and so does any pattern when the file declares no top-level test at all —
// there is nothing for -run to filter.
func runCovers(pattern string, tests []string) bool {
	if pattern == "" {
		return true
	}
	// `go test -run` splits its pattern on "/" into one pattern per subtest
	// level; only the first part is matched against a top-level test name.
	first, _, _ := strings.Cut(pattern, "/")
	re, err := regexp.Compile(first)
	if err != nil {
		return false // an unparseable pattern cannot be shown to cover anything
	}
	for _, name := range tests {
		if !re.MatchString(name) {
			return false
		}
	}
	return true
}

// packageCovered reports whether one of the invocation's package patterns
// (e.g. "./...", "./plugin/...", "./admin/") includes the package at pkgDir
// (e.g. "admin", "" for the Server root) the way `go test`'s "..." wildcard and
// its plain-directory form both do.
func packageCovered(patterns []string, pkgDir string) bool {
	pkgDir = filepath.ToSlash(pkgDir)
	for _, p := range patterns {
		if p == "./..." || p == "..." {
			return true // covers every package, including the Server root
		}
		// "./admin/...", "./admin" and "./admin/" all name the same package and
		// `go test` accepts every one of them. Trimming only the "/..." suffix
		// left "admin/" for the trailing-slash form, which then matched
		// nothing — so a contributor writing the shortest spelling was told
		// their leg covered no package at all.
		p = strings.TrimSuffix(strings.TrimPrefix(p, "./"), "/...")
		p = strings.TrimSuffix(p, "/")
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
// package, sets tags such that expr evaluates true, and — when it carries a
// -run pattern — would actually execute every top-level test the constrained
// file declares. Tags outside knownGOOSGOARCH must come from an invocation's
// own -tags/-race flags — they are never assumed true, so a positive custom tag
// with no matching ci.yml line (e.g. a future `//go:build integration`) is
// correctly reported uncovered rather than silently passing.
func isConstraintCovered(expr constraint.Expr, pkgDir string, tests []string, invocations []goTestInvocation) bool {
	for _, inv := range invocations {
		if !packageCovered(inv.packages, pkgDir) {
			continue
		}
		if !runCovers(inv.run, tests) {
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
	for line := range strings.SplitSeq(string(src), "\n") {
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
		if !isConstraintCovered(expr, pkgDir, topLevelTests(src), invocations) {
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
		if isConstraintCovered(expr, "foo", nil, invocations) {
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
		if isConstraintCovered(expr, "admin", nil, invocations) {
			t.Fatal("neither invocation sets the wazero tag; a same-package match on an unrelated line must not count as coverage")
		}
	})

	t.Run("a -run filter that would skip the constrained file's test is uncovered", func(t *testing.T) {
		// The plain admin leg is narrowed with -run so it stops re-running the
		// package the universal legs already cover. That narrowing is only safe
		// while the pattern still names every test the constrained files
		// declare, so this is the gap the guard has to close: tags and package
		// both match, and the filter still excludes the test.
		expr, err := constraint.Parse("//go:build !race && !deadlock")
		if err != nil {
			t.Fatal(err)
		}
		tests := []string{"TestRingBuffer_WriteDoesNotAllocate"}

		excludes := parseGoTestInvocations(`run: go test -count=1 -run '^TestSomethingElse$' ./admin/`)
		if isConstraintCovered(expr, "admin", tests, excludes) {
			t.Fatal("a -run pattern matching none of the file's tests must not count as coverage")
		}

		// ...and a pattern that covers only SOME of them is caught too, which is
		// the shape a second `!race && !deadlock` test would create. Written as a
		// literal rather than `append(tests, ...)` so the slice is not grown in
		// place for a one-off case (prealloc).
		partial := parseGoTestInvocations(`run: go test -count=1 -run '^TestRingBuffer_WriteDoesNotAllocate$' ./admin/`)
		twoTests := []string{"TestRingBuffer_WriteDoesNotAllocate", "TestSecondPlainOnlyTest"}
		if isConstraintCovered(expr, "admin", twoTests, partial) {
			t.Fatal("a -run pattern that covers some but not all of the file's tests must not count as coverage")
		}

		// The real ci.yml line, quotes and all, does cover it.
		covering := parseGoTestInvocations(`run: go test -count=1 -run '^TestRingBuffer_WriteDoesNotAllocate$' ./admin/`)
		if !isConstraintCovered(expr, "admin", tests, covering) {
			t.Fatal("the plain leg's -run pattern names the constrained test; it must be reported covered")
		}
	})

	t.Run("quotes around a -run pattern are stripped, so a correct ci.yml is not a false alarm", func(t *testing.T) {
		for _, line := range []string{
			`run: go test -run '^TestX$' ./admin/`,
			`run: go test -run "^TestX$" ./admin/`,
			`run: go test -run=^TestX$ ./admin/`,
			`run: go test -run ^TestX$ ./admin/`,
		} {
			invocations := parseGoTestInvocations(line)
			if len(invocations) != 1 || invocations[0].run != "^TestX$" {
				t.Fatalf("%q parsed to run=%q, want ^TestX$", line, invocations[0].run)
			}
		}
	})

	t.Run("only the first -run segment is matched against a top-level test name", func(t *testing.T) {
		// `go test -run TestX/sub` still runs TestX; treating the whole string
		// as one regex would fail to match and report a false alarm.
		if !runCovers("^TestX$/sub", []string{"TestX"}) {
			t.Fatal("a subtest-qualified pattern must still cover its top-level test")
		}
	})

	t.Run("TestMain is not something -run has to name", func(t *testing.T) {
		// -run never filters TestMain, so a pattern need not match it and
		// requiring it to would fail every package that declares one.
		src := []byte("func TestMain(m *testing.M) {\n}\n\nfunc TestReal(t *testing.T) {\n}\n")
		got := topLevelTests(src)
		if len(got) != 1 || got[0] != "TestReal" {
			t.Fatalf("topLevelTests returned %v, want [TestReal]", got)
		}
		if !runCovers("^TestReal$", got) {
			t.Fatal("a pattern naming the file's only real test must cover it despite TestMain")
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
		// Regression: the trailing-slash and bare forms are what a contributor
		// writes when narrowing a leg, and `go test` accepts both. Trimming
		// only "/..." left "admin/" and matched nothing, so a correct leg was
		// reported as covering no package.
		for _, form := range []string{"./admin", "./admin/", "./admin/..."} {
			if !packageCovered([]string{form}, "admin") {
				t.Fatalf(`%q must cover the "admin" package`, form)
			}
			if packageCovered([]string{form}, "api") {
				t.Fatalf(`%q must not cover the "api" package`, form)
			}
		}
	})
}
