package main

import (
	"slices"
	"strings"
	"testing"
)

// TestWriteTablePadsLikePrettier pins the padding rule the whole tool rests
// on: cells and the separator are padded to the widest cell in the column,
// header included, with Prettier's three-dash minimum. Get this wrong and
// `prettier --check` reformats what `git diff --exit-code` then reports as
// drift, forever.
func TestWriteTablePadsLikePrettier(t *testing.T) {
	tests := []struct {
		name   string
		header []string
		rows   [][]string
		want   string
	}{
		{
			name:   "column widens to its longest cell",
			header: []string{"Method", "Path"},
			rows:   [][]string{{"GET", "/a"}, {"DELETE", "/longer"}},
			want: strings.Join([]string{
				"| Method | Path    |",
				"| ------ | ------- |",
				"| GET    | /a      |",
				"| DELETE | /longer |",
			}, "\n") + "\n",
		},
		{
			name:   "separator never goes below three dashes",
			header: []string{"K"},
			rows:   [][]string{{"v"}},
			want:   "| K   |\n| --- |\n| v   |\n",
		},
		{
			name:   "a pipe in a cell is escaped, and the escape counts as width",
			header: []string{"Type"},
			rows:   [][]string{{"a|b"}},
			want:   "| Type |\n| ---- |\n| a\\|b |\n",
		},
		{
			name:   "a short row is padded out to the header's column count",
			header: []string{"A", "B"},
			rows:   [][]string{{"x"}},
			want:   "| A   | B   |\n| --- | --- |\n| x   |     |\n",
		},
		{
			name:   "width is counted in runes, not bytes",
			header: []string{"Note"},
			rows:   [][]string{{"—"}},
			want:   "| Note |\n| ---- |\n| —    |\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var b strings.Builder
			writeTable(&b, tt.header, tt.rows)
			if b.String() != tt.want {
				t.Errorf("writeTable\n got:\n%s\nwant:\n%s", b.String(), tt.want)
			}
		})
	}
}

// TestSpliceBlock pins the marker contract: only the text between a matched
// pair is replaced, and an unmarked document is an error rather than an
// append — where a generated block lives is an editorial decision.
func TestSpliceBlock(t *testing.T) {
	const doc = "before\n\n<!-- gendocs:routes:start -->\n\nstale\n\n<!-- gendocs:routes:end -->\n\nafter\n"
	tests := []struct {
		name    string
		doc     string
		body    string
		want    string
		wantErr string
	}{
		{
			name: "replaces the body, keeps the markers and their neighbours",
			doc:  doc,
			body: "fresh",
			want: "before\n\n<!-- gendocs:routes:start -->\n\nfresh\n\n<!-- gendocs:routes:end -->\n\nafter\n",
		},
		{
			name: "surplus newlines around the body are trimmed to one blank line",
			doc:  doc,
			body: "\n\nfresh\n\n\n",
			want: "before\n\n<!-- gendocs:routes:start -->\n\nfresh\n\n<!-- gendocs:routes:end -->\n\nafter\n",
		},
		{
			name:    "no markers at all",
			doc:     "before\nafter\n",
			body:    "fresh",
			wantErr: "not found",
		},
		{
			name:    "start marker without an end marker",
			doc:     "<!-- gendocs:routes:start -->\nstale\n",
			body:    "fresh",
			wantErr: "not found",
		},
		{
			name:    "end marker before the start marker",
			doc:     "<!-- gendocs:routes:end -->\nstale\n<!-- gendocs:routes:start -->\n",
			body:    "fresh",
			wantErr: "appears before",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := spliceBlock(tt.doc, "routes", tt.body)
			switch {
			case tt.wantErr != "":
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("spliceBlock error = %v, want one containing %q", err, tt.wantErr)
				}
			case err != nil:
				t.Fatalf("spliceBlock: %v", err)
			case got != tt.want:
				t.Errorf("spliceBlock\n got: %q\nwant: %q", got, tt.want)
			}
		})
	}
}

