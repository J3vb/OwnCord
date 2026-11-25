package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// The editor (user 7, role mod) is denied READ_MESSAGES on the channel: no
// override edit there goes through, whatever its bits, and nothing is written.
func TestChannelOverrides_EditorWithoutViewIsRefused(t *testing.T) {
	t.Parallel()
	svc, database, mod, low, ch := seedOverrideFixture(t)
	seedChannelOverride(t, database, mod.ID, ch.ID, 0, permissions.ReadMessages)
	seedChannelOverride(t, database, low.ID, ch.ID, 0, permissions.ReadMessages)
	seedUserRole(t, database, 40, low.ID)
	ctx := context.Background()

	steps := map[string]func() error{
		"user put": func() error {
			_, err := svc.PutUserOverride(ctx, 7, mod, ch, 40, permissions.ReadMessages, 0)
			return err
		},
		"role delete": func() error {
			_, err := svc.DeleteRoleOverride(ctx, 7, mod, ch, low.ID)
			return err
		},
		"role put": func() error {
			_, err := svc.PutRoleOverride(ctx, 7, mod, ch, low.ID, permissions.ReadMessages, 0)
			return err
		},
	}
	for name, step := range steps {
		if err := step(); !errors.Is(err, ErrForbidden) {
			t.Errorf("%s: err = %v, want ErrForbidden", name, err)
		}
	}
	if allow, deny, err := database.GetChannelPermissions(ctx, ch.ID, low.ID); err != nil || allow != 0 || deny != permissions.ReadMessages {
		t.Errorf("low role row = (%#x,%#x), %v; want the deny untouched", allow, deny, err)
	}
	if allow, _, err := database.GetUserChannelPermissions(ctx, ch.ID, 40); err != nil || allow != 0 {
		t.Errorf("user row allow = %#x, %v; want none written", allow, err)
	}
}

// An Administrator keeps editing overrides on a channel hidden from its role.
func TestChannelOverrides_AdministratorEditsHiddenChannel(t *testing.T) {
	t.Parallel()
	svc, database, _, low, ch := seedOverrideFixture(t)
	admin := &db.Role{ID: 23, Name: "chan-admin", Position: 80, Permissions: permissions.Administrator}
	seedRole(t, database, admin)
	seedUserRole(t, database, 8, admin.ID)
	seedChannelOverride(t, database, admin.ID, ch.ID, 0, permissions.ReadMessages)

	if _, err := svc.PutRoleOverride(context.Background(), 8, admin, ch, low.ID, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("PutRoleOverride as Administrator: %v", err)
	}
}

// A category template write that reaches a synced channel the editor cannot
// read is refused before anything is written.
func TestCategoryOverride_SyncedChannelWithoutViewIsRefused(t *testing.T) {
	t.Parallel()
	f := newCatPermFixture(t)
	ctx := context.Background()
	if !f.synced(t, f.b) {
		t.Fatal("fixture channel beta is not synced")
	}
	seedChannelOverride(t, f.database, f.mod.ID, f.b.ID, 0, permissions.ReadMessages)

	if _, err := f.svc.PutCategoryRoleOverride(ctx, 7, f.mod, f.cat.ID, f.low.ID, permissions.SendMessages, 0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if allow, _ := f.channelRow(t, f.a, f.low.ID); allow != 0 {
		t.Errorf("a readable synced channel was written: allow = %#x", allow)
	}
	if _, err := f.svc.SyncChannelPermissions(ctx, 7, f.mod, f.b); !errors.Is(err, ErrForbidden) {
		t.Errorf("sync of a hidden channel: err = %v, want ErrForbidden", err)
	}
}

// A channel the write reaches that categoryViewGate never checked (synced in
// between) is refused as a conflict to retry.
func TestCategoryOverrideGuard_UncheckedChannelIsAConflict(t *testing.T) {
	t.Parallel()
	actor := &db.Role{ID: 21, Position: 50, Permissions: permissions.ManageChannels | permissions.ReadMessages}
	var refused error
	guard := categoryOverrideGuard(actor, permissions.ReadMessages, 0, func(id int64) bool { return id == 1 }, &refused)
	err := guard(db.CategoryOverrideScope{Channels: []db.SyncedChannelBits{{ChannelID: 1}, {ChannelID: 2}}})
	if err == nil || !errors.Is(refused, ErrPermsChanged) || !errors.Is(refused, ErrConflict) {
		t.Fatalf("err = %v, refused = %v; want ErrPermsChanged (an ErrConflict)", err, refused)
	}
}
