package main

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The inventory table in this document is generated (`go run ./cmd/dbinventory`)
// and pasted in by hand, and the prose around it quotes its counts. Nothing
// compared the two until this test: the document went stale twice, and the
// second repair still left the disposition table contradicting the block
// underneath it. Both halves are checked here, against the tree.
const (
	boundariesDoc = "../../../docs/architecture/server-boundaries.md"
	blockStart    = "<!-- dbinventory:start -->"
	blockEnd      = "<!-- dbinventory:end -->"
	serverRoot    = "../.."
)

// TestServerBoundariesDocIsCurrent fails when the generated block no longer
// matches the tree, or when a prose count no longer matches the block.
//
// The comparison is on normalised content, not bytes: prettier re-pads the
// pasted table's columns on every commit, so a byte comparison would fail on
// every run for a reason nobody can fix.
//
// RUN IT WITH -count=1. The document is outside this module, so Go's test
// cache does not record it as an input: edit a count, re-run a plain
// `go test ./...`, and the answer comes back "(cached) ok" without the file
// being opened. ci.yml and scripts/run.mjs both give it its own -count=1 step
// for that reason.
func TestServerBoundariesDocIsCurrent(t *testing.T) {
	rows, err := inventory(serverRoot)
	if err != nil {
		t.Fatalf("inventory(%q): %v", serverRoot, err)
	}
	var buf bytes.Buffer
	if problems := printTable(&buf, rows); problems > 0 {
		t.Fatalf("inventory reports %d unlisted importer(s) or stale allowlist row(s):\n%s",
			problems, buf.String())
	}
	generated := buf.String()

	// Not a Skipf: a gate that excuses itself when its subject moves is worse
	// than no gate (the same lesson as TestQueryFilesAreASCIIOnly).
	raw, err := os.ReadFile(boundariesDoc)
	if err != nil {
		t.Fatalf("read %s: %v", boundariesDoc, err)
	}
	doc := string(raw)

	documented, before, after, err := splitBlock(doc)
	if err != nil {
		t.Fatalf("%s: %v", boundariesDoc, err)
	}

	want, got := normalize(generated), normalize(documented)
	if !slices.Equal(want, got) {
		t.Errorf("the dbinventory block in %s is stale.\n%s\n\nRegenerate it:\n"+
			"  cd Server && go run ./cmd/dbinventory\n"+
			"then paste the output between the markers and run `npx prettier --write` on the file.",
			boundariesDoc, firstDiff(want, got))
	}

	checkProse(t, generated, before+"\n"+after)
}

// splitBlock returns the content between the dbinventory markers, plus the
// document either side of it (the prose, which quotes the block's counts).
func splitBlock(doc string) (block, before, after string, err error) {
	i := strings.Index(doc, blockStart)
	j := strings.Index(doc, blockEnd)
	if i < 0 || j < 0 || j < i {
		return "", "", "", fmt.Errorf("markers %q .. %q not found in order", blockStart, blockEnd)
	}
	return doc[i+len(blockStart) : j], doc[:i], doc[j+len(blockEnd):], nil
}

// normalize reduces a Markdown fragment to comparable content: blank lines
// dropped, and every table row reduced to its trimmed cells. That absorbs
// prettier's column padding, which is the only difference between what the
// command prints and what ends up committed.
func normalize(s string) []string {
	var out []string
	for line := range strings.SplitSeq(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if cells := cellsOf(line); cells != nil {
			if isSeparatorRow(cells) {
				// `| --- |` and `| ------- |` mean the same thing, but the
				// number of columns does not: keep that.
				line = "|" + strings.Repeat("---|", len(cells))
			} else {
				line = "|" + strings.Join(cells, "|") + "|"
			}
		}
		out = append(out, line)
	}
	return out
}

// cellsOf splits a Markdown table row into trimmed cells, or returns nil when
// the line is not a table row.
func cellsOf(line string) []string {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "|") {
		return nil
	}
	cells := strings.Split(strings.Trim(line, "|"), "|")
	for i, c := range cells {
		cells[i] = strings.TrimSpace(c)
	}
	return cells
}

func isSeparatorRow(cells []string) bool {
	for _, c := range cells {
		if strings.Trim(c, "-: ") != "" {
			return false
		}
	}
	return len(cells) > 0
}

