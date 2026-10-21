package db_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// Category permission templates (migration 075, WP 6.5d) at the db seam.

type catFixture struct {
	database *db.DB
	cat      int64
	other    int64
	role     int64
	chs      []int64
}

func newCatFixture(t *testing.T, channels int) *catFixture {
	t.Helper()
	database := openMigratedMemory(t)
	ctx := context.Background()
	f := &catFixture{database: database, role: 4}
	cat, err := database.CreateChannelCategory(ctx, "Games")
	if err != nil {
		t.Fatalf("CreateChannelCategory: %v", err)
	}
	other, err := database.CreateChannelCategory(ctx, "Music")
	if err != nil {
		t.Fatalf("CreateChannelCategory: %v", err)
	}
	f.cat, f.other = cat.ID, other.ID
	for i := range channels {
		id, err := database.CreateChannelIn(ctx, db.NewChannel{Name: string(rune('a' + i)), Type: "text", CategoryID: f.cat})
		if err != nil {
			t.Fatalf("CreateChannelIn: %v", err)
		}
		f.chs = append(f.chs, id)
	}
	return f
}

func (f *catFixture) synced(t *testing.T, id int64) bool {
	t.Helper()
	ok, err := f.database.ChannelPermissionsSynced(context.Background(), id)
	if err != nil {
		t.Fatalf("ChannelPermissionsSynced: %v", err)
	}
	return ok
}

func (f *catFixture) row(t *testing.T, ch int64) (int64, int64) {
	t.Helper()
	a, d, err := f.database.GetChannelPermissions(context.Background(), ch, f.role)
	if err != nil {
		t.Fatalf("GetChannelPermissions: %v", err)
	}
	return a, d
}

