package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// newModerationActionsTestDB seeds a fully migrated database with an owner
// (role 1, position 100) and a member (role 4, position 40) — enough rank
// gap for every ledger write in this file to pass recordModerationAction's
// live guard.
func newModerationActionsTestDB(t *testing.T) (database *db.DB, ownerID, memberID int64) {
	t.Helper()
	database = openMigratedMemory(t)
	ownerID, err := database.CreateUser(context.Background(), "actionsowner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	memberID, err = database.CreateUser(context.Background(), "actionsmember", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	return database, ownerID, memberID
}

func TestWarnUser_WritesRowAndRejectsPeer(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	id, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != id || rows[0].Kind != "warning" || rows[0].Reason != "be nice" {
		t.Fatalf("rows = %+v, want one warning row with id %d", rows, id)
	}

	// A peer (same rank) is refused by the live guard.
	peerID, err := database.CreateUser(ctx, "actionspeer", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(peer): %v", err)
	}
	if _, err := database.WarnUser(ctx, memberID, peerID, nil, "x"); err != nil {
		t.Fatalf("WarnUser by a second owner-rank actor: %v (peers of the FIRST owner would be refused, but this is a distinct higher-rank actor over a lower-rank target)", err)
	}
	if _, err := database.WarnUser(ctx, peerID, ownerID, nil, "x"); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("WarnUser targeting a peer: want db.ErrOutranked, got %v", err)
	}
}

func TestTimeoutUser_HasActiveTimeout_LiftTimeout(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	active, err := database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout (none yet): %v", err)
	}
	if active {
		t.Fatal("HasActiveTimeout = true before any timeout was issued")
	}

	if _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	active, err = database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("HasActiveTimeout = false right after TimeoutUser")
	}

	lifted, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if !lifted {
		t.Fatal("LiftTimeout reported nothing lifted")
	}
	active, err = database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout after lift: %v", err)
	}
	if active {
		t.Fatal("HasActiveTimeout = true after LiftTimeout")
	}

	// Lifting again finds nothing.
	lifted, err = database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("second LiftTimeout: %v", err)
	}
	if lifted {
		t.Fatal("second LiftTimeout reported a lift with nothing active")
	}
}

func TestLiftTimeout_ErasedLifterRefused(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if _, err := database.EraseAccount(ctx, ownerID, ""); err != nil {
		// The owner is the only admin-class account here, so EraseAccount may
		// refuse with ErrLastAdmin -- either way the point is the GUARD,
		// exercised directly below regardless of whether this erasure landed.
		t.Logf("EraseAccount(owner): %v (continuing to exercise the guard directly)", err)
	}
	lifted, err := database.LiftTimeout(ctx, memberID, 999999)
	if err != nil {
		t.Fatalf("LiftTimeout with a nonexistent lifter: %v", err)
	}
	if lifted {
		t.Fatal("LiftTimeout succeeded for a lifter id with no users row")
	}
}

func TestAcknowledgeWarning_OwnRowsOnly(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	id, err := database.WarnUser(ctx, memberID, ownerID, nil, "be nice")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}

	otherID, err := database.CreateUser(ctx, "actionsother", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(other): %v", err)
	}
	ok, err := database.AcknowledgeWarning(ctx, otherID, id)
	if err != nil {
		t.Fatalf("AcknowledgeWarning(other): %v", err)
	}
	if ok {
		t.Fatal("AcknowledgeWarning succeeded for a foreign user")
	}

	ok, err = database.AcknowledgeWarning(ctx, memberID, id)
	if err != nil {
		t.Fatalf("AcknowledgeWarning(target): %v", err)
	}
	if !ok {
		t.Fatal("AcknowledgeWarning did not report success for the target")
	}
	notices, err := database.ListUnacknowledgedWarnings(ctx, memberID)
	if err != nil {
		t.Fatalf("ListUnacknowledgedWarnings: %v", err)
	}
	if len(notices) != 0 {
		t.Fatalf("notices after ack = %+v, want none", notices)
	}

	// Repeating finds nothing left to acknowledge.
	ok, err = database.AcknowledgeWarning(ctx, memberID, id)
	if err != nil {
		t.Fatalf("second AcknowledgeWarning: %v", err)
	}
	if ok {
		t.Fatal("second AcknowledgeWarning reported success")
	}
}

