package migrations

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// B5-0's doc gate. docs/architecture/community-services.md is the abuse-case,
// data-ownership and lifecycle model for the seven services B5 adds or
// changes, and HP-5 reviews against it. Nothing compared it to the tree until
// this test, and the failure it exists to prevent is the quiet one: a service
// section deleted, a "Tested at" cell emptied, a cited test file renamed, or a
// B5 migration landing with no data class documented for it.
//
// It lives in the migrations package because the coupling B5-0's acceptance
// asks for is to the migrations B5 adds, and the embedded FS below is that
// list by construction.
//
// RUN IT WITH -count=1. The document is outside this module, so Go's test
// cache does not record it as an input: edit a cell, re-run a plain
// `go test ./...`, and the answer comes back "(cached) ok" without the file
// being opened. scripts/run.mjs and ci.yml both give it its own -count=1 step
// for that reason — the same rule as TestServerBoundariesDocIsCurrent.
const (
	communityDoc = "../../docs/architecture/community-services.md"
	repoRoot     = "../.."

	// The migration range B5 reserves, in plan order: 044 B5-2, 045 B5-4,
	// 046 B5-6, 047 B5-7, 048 B5-8, 049 B5-9, 050 B5-10.
	firstB5Migration = 44
	lastB5Migration  = 50
)

// communityServices is the seven services, in document order, spelled exactly
// as their `## S<n> — <name>` headings spell them. Pinned by name rather than
// counted: a count cannot see a section that was deleted rather than emptied,
// which is the same lesson as dbinventory's disposition table.
var communityServices = []string{
	"Message Requests and trusted-sender relationships",
	"External content retrieval",
	"Uploads, quotas and reserved headroom",
	"NSFW labelling and acknowledgement",
	"Report intake, the queue and evidence snapshots",
	"Moderator actions and appeals",
	"Web Push subscriptions and dispatch",
}

// The three tables every service owes, matched on their exact header cells so
// that renaming a column fails loudly instead of quietly skipping the check.
var (
	abuseHeader     = []string{"Adversary", "Goal", "Mechanism", "Control", "Tested at"}
	ownershipHeader = []string{"Data class", "Read", "Write", "Delete", "Subject sees", "Operator sees", "In a backup"}
	lifecycleHeader = []string{"Data class", "Retention default", "Under B4-9 erasure", "B4-10 marker", "B4-11 sweep"}
)

// owingStep matches the second legal form of a "Tested at" cell: the step that
// owes the test. B5-0 itself is included because a row may point back at this
// document; the client-side phases are included because several controls are
// explicitly theirs (decision 14).
var owingStep = regexp.MustCompile(`\b(B5-(?:1[0-2]|[0-9])|HP-5|B[789])\b`)

// evasions are the ways a "Tested at" cell can look filled and say nothing.
var evasions = []string{"unknown", "tbd", "todo", "n/a", "none", "-", "—", "?", "…"}

// repoPath matches a backticked span that claims to be a path in this
// repository. `data/` is deliberately absent: data/erasure.key and
// data/erasure/markers.sqlite are runtime state and exist on a server, not in
// a checkout.
var repoPath = regexp.MustCompile(`^(?:Server|Client|docs|protocol|scripts|\.github|\.superpowers)/[A-Za-z0-9_.\-/]+$`)

// backtickSpan finds every `...` span in the document.
var backtickSpan = regexp.MustCompile("`([^`\n]+)`")

// migrationFile finds every NNN_name.sql the document names.
var migrationFile = regexp.MustCompile(`\b(\d{3})_[a-z0-9_]+\.sql\b`)

// plannedPaths are paths the document names that do not exist yet, each with
// the step that creates it. The check runs in both directions: an unlisted
// missing path fails, and a listed path that now EXISTS fails too, because
// that means the step landed and the exemption is stale.
var plannedPaths = map[string]string{
	"Server/safefetch": "B5-1",
}

func TestCommunityServicesDocIsCurrent(t *testing.T) {
	// Not a Skipf: a gate that excuses itself when its subject moves is worse
	// than no gate (the same posture as TestServerBoundariesDocIsCurrent).
	raw, err := os.ReadFile(communityDoc)
	if err != nil {
		t.Fatalf("read %s: %v", communityDoc, err)
	}
	doc := string(raw)

	sections := docSections(t, doc)
	checkServicesPresent(t, sections)
	checkTables(t, sections)
	checkTestedAtCells(t, sections)
	checkCitedPaths(t, doc)
	checkMigrationCoupling(t, doc)
}

// ── section splitting ───────────────────────────────────────────────────────

