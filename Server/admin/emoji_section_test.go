package admin_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The panel's Emoji section is plain JS under static/js, so nothing
// compiles it. These tests tie the three places that have to agree — the NAV
// entry, the renderContent dispatch map, and the permission gate — so a
// half-wired section fails here rather than as a blank page for an operator.

// adminPanelSource is the whole panel as one string: index.html followed by
// every script under static/js. The pins grep for code wherever it lives, so a
// function moving between page files does not break them.
func adminPanelSource(t *testing.T) string {
	t.Helper()
	files, err := filepath.Glob("static/js/*.js")
	if err != nil || len(files) == 0 {
		t.Fatalf("no admin panel scripts under static/js: %v", err)
	}
	var b strings.Builder
	for _, f := range append([]string{"static/index.html"}, files...) {
		source, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read admin panel: %v", err)
		}
		b.Write(source)
		b.WriteByte('\n')
	}
	return b.String()
}

func TestAdminPanelEmojiSectionIsWired(t *testing.T) {
	source := adminPanelSource(t)

	navRe := regexp.MustCompile(`\{id:'emoji',[^}]*allowed:\(\)=>can\(PERM\.MANAGE_SERVER\)\}`)
	if !navRe.MatchString(source) {
		t.Error("no NAV entry for 'emoji' gated on PERM.MANAGE_SERVER")
	}
	if !strings.Contains(source, "emoji:renderEmoji") {
		t.Error("renderContent dispatch map has no emoji:renderEmoji entry")
	}
	for _, fn := range []string{
		"async function renderEmoji(",
		"async function uploadEmoji(",
		"async function deleteEmoji(",
		"function confirmDeleteEmoji(",
		"async function emojiApi(",
	} {
		if !strings.Contains(source, fn) {
			t.Errorf("missing %q", fn)
		}
	}
}

func TestAdminPanelEmojiUsesTheMemberAPI(t *testing.T) {
	source := adminPanelSource(t)
	// The panel deliberately calls the ordinary /api/v1/emoji routes (which
	// enforce MANAGE_SERVER themselves) rather than a duplicate set of
	// /admin/api handlers. If that ever moves, the helper below moves with it.
	if !strings.Contains(source, "fetch('/api/v1/emoji'+path,init)") {
		t.Error("emojiApi no longer targets /api/v1/emoji")
	}
	if !strings.Contains(source, "data-emoji-url") {
		t.Error("thumbnails are no longer loaded through the authenticated blob path")
	}
}
