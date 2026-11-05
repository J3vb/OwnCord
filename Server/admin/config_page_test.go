package admin_test

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

// The Server configuration page titles and orders its cards from
// CONFIG_GROUPS in static/js/config.js. A key prefix missing there still
// renders, but under Advanced with a title made from the raw prefix, which is
// what the page looked like before it had a map. Pin that every prefix the
// panel can edit has a plain title, and that no title is left for a prefix
// that no longer exists.
func TestConfigPageTitlesEveryEditablePrefix(t *testing.T) {
	raw, err := os.ReadFile("static/js/config.js")
	if err != nil {
		t.Fatalf("read config.js: %v", err)
	}
	source := string(raw)
	start := strings.Index(source, "const CONFIG_GROUPS=[")
	if start < 0 {
		t.Fatal("config.js has no CONFIG_GROUPS table")
	}
	end := strings.Index(source[start:], "\n];")
	if end < 0 {
		t.Fatal("CONFIG_GROUPS is not closed by a line starting with ];")
	}
	table := source[start : start+end]

	titled := map[string]bool{}
	for _, m := range regexp.MustCompile(`\['([a-z0-9_]+)','([^']+)'\]`).FindAllStringSubmatch(table, -1) {
		if titled[m[1]] {
			t.Errorf("prefix %q is listed twice in CONFIG_GROUPS", m[1])
		}
		titled[m[1]] = true
	}

	editable := map[string]bool{}
	for _, key := range config.EditableKeys() {
		prefix, _, _ := strings.Cut(key, ".")
		editable[prefix] = true
		if !titled[prefix] {
			t.Errorf("editable key %s: prefix %q has no title in CONFIG_GROUPS (static/js/config.js)", key, prefix)
		}
	}
	for prefix := range titled {
		if !editable[prefix] {
			t.Errorf("CONFIG_GROUPS titles %q, but no editable key starts with it", prefix)
		}
	}
}
