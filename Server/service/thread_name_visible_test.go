package service

import (
	"errors"
	"testing"
)

// Thread and forum post titles follow the single-line visible text rule.
func TestCleanThreadName_SingleLineVisibleText(t *testing.T) {
	t.Parallel()
	refused := map[string]string{
		"line break":         "release\nnotes",
		"direction override": "abc\u202etxt.exe",
		"zero width":         "a\u200bb",
		"control":            "bell\x07",
	}
	for name, in := range refused {
		if _, err := cleanThreadName(in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	got, err := cleanThreadName("  Patch   notes, café 🎉 ")
	if err != nil || got != "Patch notes, café 🎉" {
		t.Errorf("ordinary title = %q, %v; want trimmed, spaces collapsed", got, err)
	}
	if _, err := cleanThreadName("   "); !errors.Is(err, ErrBadRequest) {
		t.Errorf("blank title: err = %v, want ErrBadRequest", err)
	}
}
