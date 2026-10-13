package admin_test

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

var updateChangelog = flag.Bool("update-changelog", false, "rewrite static/changelog.md from the repository's CHANGELOG.md")

// releasedSections is CHANGELOG.md from its first released version heading
// ("## v…") to the end: the preamble and "Unreleased" are not release notes.
func releasedSections(t *testing.T, changelog []byte) []byte {
	t.Helper()
	loc := regexp.MustCompile(`(?m)^## v\d`).FindIndex(changelog)
	if loc == nil {
		t.Fatal("CHANGELOG.md has no released version heading (## v…)")
	}
	return changelog[loc[0]:]
}

// TestBundledChangelog keeps the admin panel's embedded release notes equal to
// the released part of the repository's CHANGELOG.md. Release images build
// from Server/ alone, so the panel cannot read the root file; the copy is what
// ships. Edits under "Unreleased" never touch it. A release PR, which moves
// those notes under a version heading, refreshes it with:
//
//	cd Server && go test ./admin -run TestBundledChangelog -update-changelog
func TestBundledChangelog(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "CHANGELOG.md"))
	if err != nil {
		t.Fatalf("read CHANGELOG.md: %v", err)
	}
	want := releasedSections(t, source)
	bundled := filepath.Join("static", "changelog.md")
	if *updateChangelog {
		if err := os.WriteFile(bundled, want, 0o644); err != nil {
			t.Fatalf("write %s: %v", bundled, err)
		}
		return
	}
	got, err := os.ReadFile(bundled)
	if err != nil {
		t.Fatalf("read %s: %v", bundled, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is out of date with CHANGELOG.md's released sections; run:\n\tcd Server && go test ./admin -run TestBundledChangelog -update-changelog", bundled)
	}
}
