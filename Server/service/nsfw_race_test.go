package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// newNSFWRaceFixture wires a real in-memory DB, a member with visibility on
// channel 10, and both the NSFWService and ChannelService that mutate its
// label — everything P2-2 and P2-3's interleaving tests need.
func newNSFWRaceFixture(t *testing.T) (ctx context.Context, database *db.DB, nsfw *NSFWService, channels *ChannelService) {
	t.Helper()
	ctx = context.Background()
	database = newTestDB(t)
	seedRole(t, database, &db.Role{
		ID:          permissions.MemberRoleID,
		Name:        "member",
		Permissions: permissions.SendMessages | permissions.ReadMessages,
		Position:    1,
	})
	seedUserRole(t, database, 1, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})

	perms := NewPermissionService(database, permissions.NewChecker(database))
	nsfw = NewNSFWService(database, perms)
	channels = NewChannelService(database, perms)
	return ctx, database, nsfw, channels
}

// labelChannel flips channel 10's nsfw flag straight in the DB — a
// concurrent admin edit, deliberately bypassing ChannelService so the test
// can interleave it exactly where it wants rather than through another
// service call.
func labelChannel(t *testing.T, database *db.DB, channelID int64, nsfw bool) {
	t.Helper()
	v := 0
	if nsfw {
		v = 1
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = ? WHERE id = ?`, v, channelID); err != nil {
		t.Fatalf("labelChannel(%d, %v): %v", channelID, nsfw, err)
	}
}

// TestNSFWAcknowledge_UnlabelBetweenCheckAndInsertIsNotTrusted is P2-2: the
// old code read ch.NSFW in checkVisible, then separately inserted the
// acknowledgement row — an unlabel landing in between (which also clears any
// existing rows, decision 13) would still let the insert land afterwards,
// producing a stale "yes" for a channel that is not, right now, labelled.
// nsfwAcknowledgeRaceHook pins the interleaving deterministically: the
// channel reads as labelled during checkVisible, is unlabelled by the hook,
// and only THEN does the atomic insert run.
func TestNSFWAcknowledge_UnlabelBetweenCheckAndInsertIsNotTrusted(t *testing.T) {
	ctx, database, nsfw, _ := newNSFWRaceFixture(t)
	labelChannel(t, database, 10, true)

	t.Cleanup(func() { nsfwAcknowledgeRaceHook = nil })
	nsfwAcknowledgeRaceHook = func() {
		labelChannel(t, database, 10, false)
	}

	err := nsfw.Acknowledge(ctx, 1, 10)
	if !errors.Is(err, ErrNotNSFW) {
		t.Fatalf("Acknowledge racing an unlabel = %v, want ErrNotNSFW — a stale label read must not let consent land after the channel is unlabelled", err)
	}

	ok, hErr := database.HasNSFWAcknowledgement(ctx, 1, 10)
	if hErr != nil {
		t.Fatalf("HasNSFWAcknowledgement: %v", hErr)
	}
	if ok {
		t.Fatal("an acknowledgement row was inserted despite the channel being unlabelled by the time the insert ran")
	}
}

// TestAdminUpdateChannel_ClearsAcksOnResultingFlagRegardlessOfStaleRead is
// P2-3: the caller's `existing` snapshot can be stale by the time this
// commits — a concurrent label-and-acknowledge landing after `existing` was
// read but before this edit's write must not survive an edit that (from
// existing's point of view) never turned the flag off. The clear is gated on
// the RESULTING flag (req.NSFW == false), not on existing.NSFW.
func TestAdminUpdateChannel_ClearsAcksOnResultingFlagRegardlessOfStaleRead(t *testing.T) {
	ctx, database, nsfwSvc, channels := newNSFWRaceFixture(t)

	// existing is read while the channel is NOT labelled.
	existing, err := database.GetChannel(ctx, 10)
	if err != nil || existing == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if existing.NSFW {
		t.Fatal("precondition: channel must start unlabelled")
	}

	// Concurrently: another admin labels it, and a member acknowledges it —
	// both land before this edit commits, but after `existing` was read.
	labelChannel(t, database, 10, true)
	if err := nsfwSvc.Acknowledge(ctx, 1, 10); err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}
	if ok, hErr := database.HasNSFWAcknowledgement(ctx, 1, 10); hErr != nil || !ok {
		t.Fatalf("precondition: acknowledgement not recorded: ok=%v err=%v", ok, hErr)
	}

	// This edit's req.NSFW is false — the same as existing.NSFW's stale
	// read, so the OLD 1→0-transition-only gate would have skipped the
	// clear entirely and left the acknowledgement row on file.
	if _, err := channels.AdminUpdateChannel(ctx, 1, existing, AdminChannelUpdate{
		Name: "general", NSFW: false,
	}, nil); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}

	if ok, hErr := database.HasNSFWAcknowledgement(ctx, 1, 10); hErr != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after the edit = (%v, %v), want (false, nil) — "+
			"consent for a DIFFERENT (concurrent) labelling must not survive an edit whose stale "+
			"existing.NSFW read never saw it turn on", ok, hErr)
	}
}
