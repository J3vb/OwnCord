package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The sync lifecycle (WP 6.5d): create copies the template, a direct edit or a
// plain move unsyncs, a sync replaces, a category delete unsyncs.

// invalidationLog records the cache invalidations the permission service
// reports, so a test can tell which users a service call dropped.
type invalidationLog struct {
	users []int64
	all   bool
}

func (l *invalidationLog) observe(userID int64, all bool) {
	if all {
		l.all = true
		return
	}
	l.users = append(l.users, userID)
}

func (l *invalidationLog) any() bool { return l.all || len(l.users) > 0 }

// watch installs a recording notifier and an invalidation log on the fixture.
func (f *catPermFixture) watch() (*permNotifyRecorder, *invalidationLog) {
	rec, log := &permNotifyRecorder{}, &invalidationLog{}
	f.svc.SetPermissionNotifier(rec)
	f.svc.perms.SetInvalidationObserver(log.observe)
	return rec, log
}

func (f *catPermFixture) seedTemplate(t *testing.T) {
	t.Helper()
	if _, err := f.svc.PutCategoryRoleOverride(context.Background(), 7, f.admin, f.cat.ID, f.low.ID, permissions.ReadMessages, permissions.ManageServer); err != nil {
		t.Fatalf("seed template: %v", err)
	}
}