func (f *catFixture) move(t *testing.T, ch, category int64) {
	t.Helper()
	if err := f.database.AdminUpdateChannel(context.Background(), ch, db.ChannelUpdate{Name: "moved", CategoryID: category}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
}

func TestMigrate_075NothingIsSynced(t *testing.T) {
	database := openMemory(t)
	ctx := context.Background()
	if err := db.MigrateFS(database, migrationsUpTo(t, "075_")); err != nil {
		t.Fatalf("MigrateFS() building pre-075 schema: %v", err)
	}
	if columnExists(t, database, "channels", "permissions_synced") {
		t.Fatal("the pre-075 schema should not have permissions_synced")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channel_categories (id, name) VALUES (1, 'Games')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channels (id, name, type, category_id) VALUES (1, 'old', 'text', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (1, 4, 2, 0)`); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() applying 075: %v", err)
	}
	if ok, err := database.ChannelPermissionsSynced(ctx, 1); err != nil || ok {
		t.Errorf("existing channel synced = %v, %v; the backfill must sync nothing", ok, err)
	}
	if a, d, err := database.GetChannelPermissions(ctx, 1, 4); err != nil || a != 2 || d != 0 {
		t.Errorf("existing override = (%d,%d), %v; want it exactly as it was", a, d, err)
	}
	ids, err := database.ListSyncedChannelIDs(ctx)
	if err != nil || len(ids) != 0 {
		t.Errorf("synced ids = %v, %v", ids, err)
	}
}

func TestCategoryOverride_TemplateIsCopiedNeverInherited(t *testing.T) {
	f := newCatFixture(t, 1)
	ctx := context.Background()
	// A channel in the category BEFORE the template exists carries nothing,
	// and a template write reaches it only because it is synced.
	if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 1, nil); err != nil {
		t.Fatal(err)
	}
	// The effective-permission read (the channel's own rows) sees the copy.
	if a, d := f.row(t, f.chs[0]); a != 2 || d != 1 {
		t.Errorf("synced channel = (%d,%d)", a, d)
	}
	// An unsynced channel in the same category sees nothing of the template.
	loose, err := f.database.CreateChannelIn(ctx, db.NewChannel{Name: "loose", Type: "text", CategoryID: f.cat})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.database.DeleteChannelOverride(ctx, loose, f.role); err != nil { // direct edit: unsync
		t.Fatal(err)
	}
	if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 8, 0, nil); err != nil {
		t.Fatal(err)
	}
	if a, d := f.row(t, loose); a != 0 || d != 0 {
		t.Errorf("an unsynced channel read (%d,%d) from the template; templates are never inherited", a, d)
	}
}

func TestCategoryOverride_GuardRefusalWritesNothing(t *testing.T) {
	f := newCatFixture(t, 2)
	ctx := context.Background()
	refuse := errors.New("refused")
	var seen db.CategoryOverrideScope
	_, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 0, func(sc db.CategoryOverrideScope) error {
		seen = sc
		return refuse
	})
	if !errors.Is(err, refuse) {
		t.Fatalf("err = %v, want the guard's error", err)
	}
	if len(seen.Channels) != 2 {
		t.Errorf("guard saw %d synced channels, want 2", len(seen.Channels))
	}
	for _, ch := range f.chs {
		if a, d := f.row(t, ch); a != 0 || d != 0 {
			t.Errorf("channel %d row = (%d,%d), want nothing written", ch, a, d)
		}
	}
	roles, err := f.database.ListCategoryRoleOverrides(ctx, f.cat)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range roles {
		if r.Allow != 0 || r.Deny != 0 {
			t.Errorf("category row for role %d = (%d,%d), want nothing written", r.RoleID, r.Allow, r.Deny)
		}
	}
	if _, err := f.database.WriteCategoryRoleOverride(ctx, 9999, f.role, 0, 0, nil); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("unknown category: err = %v, want ErrNotFound", err)
	}
}

// Edge case 2: a channel moved out mid-write is either fully written or not
// touched. The guard runs inside the write transaction, so a move started from
// there queues behind it on the single writer connection.
func TestCategoryOverride_ChannelMovedOutMidWriteIsFullyWritten(t *testing.T) {
	f := newCatFixture(t, 2)
	ctx := context.Background()
	moved := make(chan struct{})
	touched, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 1, func(db.CategoryOverrideScope) error {
		go func() {
			defer close(moved)
			if err := f.database.AdminUpdateChannel(ctx, f.chs[0], db.ChannelUpdate{Name: "moved", CategoryID: f.other}); err != nil {
				t.Errorf("move: %v", err)
			}
		}()
		time.Sleep(50 * time.Millisecond) // let the move reach the writer queue
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-moved
	if len(touched) != 2 {
		t.Fatalf("touched = %v, want both channels read in the transaction", touched)
	}
	// The write finished before the move began: the moved channel carries the
	// complete row, and the move unsynced it without discarding it.
	if a, d := f.row(t, f.chs[0]); a != 2 || d != 1 {
		t.Errorf("moved channel = (%d,%d), want the fully written row", a, d)
	}
	if f.synced(t, f.chs[0]) {
		t.Error("the moved channel should be unsynced")
	}
	if a, d := f.row(t, f.chs[1]); a != 2 || d != 1 || !f.synced(t, f.chs[1]) {
		t.Errorf("staying channel = (%d,%d) synced=%v", a, d, f.synced(t, f.chs[1]))
	}
}

func TestCategoryOverride_ChannelMovedOutBeforeTheWriteIsNotTouched(t *testing.T) {
	f := newCatFixture(t, 2)
	ctx := context.Background()
	f.move(t, f.chs[0], f.other)
	var seen db.CategoryOverrideScope
	touched, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 1, func(sc db.CategoryOverrideScope) error {
		seen = sc
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(touched) != 1 || touched[0] != f.chs[1] || len(seen.Channels) != 1 {
		t.Fatalf("touched = %v, guard saw %d channels; want only the channel still in the category", touched, len(seen.Channels))
	}
	if a, d := f.row(t, f.chs[0]); a != 0 || d != 0 {
		t.Errorf("moved-out channel = (%d,%d), want it untouched", a, d)
	}
}

// Writes and moves racing: whatever the interleaving, a channel that ends up
// synced carries exactly the category's row.
func TestCategoryOverride_RacingWritesAndMovesNeverLeaveASyncedChannelBehind(t *testing.T) {
	f := newCatFixture(t, 6)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := range 24 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, int64(1+i%4), int64(i%3), nil); err != nil {
				t.Errorf("write %d: %v", i, err)
			}
		}()
		go func() {
			defer wg.Done()
			ch := f.chs[i%len(f.chs)]
			if i%2 == 0 {
				_ = f.database.AdminUpdateChannel(ctx, ch, db.ChannelUpdate{Name: "x", CategoryID: f.other})
			} else {
				_, _ = f.database.SyncChannelPermissions(ctx, ch, nil)
				_ = f.database.AdminUpdateChannel(ctx, ch, db.ChannelUpdate{Name: "x", CategoryID: f.cat, SyncGuard: func(db.ChannelSyncPlan) error { return nil }})
			}
		}()
	}
	wg.Wait()
	roles, err := f.database.ListCategoryRoleOverrides(ctx, f.cat)
	if err != nil {
		t.Fatal(err)
	}
	var catA, catD int64
	for _, r := range roles {
		if r.RoleID == f.role {
			catA, catD = r.Allow, r.Deny
		}
	}
	for _, ch := range f.chs {
		if !f.synced(t, ch) {
			continue
		}
		if a, d := f.row(t, ch); a != catA || d != catD {
			t.Errorf("synced channel %d = (%d,%d), category = (%d,%d)", ch, a, d, catA, catD)
		}
	}
}

func TestSyncChannelPermissions_Errors(t *testing.T) {
	f := newCatFixture(t, 1)
	ctx := context.Background()
	if _, err := f.database.SyncChannelPermissions(ctx, 9999, nil); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("missing channel: err = %v, want ErrNotFound", err)
	}
	loose, err := f.database.CreateChannelIn(ctx, db.NewChannel{Name: "loose", Type: "text"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.SyncChannelPermissions(ctx, loose, nil); !errors.Is(err, db.ErrUncategorized) {
		t.Errorf("uncategorized: err = %v, want ErrUncategorized", err)
	}
	// An update asking for a sync with no category is refused, and writes nothing.
	err = f.database.AdminUpdateChannel(ctx, loose, db.ChannelUpdate{Name: "renamed", SyncGuard: func(db.ChannelSyncPlan) error { return nil }})
	if !errors.Is(err, db.ErrUncategorized) {
		t.Errorf("update sync without category: err = %v, want ErrUncategorized", err)
	}
	if ch, _ := f.database.GetChannel(ctx, loose); ch.Name != "loose" {
		t.Errorf("a refused update renamed the channel to %q", ch.Name)
	}
}

func TestDeleteChannelCategory_UnsyncsItsChannelsAndDropsTheTemplate(t *testing.T) {
	f := newCatFixture(t, 2)
	ctx := context.Background()
	if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 0, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.database.DeleteChannelCategory(ctx, f.cat); err != nil {
		t.Fatal(err)
	}
	for _, ch := range f.chs {
		if f.synced(t, ch) {
			t.Errorf("channel %d still synced", ch)
		}
		if a, _ := f.row(t, ch); a != 2 {
			t.Errorf("channel %d lost its override: %d", ch, a)
		}
	}
	var n int
	if err := f.database.QueryRowContext(ctx, `SELECT COUNT(*) FROM category_overrides`).Scan(&n); err != nil || n != 0 {
		t.Errorf("template rows = %d, %v", n, err)
	}
}

func TestCategoryOverride_UserRowsClearAndPreview(t *testing.T) {
	f := newCatFixture(t, 2)
	ctx := context.Background()
	uid := seedUser(t, f.database, "template-user")

	touched, err := f.database.WriteCategoryUserOverride(ctx, f.cat, uid, 4, 2, nil)
	if err != nil {
		t.Fatalf("WriteCategoryUserOverride: %v", err)
	}
	if len(touched) != 2 {
		t.Errorf("touched %v, want both synced channels", touched)
	}
	users, err := f.database.ListCategoryUserOverrides(ctx, f.cat)
	if err != nil || len(users) != 1 || users[0].UserID != uid || users[0].Allow != 4 || users[0].Deny != 2 {
		t.Fatalf("ListCategoryUserOverrides = %+v, %v", users, err)
	}
	chUsers, err := f.database.GetChannelUserOverrides(ctx, f.chs[0])
	if err != nil || len(chUsers) != 1 {
		t.Fatalf("a synced channel should carry the copied user row: %+v, %v", chUsers, err)
	}

	// The preview names what a sync would remove and write, outside any
	// transaction and without changing anything.
	if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 8, 0, nil); err != nil {
		t.Fatal(err)
	}
	plan, err := f.database.PreviewChannelSync(ctx, f.chs[0], f.cat)
	if err != nil {
		t.Fatalf("PreviewChannelSync: %v", err)
	}
	if plan.ChannelID != f.chs[0] || plan.CategoryID != f.cat || len(plan.Written.Roles) != 1 || len(plan.Written.Users) != 1 {
		t.Errorf("plan = %+v", plan)
	}

	ids, err := f.database.ListSyncedChannelIDs(ctx)
	if err != nil || len(ids) != 2 {
		t.Errorf("ListSyncedChannelIDs = %v, %v", ids, err)
	}
	if ok, err := f.database.ChannelPermissionsSynced(ctx, 999999); err != nil || ok {
		t.Errorf("a missing channel is not synced: %v, %v", ok, err)
	}

	// A guard refusal on a user clear writes nothing.
	refusal := errors.New("refused")
	if _, err := f.database.ClearCategoryUserOverride(ctx, f.cat, uid, func(db.CategoryOverrideScope) error { return refusal }); !errors.Is(err, refusal) {
		t.Fatalf("a refused clear should return the guard's error, got %v", err)
	}
	if users, _ := f.database.ListCategoryUserOverrides(ctx, f.cat); len(users) != 1 {
		t.Errorf("a refused clear removed the template row: %+v", users)
	}
	if _, err := f.database.ClearCategoryUserOverride(ctx, f.cat, uid, nil); err != nil {
		t.Fatalf("ClearCategoryUserOverride: %v", err)
	}
	if chUsers, _ := f.database.GetChannelUserOverrides(ctx, f.chs[1]); len(chUsers) != 0 {
		t.Errorf("clear left the member's row on a synced channel: %+v", chUsers)
	}

	if _, err := f.database.ClearCategoryRoleOverride(ctx, f.cat, f.role, nil); err != nil {
		t.Fatalf("ClearCategoryRoleOverride: %v", err)
	}
	if a, d := f.row(t, f.chs[0]); a != 0 || d != 0 {
		t.Errorf("clear left (%d,%d) on a synced channel", a, d)
	}
	if _, err := f.database.ClearCategoryRoleOverride(ctx, 999999, f.role, nil); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("clearing on a missing category = %v, want ErrNotFound", err)
	}
}

func TestSyncChannelPermissions_ReplacesRolesAndMembersWithTheTemplate(t *testing.T) {
	f := newCatFixture(t, 1)
	ctx := context.Background()
	uid := seedUser(t, f.database, "sync-user")
	if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 8, 0, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.WriteCategoryUserOverride(ctx, f.cat, uid, 2, 0, nil); err != nil {
		t.Fatal(err)
	}
	// A direct edit unsyncs the channel and leaves it with its own row.
	if err := f.database.UpsertChannelOverride(ctx, f.chs[0], f.role, 1, 0); err != nil {
		t.Fatal(err)
	}
	if f.synced(t, f.chs[0]) {
		t.Fatal("a direct edit should unsync the channel")
	}
	var seen db.ChannelSyncPlan
	plan, err := f.database.SyncChannelPermissions(ctx, f.chs[0], func(p db.ChannelSyncPlan) error { seen = p; return nil })
	if err != nil {
		t.Fatalf("SyncChannelPermissions: %v", err)
	}
	if len(seen.Removed.Roles) != 1 || seen.Removed.Roles[0].Allow != 1 || len(plan.Written.Users) != 1 {
		t.Errorf("guard saw %+v, plan %+v", seen, plan)
	}
	if a, d := f.row(t, f.chs[0]); a != 8 || d != 0 {
		t.Errorf("channel row after sync = (%d,%d), want the template's (8,0)", a, d)
	}
	if !f.synced(t, f.chs[0]) {
		t.Error("a sync should mark the channel synced")
	}
}

func TestChannelCategoryLookups(t *testing.T) {
	f := newCatFixture(t, 0)
	ctx := context.Background()
	c, err := f.database.GetChannelCategory(ctx, f.cat)
	if err != nil || c == nil || c.Name != "Games" {
		t.Fatalf("GetChannelCategory = %+v, %v", c, err)
	}
	if c, err := f.database.GetChannelCategory(ctx, 999999); err != nil || c != nil {
		t.Errorf("a missing category = %+v, %v; want nil, nil", c, err)
	}
	if c, err := f.database.FindChannelCategoryByName(ctx, "gAmEs"); err != nil || c == nil || c.ID != f.cat {
		t.Errorf("FindChannelCategoryByName ignoring case = %+v, %v", c, err)
	}
	if c, err := f.database.FindChannelCategoryByName(ctx, "nope"); err != nil || c != nil {
		t.Errorf("an unknown name = %+v, %v; want nil, nil", c, err)
	}
}

// A create in the category racing a template write: whichever commits first,
// the new channel ends with exactly the committed template row and is synced.
func TestCategoryOverride_CreateRacingATemplateWrite(t *testing.T) {
	t.Run("create queued behind the write", func(t *testing.T) {
		f := newCatFixture(t, 0)
		ctx := context.Background()
		created := make(chan int64, 1)
		_, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 1, func(db.CategoryOverrideScope) error {
			go func() {
				id, err := f.database.CreateChannelIn(ctx, db.NewChannel{Name: "racer", Type: "text", CategoryID: f.cat})
				if err != nil {
					t.Errorf("create: %v", err)
				}
				created <- id
			}()
			time.Sleep(50 * time.Millisecond) // let the create reach the writer queue
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		id := <-created
		if a, d := f.row(t, id); a != 2 || d != 1 || !f.synced(t, id) {
			t.Errorf("new channel = (%d,%d) synced=%v, want the committed template (2,1) and synced", a, d, f.synced(t, id))
		}
	})
	t.Run("create commits first", func(t *testing.T) {
		f := newCatFixture(t, 0)
		ctx := context.Background()
		id, err := f.database.CreateChannelIn(ctx, db.NewChannel{Name: "racer", Type: "text", CategoryID: f.cat})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.database.WriteCategoryRoleOverride(ctx, f.cat, f.role, 2, 1, nil); err != nil {
			t.Fatal(err)
		}
		if a, d := f.row(t, id); a != 2 || d != 1 || !f.synced(t, id) {
			t.Errorf("new channel = (%d,%d) synced=%v, want (2,1) and synced", a, d, f.synced(t, id))
		}
	})
}

func TestAdminUpdateChannel_SyncWithoutACategoryIsUncategorized(t *testing.T) {
	f := newCatFixture(t, 1)
	err := f.database.AdminUpdateChannel(context.Background(), f.chs[0], db.ChannelUpdate{
		Name:      "a",
		SyncGuard: func(db.ChannelSyncPlan) error { return nil },
		SyncPlan:  &db.ChannelSyncPlan{},
	})
	if !errors.Is(err, db.ErrUncategorized) {
		t.Fatalf("a sync into no category = %v, want ErrUncategorized", err)
	}
	if !f.synced(t, f.chs[0]) {
		t.Error("a refused update must leave the channel synced")
	}
}