var serviceHeading = regexp.MustCompile(`(?m)^## S(\d+) — (.+?)\s*$`)

// docSections returns the body of each `## S<n> — <name>` section, keyed by
// name.
func docSections(t *testing.T, doc string) map[string]string {
	t.Helper()
	locs := serviceHeading.FindAllStringSubmatchIndex(doc, -1)
	out := make(map[string]string, len(locs))
	for i, m := range locs {
		name := doc[m[4]:m[5]]
		end := len(doc)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		if _, dup := out[name]; dup {
			t.Fatalf("%s has two `## S… — %s` sections; this check cannot tell which one is live",
				communityDoc, name)
		}
		out[name] = doc[m[1]:end]
	}
	return out
}

func checkServicesPresent(t *testing.T, sections map[string]string) {
	t.Helper()
	for _, want := range communityServices {
		if _, ok := sections[want]; !ok {
			t.Errorf("%s has no `## S… — %s` section. All seven services must be listed, "+
				"including any with nothing new to say — re-point this check or the coverage stops being checked.",
				communityDoc, want)
		}
	}
	for got := range sections {
		if !slices.Contains(communityServices, got) {
			t.Errorf("%s has a `## S… — %s` section, which is not one of the seven B5 services %v",
				communityDoc, got, communityServices)
		}
	}
}

// ── tables ──────────────────────────────────────────────────────────────────

func checkTables(t *testing.T, sections map[string]string) {
	t.Helper()
	for _, name := range communityServices {
		body, ok := sections[name]
		if !ok {
			continue // already reported by checkServicesPresent
		}
		for _, want := range [][]string{abuseHeader, ownershipHeader, lifecycleHeader} {
			if n := countTables(body, want); n != 1 {
				t.Errorf("service %q has %d table(s) headed %v, want exactly 1. "+
					"Every service owes an abuse-case, a data-ownership and a lifecycle table, "+
					"and a renamed column is a failure, not a skip.", name, n, want)
			}
		}
	}
}

// countTables reports how many tables in body carry exactly the header cells.
func countTables(body string, header []string) int {
	n := 0
	for line := range strings.SplitSeq(body, "\n") {
		if cells := cellsOf(line); cells != nil && slices.Equal(cells, header) {
			n++
		}
	}
	return n
}

// tableRows returns the data rows (separator rows dropped) of the first table
// in body carrying the given header.
func tableRows(body string, header []string) [][]string {
	lines := strings.Split(body, "\n")
	start := -1
	for i, line := range lines {
		if cells := cellsOf(line); cells != nil && slices.Equal(cells, header) {
			start = i
			break
		}
	}
	if start < 0 {
		return nil
	}
	var rows [][]string
	for _, line := range lines[start+1:] {
		cells := cellsOf(line)
		if cells == nil {
			break // end of the table
		}
		if isSeparatorRow(cells) {
			continue
		}
		rows = append(rows, cells)
	}
	return rows
}

// ── "Tested at" ─────────────────────────────────────────────────────────────

// checkTestedAtCells enforces B5-0's acceptance criterion: every "Tested at"
// cell either cites a path that exists or names the step that owes it. No cell
// may be blank and none may say "unknown".
func checkTestedAtCells(t *testing.T, sections map[string]string) {
	t.Helper()
	for _, name := range communityServices {
		rows := tableRows(sections[name], abuseHeader)
		if len(rows) == 0 {
			if _, ok := sections[name]; ok {
				t.Errorf("service %q has an abuse-case table with a header and no rows", name)
			}
			continue
		}
		for i, cells := range rows {
			if len(cells) != len(abuseHeader) {
				t.Errorf("service %q abuse row %d has %d cells, want %d: %v",
					name, i+1, len(cells), len(abuseHeader), cells)
				continue
			}
			checkTestedAt(t, name, i+1, cells[len(cells)-1])
		}
	}
}

func checkTestedAt(t *testing.T, service string, row int, cell string) {
	t.Helper()
	trimmed := strings.TrimSpace(cell)
	if trimmed == "" {
		t.Errorf("service %q abuse row %d: the \"Tested at\" cell is empty. Cite a path that exists, "+
			"or name the step that owes the test.", service, row)
		return
	}
	if slices.Contains(evasions, strings.ToLower(strings.Trim(trimmed, "*_ ."))) {
		t.Errorf("service %q abuse row %d: the \"Tested at\" cell says %q, which says nothing. "+
			"Cite a path that exists, or name the step that owes the test.", service, row, trimmed)
		return
	}
	if owingStep.MatchString(trimmed) {
		return
	}
	for _, m := range backtickSpan.FindAllStringSubmatch(trimmed, -1) {
		if repoPath.MatchString(m[1]) {
			return
		}
	}
	t.Errorf("service %q abuse row %d: the \"Tested at\" cell %q neither cites a repository path "+
		"nor names an owing step (B5-0..B5-12, HP-5, B7, B8, B9).", service, row, trimmed)
}