// firstDiff reports the first differing line, which is what a reader needs;
// dumping 57 identical rows is not.
func firstDiff(want, got []string) string {
	for i := range max(len(want), len(got)) {
		w, g := at(want, i), at(got, i)
		if w == g {
			continue
		}
		return fmt.Sprintf("first difference at content line %d:\n  generated: %s\n  document:  %s\n"+
			"(%d generated lines, %d in the document)", i+1, w, g, len(want), len(got))
	}
	return "line counts differ but no line does"
}

func at(s []string, i int) string {
	if i < len(s) {
		return s[i]
	}
	return "<missing>"
}

// ── prose ───────────────────────────────────────────────────────────────────

// tallies read back out of the generated block. Deriving them from the block
// rather than recomputing them from `rows` keeps one classification in the
// program: if the block is right (checked above), these are right.
type tallies struct {
	total          int
	typeOnly       int
	typeOnlyByDisp map[string]int
	byDisposition  map[string]int
}

var (
	summaryRe = regexp.MustCompile(`(?m)^(\d+) files import .* (\d+) are type-only; (\d+) unlisted\.$`)
	dispRe    = regexp.MustCompile(`(?m)^Dispositions: (.*)\. Move targets:`)
	countRe   = regexp.MustCompile(`(\S+) (\d+)`)
)

func readTallies(t *testing.T, generated string) tallies {
	t.Helper()
	m := summaryRe.FindStringSubmatch(generated)
	if m == nil {
		t.Fatalf("cannot read the summary line out of the generated block; printTable's format changed:\n%s", generated)
	}
	out := tallies{
		total:          atoi(t, m[1]),
		typeOnly:       atoi(t, m[2]),
		typeOnlyByDisp: map[string]int{},
		byDisposition:  map[string]int{},
	}
	d := dispRe.FindStringSubmatch(generated)
	if d == nil {
		t.Fatalf("cannot read the dispositions line out of the generated block")
	}
	for _, c := range countRe.FindAllStringSubmatch(d[1], -1) {
		out.byDisposition[strings.TrimSuffix(c[1], ",")] = atoi(t, c[2])
	}

	// "N of them adapter" — the cross-tab the prose quotes twice and the
	// summary line does not carry. Columns: file, types, funcs, methods,
	// shape, disposition, family, why.
	for _, line := range normalize(generated) {
		cells := cellsOf(line)
		if len(cells) != 8 || isSeparatorRow(cells) || !strings.HasPrefix(cells[0], "`") {
			continue
		}
		if cells[4] == "type-only" {
			out.typeOnlyByDisp[cells[5]]++
		}
	}
	if out.typeOnly != sum(out.typeOnlyByDisp) {
		t.Fatalf("read %d type-only rows out of the table but the summary says %d; the column layout changed",
			sum(out.typeOnlyByDisp), out.typeOnly)
	}
	return out
}

// checkProse verifies the counts the document states in its own words. These
// are the ones that actually went stale: a regenerated block with untouched
// prose reads as self-contradictory and nothing noticed.
//
// Every pattern must match. A reworded sentence that no longer matches is a
// failure, not a pass — otherwise the check quietly stops checking, which is
// the failure mode this whole test exists to prevent.
func checkProse(t *testing.T, generated, prose string) {
	t.Helper()
	n := readTallies(t, generated)

	checkDispositionTable(t, n, prose)

	claims := []struct {
		what string
		re   *regexp.Regexp
		want func(m []string) []int
	}{{
		what: `"down from N rows to M"`,
		re:   regexp.MustCompile(`down from \d+ rows to (\d+)`),
		want: func([]string) []int { return []int{n.total} },
	}, {
		what: `"N of the M rows are type-only, K of them adapter"`,
		re:   regexp.MustCompile(`(\d+) of the (\d+) rows are type-only, (\d+) of them ` + "`adapter`"),
		want: func([]string) []int { return []int{n.typeOnly, n.total, n.typeOnlyByDisp["adapter"]} },
	}, {
		what: `"Type-only rows (N, of which K are adapter)"`,
		re:   regexp.MustCompile(`Type-only rows \((\d+), of which (\d+) are ` + "`adapter`" + `\)`),
		want: func([]string) []int { return []int{n.typeOnly, n.typeOnlyByDisp["adapter"]} },
	}}

	for _, c := range claims {
		matches := c.re.FindAllStringSubmatch(prose, -1)
		if len(matches) == 0 {
			t.Errorf("%s: no longer found in %s. It was reworded or removed — re-point the pattern in this test, or the count stops being checked.",
				c.what, boundariesDoc)
			continue
		}
		for _, m := range matches {
			want := c.want(m)
			// The value captures are the trailing groups: the leading group of
			// the table pattern is the disposition name, not a count.
			got := m[len(m)-len(want):]
			for i, w := range want {
				if atoi(t, got[i]) != w {
					t.Errorf("%s: %q claims %s, the inventory says %d", c.what, strings.TrimSpace(m[0]), got[i], w)
				}
			}
		}
	}
}

