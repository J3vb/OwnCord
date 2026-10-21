package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestChannelCategories_CreateRenameDeleteRoundTrip(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()

	a, err := database.CreateChannelCategory(ctx, "Games")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	b, err := database.CreateChannelCategory(ctx, "Voice")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.Position != 0 || b.Position != 1 {
		t.Fatalf("positions = %d, %d; want appended 0, 1", a.Position, b.Position)
	}
	if _, err := database.CreateChannelCategory(ctx, "games"); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("duplicate ignoring case: err = %v, want ErrConflict", err)
	}
	if err := database.RenameChannelCategory(ctx, b.ID, "GAMES"); !errors.Is(err, db.ErrConflict) {
		t.Fatalf("rename onto another: err = %v, want ErrConflict", err)
	}
	if err := database.RenameChannelCategory(ctx, 999, "x"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("rename missing: err = %v, want ErrNotFound", err)
	}
	if err := database.RenameChannelCategory(ctx, a.ID, "GAMES"); err != nil {
		t.Fatalf("case-only rename of itself: %v", err)
	}
	if err := database.DeleteChannelCategory(ctx, 999); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("delete missing: err = %v, want ErrNotFound", err)
	}

	id, err := database.CreateChannelIn(ctx, db.NewChannel{Name: "arena", Type: "text", CategoryID: a.ID})
	if err != nil {
		t.Fatalf("CreateChannelIn: %v", err)
	}
	if err := database.DeleteChannelCategory(ctx, a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	ch, err := database.GetChannel(ctx, id)
	if err != nil || ch == nil {
		t.Fatalf("the channel did not survive its category: %v", err)
	}
	if ch.CategoryID != 0 || ch.Category != "" || ch.CategoryPosition != 0 {
		t.Fatalf("channel after its category was deleted = %+v, want uncategorized", ch)
	}
}

// Edge case 1 at the db layer: a reorder whose id set is not exactly the
// current set writes nothing.
func TestChannelCategories_ReorderRefusesAStaleSetAndWritesNothing(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	ids := make([]int64, 0, 3)
	for _, n := range []string{"A", "B", "C"} {
		c, err := database.CreateChannelCategory(ctx, n)
		if err != nil {
			t.Fatalf("create %s: %v", n, err)
		}
		ids = append(ids, c.ID)
	}
	order := func() []int64 {
		cats, err := database.ListChannelCategories(ctx)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		out := make([]int64, len(cats))
		for i := range cats {
			out[i] = cats[i].ID
		}
		return out
	}
	for name, stale := range map[string][]int64{
		"missing one": {ids[2], ids[0]},
		"extra id":    {ids[2], ids[1], ids[0], 999},
		"swapped id":  {ids[2], ids[1], 999},
		"empty":       {},
	} {
		if err := database.ReorderChannelCategories(ctx, stale); !errors.Is(err, db.ErrConflict) {
			t.Errorf("%s: err = %v, want ErrConflict", name, err)
		}
		if got := order(); got[0] != ids[0] || got[1] != ids[1] || got[2] != ids[2] {
			t.Fatalf("%s: a refused reorder wrote, order is now %v", name, got)
		}
	}
	if err := database.ReorderChannelCategories(ctx, []int64{ids[2], ids[0], ids[1]}); err != nil {
		t.Fatalf("valid reorder: %v", err)
	}
	if got := order(); got[0] != ids[2] || got[1] != ids[0] || got[2] != ids[1] {
		t.Fatalf("order after a valid reorder = %v", got)
	}
}

// Two managers reorder at the same moment: the writer serialises them, one
// commits and the other, holding the same list, still succeeds only if its set
// is current, and the table never ends up with duplicate or missing positions.
func TestChannelCategories_ConcurrentReordersLeaveAPermutation(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	ids := make([]int64, 0, 4)
	for _, n := range []string{"A", "B", "C", "D"} {
		c, err := database.CreateChannelCategory(ctx, n)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, c.ID)
	}
	var wg sync.WaitGroup
	for _, order := range [][]int64{{ids[3], ids[2], ids[1], ids[0]}, {ids[1], ids[0], ids[3], ids[2]}} {
		wg.Go(func() {
			if err := database.ReorderChannelCategories(ctx, order); err != nil {
				t.Errorf("reorder %v: %v", order, err)
			}
		})
	}
	wg.Wait()
	cats, err := database.ListChannelCategories(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int]bool{}
	for _, c := range cats {
		if c.Position < 0 || c.Position >= len(cats) || seen[c.Position] {
			t.Fatalf("positions after racing reorders are not a permutation: %+v", cats)
		}
		seen[c.Position] = true
	}
}

// Edge case 2 at the db layer: a create that resolves its category by name and
// a rename of that category cannot split into two rows.
func TestChannelCategories_RenameRacingResolveOrCreate(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	games, err := database.CreateChannelCategory(ctx, "Games")
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Go(func() {
		for i := range 20 {
			name := "Play"
			if i%2 == 1 {
				name = "Games"
			}
			// A rename onto a name a racing create just took is a legitimate
			// conflict; anything else is a failure.
			if err := database.RenameChannelCategory(ctx, games.ID, name); err != nil && !errors.Is(err, db.ErrConflict) {
				t.Errorf("rename: %v", err)
			}
		}
	})
	names := []string{"games", "play", "GAMES", "PLAY"}
	for i := range 20 {
		if _, err := database.CreateChannelIn(ctx, db.NewChannel{
			Name: "c" + string(rune('a'+i)), Type: "text", CategoryName: names[i%len(names)],
		}); err != nil {
			t.Fatalf("CreateChannelIn: %v", err)
		}
	}
	wg.Wait()

	cats, err := database.ListChannelCategories(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Every name resolves to the one row, or to a fresh row when the rename had
	// moved the row off that name. Never two rows with one name.
	seen := map[string]bool{}
	for _, c := range cats {
		key := c.Name
		if len(key) > 0 && key[0] >= 'a' {
			key = string(key[0]-32) + key[1:]
		}
		if seen[key] {
			t.Fatalf("two categories share a name ignoring case: %+v", cats)
		}
		seen[key] = true
	}
	chs, err := database.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range chs {
		if ch.CategoryID == 0 || ch.Category == "" {
			t.Fatalf("channel %q lost its category: %+v", ch.Name, ch)
		}
	}
}

func TestChannelCategories_UnknownCategoryIDWritesNothing(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	if _, err := database.CreateChannelIn(ctx, db.NewChannel{Name: "x", Type: "text", CategoryID: 42}); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	chs, _ := database.ListChannels(ctx)
	if len(chs) != 0 {
		t.Fatalf("a refused create left %d channel(s)", len(chs))
	}
	id, err := database.CreateChannel(ctx, "ok", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AdminUpdateChannel(ctx, id, db.ChannelUpdate{Name: "ok", CategoryID: 42}); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("update into a missing category: err = %v, want ErrNotFound", err)
	}
}