// ── cited paths ─────────────────────────────────────────────────────────────

// checkCitedPaths fails when the document names a repository path that is not
// there. Doc rot in a reference document is invisible otherwise: a renamed
// test file leaves a citation that reads fine and proves nothing.
func checkCitedPaths(t *testing.T, doc string) {
	t.Helper()
	seen := map[string]bool{}
	for _, m := range backtickSpan.FindAllStringSubmatch(doc, -1) {
		p := m[1]
		if !repoPath.MatchString(p) || seen[p] {
			continue
		}
		seen[p] = true
		_, err := os.Stat(filepath.Join(repoRoot, filepath.FromSlash(strings.TrimSuffix(p, "/"))))
		exists := err == nil
		step, planned := plannedPaths[p]
		switch {
		case exists && planned:
			t.Errorf("%s exempts `%s` as owed by %s, but it exists now. Drop the exemption from plannedPaths.",
				communityDoc, p, step)
		case !exists && !planned:
			t.Errorf("%s cites `%s`, which does not exist. Fix the citation, or add it to plannedPaths "+
				"with the step that creates it.", communityDoc, p)
		}
	}
	for p, step := range plannedPaths {
		if !seen[p] {
			t.Errorf("plannedPaths exempts `%s` (owed by %s) but %s does not cite it any more; drop the entry.",
				p, step, communityDoc)
		}
	}
}

// ── migration coupling ──────────────────────────────────────────────────────

// checkMigrationCoupling is the class-list gate B5-0's acceptance asks for.
// Three directions:
//
//  1. every migration this document names by filename exists in the tree;
//  2. every migration in the tree numbered at or above 044 — the B5 range — is
//     named here, so a step cannot land a table without documenting its data
//     classes;
//  3. every number B5 reserves (044..050) is named here, so the reservation is
//     pinned today rather than only once the files appear.
func checkMigrationCoupling(t *testing.T, doc string) {
	t.Helper()
	present, err := fs.Glob(FS, "*.sql")
	if err != nil {
		t.Fatalf("glob embedded migrations: %v", err)
	}
	inTree := map[string]bool{}
	for _, name := range present {
		inTree[name] = true
	}

	for _, m := range migrationFile.FindAllStringSubmatch(doc, -1) {
		if !inTree[m[0]] {
			t.Errorf("%s names migration %q, which is not in Server/migrations/", communityDoc, m[0])
		}
	}

	for _, name := range present {
		n, err := strconv.Atoi(name[:3])
		if err != nil || n < firstB5Migration {
			continue
		}
		if !namesMigration(doc, n) {
			t.Errorf("migration %s is in the B5 range and %s does not name it. "+
				"A B5 migration owes a data class in this document's ownership and lifecycle tables.",
				name, communityDoc)
		}
	}

	for n := firstB5Migration; n <= lastB5Migration; n++ {
		if !namesMigration(doc, n) {
			t.Errorf("%s does not name reserved B5 migration %03d. The seven numbers 044..050 are "+
				"reserved in plan order; a step that renumbers must update this document.", communityDoc, n)
		}
	}
}

// namesMigration reports whether the document mentions migration n, either as
// a bare three-digit number or inside a filename.
func namesMigration(doc string, n int) bool {
	re := regexp.MustCompile(fmt.Sprintf(`(?:^|[^0-9])%03d(?:[^0-9]|$)`, n))
	return re.MatchString(doc)
}

// ── markdown helpers ────────────────────────────────────────────────────────

// cellsOf splits a Markdown table row into trimmed cells, or returns nil when
// the line is not a table row. Prettier re-pads every table on commit, so
// comparisons are on trimmed content and never on bytes.
//
// Splitting is on UNESCAPED pipes only. Several cells quote a grep alternation
// (`a\|b`), which Markdown renders as a literal pipe inside the cell; a naive
// strings.Split turns one such row into a cell count that does not match the
// header and reports a spurious failure.
func cellsOf(line string) []string {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "|") {
		return nil
	}
	var cells []string
	var cur strings.Builder
	escaped := false
	for _, r := range strings.Trim(line, "|") {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case r == '|':
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	cells = append(cells, strings.TrimSpace(cur.String()))
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