// The layout-refactor supplement's four dispositions, spelled out in
// DBImportEntry's doc comment in Server/invariants/db_import_boundary.go.
// Not derived from DBImportAllow: the point of pinning them is to catch a row
// going missing, and a disposition with no rows contributes nothing to derive
// from.
var dbImportDispositions = []string{"move", "adapter", "boundary", "remove"}

// checkDispositionTable compares the document's disposition table -- the one
// that was left contradicting the block underneath it -- against the inventory,
// in both directions.
//
// Anchored on the table's header rather than on the shape of its rows. The
// document is a running narrative that quotes historical before/after counts
// in exactly that shape ("22 -> 17 `move`, 20 -> 26 `adapter`"), so a pattern
// loose enough to find the live table also finds any future historical one and
// reports a "wrong" count for a number that was right when it was written.
func checkDispositionTable(t *testing.T, n tallies, prose string) {
	t.Helper()
	lines := strings.Split(prose, "\n")
	header := -1
	for i, line := range lines {
		cells := cellsOf(line)
		if len(cells) >= 3 && cells[0] == "Disposition" && cells[len(cells)-1] == "Rows" {
			if header >= 0 {
				t.Fatalf("%s has more than one `| Disposition | ... | Rows |` table; this check cannot tell which one is live",
					boundariesDoc)
			}
			header = i
		}
	}
	if header < 0 {
		t.Fatalf("%s has no `| Disposition | ... | Rows |` table any more. It was reworded or removed -- re-point this check, or the counts stop being checked.",
			boundariesDoc)
	}

	documented := map[string]int{}
	for _, line := range lines[header+1:] {
		cells := cellsOf(line)
		if cells == nil {
			break // end of the table
		}
		if isSeparatorRow(cells) {
			continue
		}
		documented[strings.Trim(cells[0], "`")] = atoi(t, cells[len(cells)-1])
	}
	if len(documented) == 0 {
		t.Fatalf("the disposition table in %s has a header and no rows", boundariesDoc)
	}

	// Every disposition must have a row, including the ones sitting at zero.
	// A count comparison alone cannot see a DELETED zero row -- and `move` at
	// 0 is B3-8's exit criterion, so losing that row erases the statement
	// rather than contradicting it. An unknown row name is caught here too: a
	// typo'd row at 0 would otherwise agree with an absent disposition.
	for _, name := range dbImportDispositions {
		if _, listed := documented[name]; !listed {
			t.Errorf("the disposition table in %s has no `%s` row; all four dispositions must be listed, including the ones at 0",
				boundariesDoc, name)
		}
	}
	for name := range documented {
		if !slices.Contains(dbImportDispositions, name) {
			t.Errorf("the disposition table in %s has a `%s` row, which is not one of the four dispositions %v",
				boundariesDoc, name, dbImportDispositions)
		}
	}

	for name, want := range documented {
		if got := n.byDisposition[name]; got != want {
			t.Errorf("disposition table: `%s` row claims %d, the inventory says %d", name, want, got)
		}
	}
	for name, got := range n.byDisposition {
		if _, listed := documented[name]; !listed {
			t.Errorf("the inventory reports %d `%s` row(s) and the disposition table in %s has no row for it",
				got, name, boundariesDoc)
		}
	}
}

func atoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatalf("not a number: %q", s)
	}
	return n
}
