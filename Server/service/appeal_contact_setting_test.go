package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestNormalizeAppealContact pins the appeal contact rules: trimmed, single-line visible text of at most
// MaxAppealContactLen runes, empty clears it.
func TestNormalizeAppealContact(t *testing.T) {
	ok := map[string]string{
		"  owner@example.test  ": "owner@example.test",
		"":                       "",
		"   ":                    "",
		strings.Repeat("é", MaxAppealContactLen): strings.Repeat("é", MaxAppealContactLen),
		"Discord: owner#1234   or email":         "Discord: owner#1234 or email",
	}
	for in, want := range ok {
		got, err := NormalizeAppealContact(in)
		if err != nil || got != want {
			t.Errorf("NormalizeAppealContact(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := map[string]string{
		"too long":       strings.Repeat("a", MaxAppealContactLen+1),
		"too long runes": strings.Repeat("é", MaxAppealContactLen+1),
		"newline":        "a\nb",
		"tab":            "a\tb",
		"nul":            "a\x00b",
		"zero width":     "a\u200bb",
		"zalgo":          "é̂̃̄",
	}
	for name, in := range bad {
		if got, err := NormalizeAppealContact(in); err == nil {
			t.Errorf("%s: accepted as %q", name, got)
		}
	}
}

// TestSettingsPatch_AppealContact covers the PATCH path: stored trimmed, empty clears, a bad value is
// ErrBadRequest and leaves the stored value alone.
func TestSettingsPatch_AppealContact(t *testing.T) {
	svc := NewSettingsService(newTestDB(t))
	ctx := context.Background()
	if _, err := svc.Patch(ctx, 1, map[string]string{AppealContactKey: "  me@example.test "}); err != nil {
		t.Fatalf("patch: %v", err)
	}
	if got, _ := svc.Setting(ctx, AppealContactKey); got != "me@example.test" {
		t.Fatalf("stored %q", got)
	}
	if _, err := svc.Patch(ctx, 1, map[string]string{AppealContactKey: "a\nb"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("control char err = %v", err)
	}
	if got, _ := svc.Setting(ctx, AppealContactKey); got != "me@example.test" {
		t.Fatalf("rejected patch changed the value to %q", got)
	}
	if _, err := svc.Patch(ctx, 1, map[string]string{AppealContactKey: "  "}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got, _ := svc.Setting(ctx, AppealContactKey); got != "" {
		t.Fatalf("cleared value = %q", got)
	}
}
