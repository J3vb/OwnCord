package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// newStickerService builds a StickerService over the same four-principal
// hierarchy newEmojiService uses: 1 owner, 2 admin (MANAGE_SERVER only),
// 3 moderator (no MANAGE_SERVER), 4 member.
func newStickerService(t *testing.T) (*StickerService, *db.DB) {
	t.Helper()
	emoji, database := newEmojiService(t)
	return NewStickerService(database, emoji), database
}

func TestValidateStickerName(t *testing.T) {
	ok := map[string]string{
		"Wave":                  "Wave",
		"  Party Blob  ":        "Party Blob",
		"a_b-c 9":               "a_b-c 9",
		"ab":                    "ab",
		strings.Repeat("x", 30): strings.Repeat("x", 30),
		"MiXeD CaSe":            "MiXeD CaSe",
	}
	for in, want := range ok {
		got, err := ValidateStickerName(in)
		if err != nil || got != want {
			t.Errorf("ValidateStickerName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{"", " ", "a", strings.Repeat("x", 31), "dot.name", "emojié", "tab\tname", "new\nline", "<b>hi</b>", "semi;colon", ":wave:"}
	for _, in := range bad {
		if got, err := ValidateStickerName(in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("ValidateStickerName(%q) = %q, %v; want ErrBadRequest", in, got, err)
		}
	}
}

func TestValidateStickerEmoji(t *testing.T) {
	for _, in := range []string{"😀", "👍🏽", ":wave:", ":Wave:", "1️⃣", "🏳️‍🌈"} {
		got, err := ValidateStickerEmoji(in)
		if err != nil || got == nil {
			t.Errorf("ValidateStickerEmoji(%q) = %v, %v; want accepted", in, got, err)
		}
	}
	if got, err := ValidateStickerEmoji("  "); err != nil || got != nil {
		t.Errorf("blank emoji = %v, %v; want nil, nil", got, err)
	}
	if got, _ := ValidateStickerEmoji(":Wave:"); got == nil || *got != ":wave:" {
		t.Errorf("shortcode not lowercased: %v", got)
	}
	bad := []string{"abc", "a", "wave", "😀 😀", "x\x07", "<b>", strings.Repeat("😀", 20), ":no spaces:", "::", ":a:"}
	for _, in := range bad {
		if got, err := ValidateStickerEmoji(in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("ValidateStickerEmoji(%q) = %v, %v; want ErrBadRequest", in, got, err)
		}
	}
}

func TestStickerService_PermissionGate(t *testing.T) {
	svc, _ := newStickerService(t)
	ctx := context.Background()
	for _, actor := range []int64{3, 4} {
		if _, err := svc.Create(ctx, actor, "Wave", "", "file-a", "image/png"); !errors.Is(err, ErrForbidden) {
			t.Errorf("actor %d Create = %v, want ErrForbidden", actor, err)
		}
	}
	// MANAGE_SERVER alone is enough, as for emoji.
	created, err := svc.Create(ctx, 2, "Wave", "", "file-a", "image/png")
	if err != nil {
		t.Fatalf("admin Create: %v", err)
	}
	if _, err := svc.Update(ctx, 4, created.ID, "Hello", ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("member Update = %v, want ErrForbidden", err)
	}
	if _, err := svc.Delete(ctx, 4, created.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("member Delete = %v, want ErrForbidden", err)
	}
	if got, _ := svc.List(ctx); len(got) != 1 {
		t.Errorf("List after refused writes = %d stickers, want 1", len(got))
	}
}

func TestStickerService_NameIsUniqueIgnoringCase(t *testing.T) {
	svc, _ := newStickerService(t)
	ctx := context.Background()
	if _, err := svc.Create(ctx, 1, "Wave", "", "file-a", "image/png"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Wave", "wave", "WAVE", "  wAvE "} {
		if _, err := svc.Create(ctx, 1, name, "", "file-b", "image/png"); !errors.Is(err, ErrConflict) {
			t.Errorf("Create(%q) = %v, want ErrConflict", name, err)
		}
	}
	other, err := svc.Create(ctx, 1, "Other", "", "file-c", "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, 1, other.ID, "wave", ""); !errors.Is(err, ErrConflict) {
		t.Errorf("rename onto an existing name = %v, want ErrConflict", err)
	}
	// Renaming to a different case of its own name is not a clash.
	if got, err := svc.Update(ctx, 1, other.ID, "OTHER", "🎉"); err != nil || got.Name != "OTHER" || got.Emoji == nil || *got.Emoji != "🎉" {
		t.Errorf("self rename = %+v, %v", got, err)
	}
}

func TestStickerService_CapAtSixty(t *testing.T) {
	svc, database := newStickerService(t)
	ctx := context.Background()
	for i := range MaxStickerCount {
		name := "sticker-" + strings.Repeat("a", i/26) + string(rune('a'+i%26))
		if _, err := database.CreateSticker(ctx, name, nil, "f", "image/png", 1); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	if _, err := svc.Create(ctx, 1, "One Too Many", "", "f", "image/png"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("Create over the cap = %v, want ErrBadRequest", err)
	}
}

func TestStickerService_DeleteReturnsRowAndUnknownIs404(t *testing.T) {
	svc, _ := newStickerService(t)
	ctx := context.Background()
	created, err := svc.Create(ctx, 1, "Wave", "", "file-a", "image/png")
	if err != nil {
		t.Fatal(err)
	}
	removed, err := svc.Delete(ctx, 1, created.ID)
	if err != nil || removed.StoredAs != "file-a" {
		t.Fatalf("Delete = %+v, %v; want the removed row", removed, err)
	}
	if _, err := svc.Delete(ctx, 1, created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Delete = %v, want ErrNotFound", err)
	}
	if _, err := svc.Update(ctx, 1, 999, "Nope", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("Update unknown = %v, want ErrNotFound", err)
	}
	if _, err := svc.Get(ctx, 999); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get unknown = %v, want ErrNotFound", err)
	}
}

func TestStickerService_ConcurrentSameNameOneWins(t *testing.T) {
	svc, database := newStickerService(t)
	ctx := context.Background()
	if _, err := svc.Create(ctx, 1, "Race", "", "file-a", "image/png"); err != nil {
		t.Fatal(err)
	}
	// The pre-check passes only when it loses a race; prove the INSERT backstop
	// reports the same conflict by bypassing the check.
	_, err := database.CreateSticker(ctx, "RACE", nil, "file-b", "image/png", 1)
	if !db.IsUniqueConstraintError(err) {
		t.Fatalf("direct insert of a case-variant name = %v, want a unique-constraint error", err)
	}
}

func TestStickerWrites_WriteAudit(t *testing.T) {
	svc, database := newStickerService(t)
	ctx := context.Background()
	created, err := svc.Create(ctx, 1, "Wave", "", "stored-1", "image/png")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := svc.Update(ctx, 1, created.ID, "Hello", ""); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := svc.Delete(ctx, 1, created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	entries, err := database.GetAuditLog(ctx, 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.TargetType == "sticker" {
			seen[e.Action] = true
		}
	}
	for _, action := range []string{"sticker_create", "sticker_update", "sticker_delete"} {
		if !seen[action] {
			t.Errorf("no %s audit entry (saw %v)", action, seen)
		}
	}
}