func TestListModerationActionsForReport(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	reportID := int64(1234)
	if _, err := database.WarnUser(ctx, memberID, ownerID, &reportID, "linked"); err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	if _, err := database.WarnUser(ctx, memberID, ownerID, nil, "unlinked"); err != nil {
		t.Fatalf("WarnUser (unlinked): %v", err)
	}
	rows, err := database.ListModerationActionsForReport(ctx, reportID)
	if err != nil {
		t.Fatalf("ListModerationActionsForReport: %v", err)
	}
	if len(rows) != 1 || rows[0].ReportID == nil || *rows[0].ReportID != reportID || rows[0].Reason != "linked" {
		t.Fatalf("rows = %+v, want exactly the linked row", rows)
	}
}

func TestBanUserWithAction_WritesLedgerRowAndRejectsPeer(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	id, err := database.BanUserWithAction(ctx, memberID, "spam", nil, ownerID, nil)
	if err != nil {
		t.Fatalf("BanUserWithAction: %v", err)
	}
	target, err := database.GetUserByID(ctx, memberID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if !target.Banned {
		t.Fatal("target not banned after BanUserWithAction")
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == id && r.Kind == "ban" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no ban row with id %d found in %+v", id, rows)
	}

	// A peer target is refused, and rolled back — never banned.
	peerID, err := database.CreateUser(ctx, "actionsbanpeer", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(peer): %v", err)
	}
	if _, err := database.BanUserWithAction(ctx, peerID, "coup", nil, ownerID, nil); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("BanUserWithAction on a peer: want db.ErrOutranked, got %v", err)
	}
	peer, err := database.GetUserByID(ctx, peerID)
	if err != nil {
		t.Fatalf("GetUserByID(peer): %v", err)
	}
	if peer.Banned {
		t.Fatal("a refused ban left the peer banned — the effect did not roll back")
	}
}