func TestCreateInCategory_CopiesTheTemplateAndStartsSynced(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	f.seedTemplate(t)
	seedUser(t, f.database, &db.User{ID: 31, Username: "member"})
	seedUserRole(t, f.database, 31, f.low.ID)
	if _, err := f.svc.PutCategoryUserOverride(ctx, 7, f.admin, f.cat.ID, 31, permissions.SendMessages, 0); err != nil {
		t.Fatal(err)
	}

	// Copying the template is not a grant by whoever creates the channel: the
	// template was guarded when it was written. The create takes no actor role
	// and applies no escalation guard, so a creator who lacks MANAGE_SERVER is
	// not blocked by a MANAGE_SERVER deny in the template.
	rec, inval := f.watch()
	ch, _, err := f.svc.AdminCreateChannel(ctx, 7, AdminChannelCreate{Name: "fresh", CategoryID: f.cat.ID}, nil)
	if err != nil {
		t.Fatalf("create by an actor lacking template bits: %v", err)
	}
	if !f.synced(t, ch) {
		t.Error("a channel created in a category must start synced")
	}
	if allow, deny := f.channelRow(t, ch, f.low.ID); allow != permissions.ReadMessages || deny != permissions.ManageServer {
		t.Errorf("role row = (%#x,%#x), want the template's", allow, deny)
	}
	if allow, _, _ := f.database.GetUserChannelPermissions(ctx, ch.ID, 31); allow != permissions.SendMessages {
		t.Errorf("user row = %#x, want the template's", allow)
	}
	// The new channel's rows are news to every connected holder of those rows.
	if inval.all || !slices.Contains(inval.users, 31) {
		t.Errorf("invalidations = %+v, want the template's users dropped", inval)
	}
	// The caller broadcasts the new channel itself; the service only drops the
	// cache so that broadcast resolves afresh.
	if len(rec.events) != 0 {
		t.Errorf("a create must not refresh the audience, events = %+v", rec.events)
	}

	// The legacy category string resolves to the same category.
	legacy, _, err := f.svc.AdminCreateChannel(ctx, 7, AdminChannelCreate{Name: "legacy", Category: "games"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !f.synced(t, legacy) {
		t.Error("a channel created through the legacy name must start synced")
	}
	if _, deny := f.channelRow(t, legacy, f.low.ID); deny != permissions.ManageServer {
		t.Errorf("legacy create row deny = %#x, want the template's", deny)
	}

	// No category, no template, not synced.
	plain, _, err := f.svc.AdminCreateChannel(ctx, 7, AdminChannelCreate{Name: "plain"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if f.synced(t, plain) {
		t.Error("an uncategorized channel is never synced")
	}
}

func TestDirectOverrideEditUnsyncs(t *testing.T) {
	ctx := context.Background()
	steps := map[string]func(f *catPermFixture, ch *db.Channel) error{
		"role put": func(f *catPermFixture, ch *db.Channel) error {
			_, err := f.svc.PutRoleOverride(ctx, 7, f.mod, ch, f.low.ID, permissions.ReadMessages, 0)
			return err
		},
		"role delete": func(f *catPermFixture, ch *db.Channel) error {
			_, err := f.svc.DeleteRoleOverride(ctx, 7, f.mod, ch, f.low.ID)
			return err
		},
		"user put": func(f *catPermFixture, ch *db.Channel) error {
			_, err := f.svc.PutUserOverride(ctx, 7, f.mod, ch, 31, permissions.ReadMessages, 0)
			return err
		},
		"user delete": func(f *catPermFixture, ch *db.Channel) error {
			_, err := f.svc.DeleteUserOverride(ctx, 7, f.mod, ch, 31)
			return err
		},
	}
	for name, step := range steps {
		t.Run(name, func(t *testing.T) {
			f := newCatPermFixture(t)
			seedUser(t, f.database, &db.User{ID: 31, Username: "member"})
			seedUserRole(t, f.database, 31, f.low.ID)
			if !f.synced(t, f.a) {
				t.Fatal("fixture channel should start synced")
			}
			if err := step(f, f.a); err != nil {
				t.Fatal(err)
			}
			if f.synced(t, f.a) {
				t.Error("a direct override edit must unsync the channel")
			}
			if !f.synced(t, f.b) {
				t.Error("the sibling channel must stay synced")
			}
		})
	}
}

func TestMoveChannel_KeepsOverridesAndUnsyncsUnlessAskedToSync(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	f.seedTemplate(t)
	otherChange, err := f.svc.CreateCategory(ctx, 1, "Music")
	if err != nil {
		t.Fatal(err)
	}
	other := otherChange.Category
	// Music's template differs: ATTACH_FILES allow for the same role.
	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.admin, other.ID, f.low.ID, permissions.AttachFiles, 0); err != nil {
		t.Fatal(err)
	}

	// Plain move: rows kept, unsynced.
	seedUser(t, f.database, &db.User{ID: 31, Username: "member"})
	seedUserRole(t, f.database, 31, f.low.ID)
	rec, inval := f.watch()
	moved, _, err := f.svc.AdminUpdateChannel(ctx, 7, f.a, moveTo(f.a, other.ID, false, f.mod), nil)
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if moved.CategoryID != other.ID {
		t.Fatalf("category = %d, want %d", moved.CategoryID, other.ID)
	}
	if f.synced(t, f.a) {
		t.Error("a move without sync_permissions must unsync")
	}
	if allow, deny := f.channelRow(t, f.a, f.low.ID); allow != permissions.ReadMessages || deny != permissions.ManageServer {
		t.Errorf("row after a plain move = (%#x,%#x), want the old rows kept", allow, deny)
	}
	if inval.any() || len(rec.events) != 0 {
		t.Errorf("a plain move changes no permission, invalidations = %+v, events = %+v", inval, rec.events)
	}

	// Moving within the same category does not unsync.
	if _, _, err := f.svc.AdminUpdateChannel(ctx, 7, f.b, moveTo(f.b, f.cat.ID, false, f.mod), nil); err != nil {
		t.Fatal(err)
	}
	if !f.synced(t, f.b) {
		t.Error("an update that keeps the category must keep the flag")
	}

	// Move back with sync_permissions: replaced by the target's template. The
	// admin may replace the MANAGE_SERVER deny; the mod may not.
	if _, _, err := f.svc.AdminUpdateChannel(ctx, 7, moved, moveTo(moved, f.cat.ID, true, f.mod), nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("sync by an actor lacking the removed bits: err = %v, want ErrForbidden", err)
	}
	if got, _ := f.svc.st.GetChannel(ctx, f.a.ID); got.CategoryID != other.ID {
		t.Errorf("a refused sync must not move the channel, category = %d", got.CategoryID)
	}
	if f.synced(t, f.a) {
		t.Error("a refused sync must not mark the channel synced")
	}
	if inval.any() || len(rec.events) != 0 {
		t.Errorf("a refused sync must neither invalidate nor notify, invalidations = %+v, events = %+v", inval, rec.events)
	}
	back, _, err := f.svc.AdminUpdateChannel(ctx, 7, moved, moveTo(moved, f.cat.ID, true, f.admin), nil)
	if err != nil {
		t.Fatalf("admin sync move: %v", err)
	}
	if back.CategoryID != f.cat.ID || !f.synced(t, f.a) {
		t.Error("sync_permissions must move and mark the channel synced")
	}
	if allow, deny := f.channelRow(t, f.a, f.low.ID); allow != permissions.ReadMessages || deny != permissions.ManageServer {
		t.Errorf("row after sync = (%#x,%#x), want the target template's", allow, deny)
	}
	if !slices.Contains(inval.users, 31) {
		t.Errorf("invalidations = %+v, want the replaced rows' role holder dropped", inval)
	}
	if len(rec.events) != 1 || rec.events[0].kind != "audience" || rec.events[0].chanID != f.a.ID {
		t.Errorf("events = %+v, want one audience refresh of the synced channel", rec.events)
	}
	if !f.auditHas(t, "channel_perms_sync") {
		t.Error("no channel_perms_sync audit row")
	}

	// sync_permissions needs a category to sync to.
	if _, _, err := f.svc.AdminUpdateChannel(ctx, 7, back, moveTo(back, 0, true, f.admin), nil); !errors.Is(err, ErrBadRequest) {
		t.Errorf("sync without a category: err = %v, want ErrBadRequest", err)
	}
}

func moveTo(ch *db.Channel, categoryID int64, sync bool, role *db.Role) AdminChannelUpdate {
	return AdminChannelUpdate{
		Name: ch.Name, Topic: ch.Topic, CategoryID: categoryID, Position: ch.Position,
		SyncPermissions: sync, ActorRole: role,
	}
}

func TestSyncChannelPermissions_ReplacesRowsWithTheTemplate(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	f.seedTemplate(t)
	seedUser(t, f.database, &db.User{ID: 31, Username: "member"})
	seedUserRole(t, f.database, 31, f.low.ID)
	// b drifts: its own role row, plus a member row the template lacks.
	if _, err := f.svc.PutRoleOverride(ctx, 7, f.admin, f.b, f.low.ID, permissions.AttachFiles, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.PutUserOverride(ctx, 7, f.admin, f.b, 31, permissions.SendMessages, 0); err != nil {
		t.Fatal(err)
	}
	if f.synced(t, f.b) {
		t.Fatal("direct edits should have unsynced b")
	}

	// The mod lacks MANAGE_SERVER, which the template denies: refused, nothing
	// changes.
	if _, err := f.svc.SyncChannelPermissions(ctx, 7, f.mod, f.b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if allow, _ := f.channelRow(t, f.b, f.low.ID); allow != permissions.AttachFiles {
		t.Errorf("a refused sync changed the row: %#x", allow)
	}
	if f.synced(t, f.b) {
		t.Error("a refused sync must not mark the channel synced")
	}

	rec, inval := f.watch()
	effect, err := f.svc.SyncChannelPermissions(ctx, 7, f.admin, f.b)
	if err != nil {
		t.Fatalf("SyncChannelPermissions: %v", err)
	}
	if allow, deny := f.channelRow(t, f.b, f.low.ID); allow != permissions.ReadMessages || deny != permissions.ManageServer {
		t.Errorf("row = (%#x,%#x), want the template's", allow, deny)
	}
	if allow, _, _ := f.database.GetUserChannelPermissions(ctx, f.b.ID, 31); allow != 0 {
		t.Errorf("a member row the template lacks survived: %#x", allow)
	}
	if !f.synced(t, f.b) {
		t.Error("sync must mark the channel synced")
	}
	if !effect.Applied || !slices.Contains(effect.AffectedUsers, 31) || !slices.Contains(inval.users, 31) {
		t.Errorf("effect = %+v, invalidations = %+v, want the removed member invalidated", effect, inval)
	}
	if len(rec.events) != 1 || rec.events[0].kind != "audience" || rec.events[0].chanID != f.b.ID {
		t.Errorf("events = %+v, want one audience refresh of the synced channel", rec.events)
	}

	plain, _, err := f.svc.AdminCreateChannel(ctx, 7, AdminChannelCreate{Name: "plain"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SyncChannelPermissions(ctx, 7, f.admin, plain); !errors.Is(err, ErrBadRequest) {
		t.Errorf("uncategorized sync: err = %v, want ErrBadRequest", err)
	}
	if _, err := f.svc.SyncChannelPermissions(ctx, 7, nil, f.b); !errors.Is(err, ErrForbidden) {
		t.Errorf("no actor role: err = %v, want ErrForbidden", err)
	}
}

func TestSyncChannelPermissions_HierarchyCoversRemovedRows(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	// b carries a row for a role the mod does not outrank; syncing would
	// remove it, which the mod could not do by hand.
	high := &db.Role{ID: 24, Name: "cat-high", Position: 70, Permissions: permissions.ReadMessages}
	seedRole(t, f.database, high)
	if _, err := f.svc.PutRoleOverride(ctx, 7, f.admin, f.b, high.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SyncChannelPermissions(ctx, 7, f.mod, f.b); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if allow, _ := f.channelRow(t, f.b, high.ID); allow != permissions.ReadMessages {
		t.Error("the refused sync removed a row")
	}
}

func TestSyncChannelPermissions_RowsChangedUnderTheCheckAreRefused(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	refused := error(nil)
	guard, err := f.svc.prepareSync(ctx, f.mod, f.b.ID, f.cat.ID, &refused)
	if err != nil {
		t.Fatal(err)
	}
	// A role row appears after the check and before the write.
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 1, 0)`, f.b.ID, f.low.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.database.SyncChannelPermissions(ctx, f.b.ID, guard)
	if err == nil || !errors.Is(refused, ErrPermsChanged) || !errors.Is(refused, ErrConflict) {
		t.Fatalf("err = %v, refused = %v, want ErrPermsChanged (an ErrConflict)", err, refused)
	}
	if allow, _ := f.channelRow(t, f.b, f.low.ID); allow != 1 {
		t.Error("the refused sync changed the row")
	}
}

func TestDeleteCategory_KeepsChannelOverridesAndUnsyncs(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	f.seedTemplate(t)
	if _, err := f.svc.DeleteCategory(ctx, 1, f.cat.ID); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []*db.Channel{f.a, f.b} {
		if f.synced(t, ch) {
			t.Errorf("channel %s still synced after its category was deleted", ch.Name)
		}
		if allow, deny := f.channelRow(t, ch, f.low.ID); allow != permissions.ReadMessages || deny != permissions.ManageServer {
			t.Errorf("channel %s row = (%#x,%#x), want it kept", ch.Name, allow, deny)
		}
		got, _ := f.svc.st.GetChannel(ctx, ch.ID)
		if got.CategoryID != 0 {
			t.Errorf("channel %s category = %d, want none", ch.Name, got.CategoryID)
		}
	}
	var n int
	if err := f.database.QueryRowContext(ctx, `SELECT COUNT(*) FROM category_overrides`).Scan(&n); err != nil || n != 0 {
		t.Errorf("template rows left = %d, %v; want the cascade to drop them", n, err)
	}
}

func TestAdminListChannelsSynced_ReportsTheFlag(t *testing.T) {
	f := newCatPermFixture(t)
	ctx := context.Background()
	if _, err := f.svc.PutRoleOverride(ctx, 7, f.mod, f.b, f.low.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatal(err)
	}
	list, err := f.svc.AdminListChannelsSynced(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[int64]bool{}
	for _, c := range list {
		got[c.ID] = c.PermissionsSynced
	}
	if !got[f.a.ID] || got[f.b.ID] {
		t.Errorf("flags = %v, want a synced and b not", got)
	}
}