// TestCmpRouteOrdersByBarePath pins the sort to the path before its code span
// goes on. Sorting the rendered cell puts `/x` after `/x/y`, because a
// backtick outranks a slash — a stable but nonsensical order.
func TestCmpRouteOrdersByBarePath(t *testing.T) {
	rows := [][]string{
		{"POST", "/a/{id}/restore"},
		{"GET", "/a"},
		{"DELETE", "/a/{id}"},
		{"DELETE", "/a"},
	}
	slices.SortFunc(rows, cmpRoute)
	want := [][]string{
		{"DELETE", "/a"},
		{"GET", "/a"},
		{"DELETE", "/a/{id}"},
		{"POST", "/a/{id}/restore"},
	}
	if !slices.EqualFunc(rows, want, slices.Equal) {
		t.Errorf("sorted = %v, want %v", rows, want)
	}
}

// TestDocSectionsScansOnlyTheHandWrittenReference keeps the config index from
// being its own evidence: a key is documented when a hand-written subsection
// of "## Config Key Reference" names it, and the generated index sits under
// its own "## " heading, outside the scan.
func TestDocSectionsScansOnlyTheHandWrittenReference(t *testing.T) {
	doc := strings.Join([]string{
		"# Title",
		"",
		"### First-run wizard",
		"",
		"writes `server.port` for you",
		"",
		"## Config Key Reference",
		"",
		"### Server (`server`)",
		"",
		"| `server.port` | int | `8443` | the port |",
		"| `server.name` | string | `\"x\"` | the name |",
		"",
		"### TLS (`tls`)",
		"",
		"| `tls.mode` | string | see `server.port` above |",
		"",
		"## Key index (generated)",
		"",
		"| `server.orphan` | Server (`server`) |",
		"",
	}, "\n")

	got := docSections(doc)
	want := map[string]string{
		"server.port": "Server (`server`)",
		"server.name": "Server (`server`)",
		"tls.mode":    "TLS (`tls`)",
	}
	if len(got) != len(want) {
		t.Fatalf("docSections = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("docSections[%q] = %q, want %q", k, got[k], v)
		}
	}
}

// TestMigrationHistoryFilesOnlyCountsTheHistorySection pins the two properties
// the migration gate rests on: a filename counts only when it is named under
// "### Migration History", and the generated table index — which lives under a
// later "## " heading and names no migration files at all — can never stand in
// for a real row. Without the section bound, any mention of a migration
// anywhere in schema.md would satisfy the gate and it would catch nothing.
func TestMigrationHistoryFilesOnlyCountsTheHistorySection(t *testing.T) {
	doc := strings.Join([]string{
		"# Schema",
		"",
		"## Overview",
		"",
		"Prose that happens to mention `001_initial_schema.sql` outside the table.",
		"",
		"## Migrations",
		"",
		"### Migration History",
		"",
		"| File | Description |",
		"| ---- | ----------- |",
		"| `002_voice_states.sql` | Adds `voice_states` |",
		"| `003_audit_log.sql` | Recreates `audit_log` |",
		"",
		"### Some other subsection",
		"",
		"| `004_not_history.sql` | under a different ### heading |",
		"",
		"## Table index (generated)",
		"",
		"| `005_after_the_section.sql` | under a later ## heading |",
		"",
	}, "\n")

	got := migrationHistoryFiles(doc)
	want := []string{"002_voice_states.sql", "003_audit_log.sql"}

	keys := make([]string, 0, len(got))
	for k := range got {
		keys = append(keys, k)
	}
	slices.Sort(keys)

	if !slices.Equal(keys, want) {
		t.Errorf("migrationHistoryFiles = %v, want %v", keys, want)
	}
	for _, unwanted := range []string{
		"001_initial_schema.sql",    // prose before the section
		"004_not_history.sql",       // a sibling ### subsection
		"005_after_the_section.sql", // the generated block, its own evidence
	} {
		if got[unwanted] {
			t.Errorf("migrationHistoryFiles counted %q, which is outside the history section", unwanted)
		}
	}
}