func TestForceLogoutWithAction_WritesLedgerRowAndRevokesSessions(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if _, err := database.CreateSession(ctx, memberID, "moderation-kick-test", "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	id, err := database.ForceLogoutWithAction(ctx, memberID, ownerID, nil)
	if err != nil {
		t.Fatalf("ForceLogoutWithAction: %v", err)
	}
	sessions, err := database.GetUserSessions(ctx, memberID)
	if err != nil {
		t.Fatalf("GetUserSessions: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("sessions after ForceLogoutWithAction = %d, want 0", len(sessions))
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.ID == id && r.Kind == "kick" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no kick row with id %d found in %+v", id, rows)
	}
}

func TestDeleteMessageWithRemoval(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	chID := seedTestChannel(t, database)
	selfMsgID, err := database.CreateMessage(ctx, chID, memberID, "my own message", nil)
	if err != nil {
		t.Fatalf("CreateMessage(self): %v", err)
	}
	// A self-delete (or non-mod delete) writes no ledger row: unchanged
	// DeleteMessage behavior.
	if err := database.DeleteMessageWithRemoval(ctx, selfMsgID, memberID, false, memberID, nil); err != nil {
		t.Fatalf("DeleteMessageWithRemoval (self): %v", err)
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("a self-delete wrote %d ledger row(s), want 0", len(rows))
	}

	modMsgID, err := database.CreateMessage(ctx, chID, memberID, "moderated message", nil)
	if err != nil {
		t.Fatalf("CreateMessage(mod): %v", err)
	}
	if err := database.DeleteMessageWithRemoval(ctx, modMsgID, ownerID, true, memberID, nil); err != nil {
		t.Fatalf("DeleteMessageWithRemoval (moderator): %v", err)
	}
	msg, err := database.GetMessage(ctx, modMsgID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if !msg.Deleted {
		t.Fatal("moderator delete did not soft-delete the message")
	}
	rows, err = database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget (2): %v", err)
	}
	if len(rows) != 1 || rows[0].Kind != "removal" {
		t.Fatalf("rows = %+v, want exactly one removal row", rows)
	}
}

// TestDeleteMessageWithRemoval_ErasedActorRefused: recordLedgerRow has no
// rank JOIN of its own (unlike recordModerationAction), so it carries an
// explicit EXISTS(users) check — a moderator concurrently erased between
// authorization and this write must not land as the actor of a ledger row,
// and the message delete itself must roll back with it.
func TestDeleteMessageWithRemoval_ErasedActorRefused(t *testing.T) {
	database, _, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()
	chID := seedTestChannel(t, database)
	msgID, err := database.CreateMessage(ctx, chID, memberID, "moderated message", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	const noSuchActor = int64(999999)
	if err := database.DeleteMessageWithRemoval(ctx, msgID, noSuchActor, true, memberID, nil); !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("DeleteMessageWithRemoval with a nonexistent actor: want db.ErrOutranked, got %v", err)
	}
	msg, err := database.GetMessage(ctx, msgID)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg.Deleted {
		t.Fatal("the delete was not rolled back for a nonexistent actor")
	}
}

func TestPurgeChannelMessagesWithAction(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()
	chID := seedTestChannel(t, database)
	for range 3 {
		if _, err := database.CreateMessage(ctx, chID, memberID, "purge me", nil); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
	}

	ids, err := database.PurgeChannelMessagesWithAction(ctx, chID, 0, 10, ownerID, nil)
	if err != nil {
		t.Fatalf("PurgeChannelMessagesWithAction: %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("purged %d messages, want 3", len(ids))
	}
	// The ledger row targets the ACTOR (a bulk purge has no single author) —
	// see recordLedgerRow's doc comment.
	rows, err := database.ListModerationActionsForTarget(ctx, ownerID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	if len(rows) != 1 || rows[0].Kind != "removal" || rows[0].Reason != "3 messages purged" {
		t.Fatalf("rows = %+v, want one removal row reasoned \"3 messages purged\"", rows)
	}

	// limit < 1 is a no-op, same as PurgeChannelMessages.
	ids, err = database.PurgeChannelMessagesWithAction(ctx, chID, 0, 0, ownerID, nil)
	if err != nil {
		t.Fatalf("PurgeChannelMessagesWithAction(limit=0): %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("purged %d messages with limit 0, want 0", len(ids))
	}
}

func TestModerationRetention_RetiresWarningsAndTimeoutsOnly(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if n, err := database.RetireModerationActions(ctx, 0); err != nil || n != 0 {
		t.Fatalf("RetireModerationActions(days=0) = (%d, %v), want (0, nil) — 0 must mean never", n, err)
	}

	// A warning acknowledged long ago retires; one acknowledged just now does not.
	oldID, err := database.WarnUser(ctx, memberID, ownerID, nil, "old")
	if err != nil {
		t.Fatalf("WarnUser(old): %v", err)
	}
	newID, err := database.WarnUser(ctx, memberID, ownerID, nil, "new")
	if err != nil {
		t.Fatalf("WarnUser(new): %v", err)
	}
	if ok, err := database.AcknowledgeWarning(ctx, memberID, oldID); err != nil || !ok {
		t.Fatalf("ack old: ok=%v err=%v", ok, err)
	}
	if ok, err := database.AcknowledgeWarning(ctx, memberID, newID); err != nil || !ok {
		t.Fatalf("ack new: ok=%v err=%v", ok, err)
	}
	// Backdate the OLD row's acknowledged_at 100 days into the past directly
	// -- the sweep's own clock, not a fabricated one.
	if _, err := database.ExecContext(ctx,
		`UPDATE moderation_actions SET acknowledged_at = datetime('now', '-100 days') WHERE id = ?`, oldID); err != nil {
		t.Fatalf("backdate old: %v", err)
	}

	// A timeout expired 100 days ago retires; an active one does not.
	oldTimeoutID, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "old timeout", time.Now().Add(-100*24*time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(old): %v", err)
	}
	if _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "active timeout", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser(active): %v", err)
	}

	// Ban/kick/removal rows are never touched, regardless of age.
	banID, err := database.BanUserWithAction(ctx, memberID, "spam", nil, ownerID, nil)
	if err != nil {
		t.Fatalf("BanUserWithAction: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE moderation_actions SET created_at = datetime('now', '-1000 days') WHERE id = ?`, banID); err != nil {
		t.Fatalf("backdate ban: %v", err)
	}

	n, err := database.RetireModerationActions(ctx, 90)
	if err != nil {
		t.Fatalf("RetireModerationActions(days=90): %v", err)
	}
	if n != 2 {
		t.Fatalf("retired %d rows, want 2 (the old warning and the old timeout)", n)
	}

	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	remaining := map[int64]bool{}
	for _, r := range rows {
		remaining[r.ID] = true
	}
	if remaining[oldID] {
		t.Error("the old acknowledged warning was not retired")
	}
	if !remaining[newID] {
		t.Error("the recently acknowledged warning was wrongly retired")
	}
	if remaining[oldTimeoutID] {
		t.Error("the old expired timeout was not retired")
	}
	if !remaining[banID] {
		t.Error("the ban row was wrongly retired")
	}
}

// TestModerationRetention_SkipsAppealedActions: B5-10 wires the join
// RetireModerationActions' comment used to point at — a warning or timeout
// row an appeals row references must survive the sweep regardless of age,
// because decision 8's UNIQUE(action_id) memory is what forbids re-appealing
// it, and sweeping the row away would silently reopen that door.
func TestModerationRetention_SkipsAppealedActions(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	appealedID, err := database.WarnUser(ctx, memberID, ownerID, nil, "appealed")
	if err != nil {
		t.Fatalf("WarnUser(appealed): %v", err)
	}
	unappealedID, err := database.WarnUser(ctx, memberID, ownerID, nil, "unappealed")
	if err != nil {
		t.Fatalf("WarnUser(unappealed): %v", err)
	}
	if _, err := database.AcknowledgeWarning(ctx, memberID, appealedID); err != nil {
		t.Fatalf("ack appealed: %v", err)
	}
	if _, err := database.AcknowledgeWarning(ctx, memberID, unappealedID); err != nil {
		t.Fatalf("ack unappealed: %v", err)
	}
	// Backdate both past the retention window.
	if _, err := database.ExecContext(ctx,
		`UPDATE moderation_actions SET acknowledged_at = datetime('now', '-100 days') WHERE id IN (?, ?)`,
		appealedID, unappealedID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if _, err := database.InsertAppeal(ctx, "pub-retention-appeal", appealedID, memberID, "please reconsider"); err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	n, err := database.RetireModerationActions(ctx, 90)
	if err != nil {
		t.Fatalf("RetireModerationActions: %v", err)
	}
	if n != 1 {
		t.Fatalf("retired %d rows, want 1 (only the unappealed one)", n)
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	remaining := map[int64]bool{}
	for _, r := range rows {
		remaining[r.ID] = true
	}
	if !remaining[appealedID] {
		t.Error("the appealed warning was retired — decision 8's UNIQUE(action_id) memory is now unenforceable for it")
	}
	if remaining[unappealedID] {
		t.Error("the unappealed warning was not retired")
	}
}

// seedTestChannel creates a bare text channel for message-removal tests.
func seedTestChannel(t *testing.T, database *db.DB) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), "moderation-actions-test", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return id
}
