package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestCategoryService_NameContract(t *testing.T) {
	svc, _ := newChannelAdminService(t)
	ctx := context.Background()

	got, err := svc.CreateCategory(ctx, 1, "  Games  ")
	if err != nil || got.Category == nil || got.Category.Name != "Games" {
		t.Fatalf("CreateCategory = %+v, %v; want the trimmed name", got, err)
	}
	for name, in := range map[string]string{"blank": "   ", "empty": "", "too long": strings.Repeat("x", MaxChannelCategoryLen+1)} {
		if _, err := svc.CreateCategory(ctx, 1, in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	if _, err := svc.CreateCategory(ctx, 1, strings.Repeat("é", MaxChannelCategoryLen)); err != nil {
		t.Errorf("100 multi-byte runes rejected: %v", err)
	}
	if _, err := svc.CreateCategory(ctx, 1, "GAMES"); !errors.Is(err, ErrConflict) {
		t.Errorf("duplicate ignoring case: err = %v, want ErrConflict", err)
	}
}

func TestCategoryService_ChangesNameTheChannelsThatMoved(t *testing.T) {
	svc, database := newChannelAdminService(t)
	ctx := context.Background()
	a, _ := svc.CreateCategory(ctx, 1, "A")
	b, _ := svc.CreateCategory(ctx, 1, "B")
	inA, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "in-a", CategoryID: a.Category.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	inB, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "in-b", CategoryID: b.Category.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	loose, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "loose"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ids := func(chs []db.Channel) map[int64]bool {
		out := map[int64]bool{}
		for _, c := range chs {
			out[c.ID] = true
		}
		return out
	}

	renamed, err := svc.RenameCategory(ctx, 1, a.Category.ID, "A2")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got := ids(renamed.Channels); len(got) != 1 || !got[inA.ID] {
		t.Fatalf("rename changed %v, want only the channel in the category", got)
	}
	if renamed.Channels[0].Category != "A2" {
		t.Fatalf("changed channel carries %q, want the committed name", renamed.Channels[0].Category)
	}

	// Moving B above A moves both categories' positions, so both channels
	// change; the uncategorized one never does.
	reordered, err := svc.ReorderCategories(ctx, 1, []int64{b.Category.ID, a.Category.ID})
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got := ids(reordered.Channels); len(got) != 2 || !got[inA.ID] || !got[inB.ID] || got[loose.ID] {
		t.Fatalf("reorder changed %v, want both categorized channels and not %d", got, loose.ID)
	}
	same, err := svc.ReorderCategories(ctx, 1, []int64{b.Category.ID, a.Category.ID})
	if err != nil || len(same.Channels) != 0 {
		t.Fatalf("a no-op reorder = %+v, %v; want no changed channels", same, err)
	}

	deleted, err := svc.DeleteCategory(ctx, 1, b.Category.ID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := ids(deleted.Channels); len(got) != 1 || !got[inB.ID] || deleted.Channels[0].CategoryID != 0 {
		t.Fatalf("delete changed %+v, want the one channel, now uncategorized", deleted.Channels)
	}
	if ch, _ := database.GetChannel(ctx, inB.ID); ch == nil || ch.Name != "in-b" {
		t.Fatalf("the channel did not survive its category: %+v", ch)
	}
}

func TestCategoryService_StaleReorderWritesNothing(t *testing.T) {
	svc, _ := newChannelAdminService(t)
	ctx := context.Background()
	a, _ := svc.CreateCategory(ctx, 1, "A")
	b, _ := svc.CreateCategory(ctx, 1, "B")
	if _, err := svc.ReorderCategories(ctx, 1, []int64{a.Category.ID}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a set missing b: err = %v, want ErrConflict", err)
	}
	if _, err := svc.ReorderCategories(ctx, 1, []int64{a.Category.ID, 999}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a set with an unknown id: err = %v, want ErrConflict", err)
	}
	if _, err := svc.ReorderCategories(ctx, 1, []int64{a.Category.ID, a.Category.ID}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("a repeated id: err = %v, want ErrBadRequest", err)
	}
	cats, err := svc.ListCategories(ctx)
	if err != nil || len(cats) != 2 || cats[0].ID != a.Category.ID || cats[1].ID != b.Category.ID {
		t.Fatalf("categories = %+v, %v; want the original order", cats, err)
	}
}

func TestCategoryService_ChannelNamesAreUniquePerTypeAndCategoryID(t *testing.T) {
	svc, _ := newChannelAdminService(t)
	ctx := context.Background()
	a, _ := svc.CreateCategory(ctx, 1, "A")
	b, _ := svc.CreateCategory(ctx, 1, "B")
	inA, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "lobby", CategoryID: a.Category.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	inB, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "lobby", CategoryID: b.Category.ID}, nil)
	if err != nil {
		t.Fatalf("same name in another category: %v", err)
	}
	// Moving the B channel into A would duplicate the name there.
	if _, err := svc.AdminUpdateChannel(ctx, 1, inB, AdminChannelUpdate{Name: "lobby", CategoryID: a.Category.ID}, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("a move onto a sibling's name: err = %v, want ErrConflict", err)
	}
	// By the legacy string too.
	name := "a"
	if _, err := svc.AdminUpdateChannel(ctx, 1, inB, AdminChannelUpdate{Name: "lobby", Category: &name}, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("a legacy move onto a sibling's name: err = %v, want ErrConflict", err)
	}
	// A move to a category with no clash works, and the old one is untouched.
	none := ""
	moved, err := svc.AdminUpdateChannel(ctx, 1, inB, AdminChannelUpdate{Name: "lobby", Category: &none}, nil)
	if err != nil || moved.CategoryID != 0 {
		t.Fatalf("move out: %+v, %v", moved, err)
	}
	if _, err := svc.AdminUpdateChannel(ctx, 1, inA, AdminChannelUpdate{Name: "lobby", CategoryID: a.Category.ID}, nil); err != nil {
		t.Fatalf("an unchanged edit of a channel: %v", err)
	}
}

func TestCategoryService_LegacyNameThatMatchesNothingCreatesTheCategory(t *testing.T) {
	svc, _ := newChannelAdminService(t)
	ctx := context.Background()
	ch, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "x", Category: "  Fresh  "}, nil)
	if err != nil || ch.Category != "Fresh" || ch.CategoryID == 0 {
		t.Fatalf("legacy create = %+v, %v; want a new category Fresh", ch, err)
	}
	again, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "y", Category: "fRESH"}, nil)
	if err != nil || again.CategoryID != ch.CategoryID {
		t.Fatalf("legacy create by another spelling = %+v, %v; want category %d", again, err, ch.CategoryID)
	}
	if _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "z", Category: strings.Repeat("c", MaxChannelCategoryLen+1)}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("an over-long legacy category: err = %v, want ErrBadRequest", err)
	}
	if _, err := svc.AdminCreateChannel(ctx, 1, AdminChannelCreate{Name: "w", CategoryID: 12345}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("an unknown category_id: err = %v, want ErrBadRequest", err)
	}
	cats, _ := svc.ListCategories(ctx)
	if len(cats) != 1 {
		t.Fatalf("categories = %+v, want just Fresh", cats)
	}
}
