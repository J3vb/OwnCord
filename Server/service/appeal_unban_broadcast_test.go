package service

import (
	"context"
	"testing"
	"time"
)

// recordingUnbanBroadcaster records BroadcastMemberUnban calls so the ban
// overturn path can be asserted directly.
type recordingUnbanBroadcaster struct {
	unbanned []int64
}

func (r *recordingUnbanBroadcaster) BroadcastMemberUnban(userID int64) {
	r.unbanned = append(r.unbanned, userID)
}

// TestAppeal_OverturnBanRebroadcastsMemberUnban is OC-0486: the admin unban
// path re-adds the member to every connected roster (OC-0058), but the
// appeal-overturn path flips users.banned to 0 and writes an audit row only,
// never broadcasting. A connected client that saw the ban's member_ban had
// the row hard-deleted and keeps the user missing until it reconnects and
// takes a full resync. Overturning an upheld ban must broadcast the unban,
// exactly as the admin path does.
func TestAppeal_OverturnBanRebroadcastsMemberUnban(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	var actionID int64
	for _, r := range rows {
		if r.Kind == "ban" {
			actionID = r.ID
		}
	}
	if actionID == 0 {
		t.Fatal("no ban ledger row found")
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	broadcaster := &recordingUnbanBroadcaster{}
	f.appeals.SetUnbanBroadcaster(broadcaster)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(broadcaster.unbanned) != 1 || broadcaster.unbanned[0] != fixtureMember {
		t.Fatalf("BroadcastMemberUnban calls = %v, want exactly [%d]", broadcaster.unbanned, fixtureMember)
	}
}

// TestAppeal_UpholdBanDoesNotBroadcastUnban is the negative control: an
// upheld ban changes no ban state, so no unban frame may fire.
func TestAppeal_UpholdBanDoesNotBroadcastUnban(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "spam", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	var actionID int64
	for _, r := range rows {
		if r.Kind == "ban" {
			actionID = r.ID
		}
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, actionID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	broadcaster := &recordingUnbanBroadcaster{}
	f.appeals.SetUnbanBroadcaster(broadcaster)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "upheld", "no"); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(broadcaster.unbanned) != 0 {
		t.Fatalf("BroadcastMemberUnban calls = %v, want none — the ban was upheld", broadcaster.unbanned)
	}
}

// TestAppeal_OverturnRebanDoesNotBroadcastUnban is the superseded-ban control:
// ban, unban, re-ban, then overturn the FIRST ban's appeal must leave the
// user banned (the re-ban governs), so no unban may broadcast.
func TestAppeal_OverturnRebanDoesNotBroadcastUnban(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "first", nil); err != nil {
		t.Fatalf("BanUser(first): %v", err)
	}
	rows, err := f.database.ListModerationActionsForTarget(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	var firstBanID int64
	for _, r := range rows {
		if r.Kind == "ban" && firstBanID == 0 {
			firstBanID = r.ID
		}
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, firstBanID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if err := f.mod.UnbanUser(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}
	if err := f.mod.BanUser(ctx, fixtureMod, fixtureMember, "second", nil); err != nil {
		t.Fatalf("BanUser(second): %v", err)
	}

	broadcaster := &recordingUnbanBroadcaster{}
	f.appeals.SetUnbanBroadcaster(broadcaster)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	target, err := f.database.GetUserByID(ctx, fixtureMember)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !target.Banned {
		t.Fatal("target unbanned after overturning the FIRST ban — the re-ban should still govern")
	}
	if len(broadcaster.unbanned) != 0 {
		t.Fatalf("BroadcastMemberUnban calls = %v, want none — a newer ban still governs", broadcaster.unbanned)
	}
}

// TestAppeal_OverturnTimeoutDoesNotBroadcastUnban: a timeout carries no ban
// state, so its overturn must not fire an unban frame.
func TestAppeal_OverturnTimeoutDoesNotBroadcastUnban(t *testing.T) {
	f := newAppealFixture(t)
	ctx := context.Background()

	result, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil)
	if err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	publicID, err := f.appeals.Submit(ctx, fixtureMember, result.ID, "please")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	broadcaster := &recordingUnbanBroadcaster{}
	f.appeals.SetUnbanBroadcaster(broadcaster)

	if err := f.appeals.Decide(ctx, fixturePeerMod, publicID, "overturned", "fine"); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if len(broadcaster.unbanned) != 0 {
		t.Fatalf("BroadcastMemberUnban calls = %v, want none — a timeout has no ban half", broadcaster.unbanned)
	}
}
