package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

	if _, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	active, err = database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("HasActiveTimeout = false right after TimeoutUser")
	}

	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 1 {
		t.Fatalf("LiftTimeout reported %d lifted ids, want 1", len(liftedIDs))
	}
	active, err = database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout after lift: %v", err)
	}
	if active {
		t.Fatal("HasActiveTimeout = true after LiftTimeout")
	}

	// Lifting again finds nothing.
	liftedIDs, err = database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("second LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 0 {
		t.Fatal("second LiftTimeout reported a lift with nothing active")
	}
}

// TestLiftTimeout_NonexistentLifterRefused: a lifter id with no users row —
// erased mid-flight, or simply never existed — fails the transactional rank
// re-check (P2-8, Codex review: LiftTimeout previously had no rank check at
// all) rather than silently reporting "nothing lifted".
func TestLiftTimeout_NonexistentLifterRefused(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if _, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	liftedIDs, err := database.LiftTimeout(ctx, memberID, 999999)
	if !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("LiftTimeout with a nonexistent lifter: want db.ErrOutranked, got (%v, %v)", liftedIDs, err)
	}
	active, err := database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("a refused lift left the timeout inactive")
	}
}

// TestLiftTimeout_DemotedActorRefused is P2-8's live rank re-check: an actor
// who outranked the target when the timeout was issued but has since been
// demoted to the target's rank or below is refused AT THE WRITE, not merely
// by a caller's earlier (possibly stale) check.
func TestLiftTimeout_DemotedActorRefused(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if _, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	// Demote the "owner" role itself to the member role's own position (40),
	// so ownerID no longer outranks memberID.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET position = 40 WHERE id = 1`); err != nil {
		t.Fatalf("demote owner role: %v", err)
	}
	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if !errors.Is(err, db.ErrOutranked) {
		t.Fatalf("LiftTimeout by a demoted actor: want db.ErrOutranked, got (%v, %v)", liftedIDs, err)
	}
	active, err := database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if !active {
		t.Fatal("a refused lift left the timeout inactive")
	}
}

// TestTimeoutUser_SupersedesEarlierActiveTimeout is P2-9: issuing a new
// timeout on a target who already has one active lifts the earlier row in
// the SAME transaction, so LiftTimeout is never left choosing between
// overlapping active rows.
func TestTimeoutUser_SupersedesEarlierActiveTimeout(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	firstID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "first", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(first): %v", err)
	}
	secondID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "second", time.Now().Add(2*time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(second): %v", err)
	}

	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	byID := map[int64]int{}
	for i, r := range rows {
		byID[r.ID] = i
	}
	first, ok := byID[firstID]
	if !ok {
		t.Fatalf("first timeout row %d missing from %+v", firstID, rows)
	}
	if rows[first].LiftedAt == nil {
		t.Fatal("the first (superseded) timeout was not lifted when the second was issued")
	}
	second, ok := byID[secondID]
	if !ok {
		t.Fatalf("second timeout row %d missing from %+v", secondID, rows)
	}
	if rows[second].LiftedAt != nil {
		t.Fatal("the second (current) timeout must stay active, not lifted by its own insert")
	}

	// Only the second is active; a single lift call lifts exactly it.
	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 1 || liftedIDs[0] != secondID {
		t.Fatalf("LiftTimeout = %v, want exactly [%d]", liftedIDs, secondID)
	}
}

// TestLiftTimeout_LiftsEveryActiveRow is P2-9's defensive half: even if more
// than one row is somehow active at once (bypassing TimeoutUser's own
// supersede, as a raw insert below does to model a pre-existing overlap),
// LiftTimeout lifts ALL of them in one call, not only the newest.
func TestLiftTimeout_LiftsEveryActiveRow(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	future := time.Now().Add(time.Hour).UTC().Format("2006-01-02 15:04:05")
	for range 2 {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO moderation_actions (kind, target_id, actor_id, reason, expires_at) VALUES ('timeout', ?, ?, 'x', ?)`,
			memberID, ownerID, future); err != nil {
			t.Fatalf("seed overlapping active timeout: %v", err)
		}
	}

	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 2 {
		t.Fatalf("LiftTimeout reported %d lifted ids, want 2", len(liftedIDs))
	}
	active, err := database.HasActiveTimeout(ctx, memberID)
	if err != nil {
		t.Fatalf("HasActiveTimeout: %v", err)
	}
	if active {
		t.Fatal("a row was still active after LiftTimeout — it must lift every active row, not just one")
	}
}

// TestTimeoutUser_TransfersVoiceMuteOwnershipOnSupersede is round 4's
// replacement for P2 17 (Codex review round 3): timeout A applies (and
// owns) a mute through a REAL voice session; timeout B supersedes A with
// its own voice half skipped entirely (no MuteForTimeoutSession call for
// B). B must still end up owning the still-live mute in voice_states —
// superseding never touches the SFU, so A's mute is still live, and only
// B is left for a later LiftTimeout to act on — proved end to end: lift B,
// clear whichever row LiftTimeout's own ids now own, and see it unmuted.
func TestTimeoutUser_TransfersVoiceMuteOwnershipOnSupersede(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()
	chanID, err := database.CreateChannel(ctx, "vc-supersede", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, memberID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(ctx, memberID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	idA, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "first", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(A): %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, memberID, chanID, idA, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession(A): matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}

	// B supersedes A. Ownership transfer is no longer TimeoutUser's own
	// side effect (round 5, Codex review P2 — it must run inside the voice
	// half's own lock/transaction, not as a bare write TimeoutUser makes on
	// its own): B's OWN voice half carries supersededIDs through to its
	// MuteForTimeoutSession call, which does the transfer.
	idB, supersededIDs, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "second", time.Now().Add(2*time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(B): %v", err)
	}
	if len(supersededIDs) != 1 || supersededIDs[0] != idA {
		t.Fatalf("TimeoutUser(B) supersededIDs = %v, want [%d]", supersededIDs, idA)
	}
	if matched, _, err := database.MuteForTimeoutSession(ctx, memberID, chanID, idB, state.JoinedAt, supersededIDs); err != nil || !matched {
		t.Fatalf("MuteForTimeoutSession(B): matched=%v err=%v", matched, err)
	}

	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, memberID, []int64{idA}); err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy(A) cleared=%v err=%v, want false: ownership already transferred to B", cleared, err)
	}
	before, err := database.GetVoiceState(ctx, memberID)
	if err != nil || before == nil || !before.ServerMuted {
		t.Fatal("the mute must still be in effect after A is superseded")
	}

	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 1 || liftedIDs[0] != idB {
		t.Fatalf("LiftTimeout = %v, want exactly [%d]", liftedIDs, idB)
	}
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, memberID, liftedIDs); err != nil || !cleared {
		t.Fatalf("ClearServerMuteOwnedBy(liftedIDs) cleared=%v err=%v, want true: B owns the transferred mute", cleared, err)
	}
	final, err := database.GetVoiceState(ctx, memberID)
	if err != nil || final == nil {
		t.Fatalf("GetVoiceState (final): %v", err)
	}
	if final.ServerMuted {
		t.Error("ServerMuted = true, want false: lifting B must clear the mute it inherited from A")
	}
}

// TestLiftTimeout_LeaveAndRejoinIsolatesTheNewSession is round 4's fix for
// Codex 13: an OLD timeout's lifted id must never clear a mute on a NEW
// voice session (a leave and rejoin between the mute and the lift) —
// session-bound ownership, not a ledger flag that could be misread across
// sessions.
func TestLiftTimeout_LeaveAndRejoinIsolatesTheNewSession(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()
	chanID, err := database.CreateChannel(ctx, "vc-rejoin", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, memberID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel (first): %v", err)
	}
	first, err := database.GetVoiceState(ctx, memberID)
	if err != nil || first == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	id, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, memberID, chanID, id, first.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}

	// Leave and rejoin the SAME channel — a brand-new session with no owner.
	if err := database.LeaveVoiceChannel(ctx, memberID); err != nil {
		t.Fatalf("LeaveVoiceChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, memberID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel (rejoin): %v", err)
	}
	// The NEW session gets its own manual mute — nothing to do with the old
	// timeout, and must survive the old timeout's lift below.
	if matched, err := database.SetVoiceServerMute(ctx, memberID, chanID, true); err != nil || !matched {
		t.Fatalf("SetVoiceServerMute: matched=%v err=%v", matched, err)
	}

	liftedIDs, err := database.LiftTimeout(ctx, memberID, ownerID)
	if err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	if len(liftedIDs) != 1 || liftedIDs[0] != id {
		t.Fatalf("LiftTimeout = %v, want exactly [%d]", liftedIDs, id)
	}
	if _, _, cleared, err := database.ClearServerMuteOwnedBy(ctx, memberID, liftedIDs); err != nil || cleared {
		t.Fatalf("ClearServerMuteOwnedBy cleared=%v err=%v, want false: the old id must not touch the new session", cleared, err)
	}
	state, err := database.GetVoiceState(ctx, memberID)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatal("the NEW session's manual mute must survive the OLD timeout's lift")
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
	id, err := database.ForceLogoutWithAction(ctx, memberID, ownerID, nil, "")
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
	if err := database.DeleteMessageWithRemoval(ctx, selfMsgID, memberID, false, memberID, nil, ""); err != nil {
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
	if err := database.DeleteMessageWithRemoval(ctx, modMsgID, ownerID, true, memberID, nil, "violated rule 3"); err != nil {
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
	// The submitted reason is stored verbatim (P2-10, Codex review) rather
	// than always the fixed phrase "message removed".
	if len(rows) != 1 || rows[0].Kind != "removal" || rows[0].Reason != "violated rule 3" {
		t.Fatalf("rows = %+v, want exactly one removal row reasoned %q", rows, "violated rule 3")
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
	if err := database.DeleteMessageWithRemoval(ctx, msgID, noSuchActor, true, memberID, nil, ""); !errors.Is(err, db.ErrOutranked) {
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
	oldTimeoutID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "old timeout", time.Now().Add(-100*24*time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser(old): %v", err)
	}
	if _, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "active timeout", time.Now().Add(time.Hour)); err != nil {
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
// TestModerationRetention_SkipsAppealedActions covers three states an
// appeals row can sit in when its action ages past the retention window:
// open (appealedID), withdrawn (withdrawnAppealID) and decided/upheld
// (upheldAppealID). The exclusion is "any row appeals references", not
// "any row with a currently-live appeal" — a withdrawn or already-decided
// appeal still carries decision 8's UNIQUE(action_id) memory, and sweeping
// its action away would silently reopen the door to a second appeal
// against the same action just as surely as sweeping an open one would.
func TestModerationRetention_SkipsAppealedActions(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	appealedID, err := database.WarnUser(ctx, memberID, ownerID, nil, "appealed")
	if err != nil {
		t.Fatalf("WarnUser(appealed): %v", err)
	}
	withdrawnAppealID, err := database.WarnUser(ctx, memberID, ownerID, nil, "withdrawn")
	if err != nil {
		t.Fatalf("WarnUser(withdrawn): %v", err)
	}
	upheldAppealID, err := database.WarnUser(ctx, memberID, ownerID, nil, "upheld")
	if err != nil {
		t.Fatalf("WarnUser(upheld): %v", err)
	}
	unappealedID, err := database.WarnUser(ctx, memberID, ownerID, nil, "unappealed")
	if err != nil {
		t.Fatalf("WarnUser(unappealed): %v", err)
	}
	for _, id := range []int64{appealedID, withdrawnAppealID, upheldAppealID, unappealedID} {
		if _, err := database.AcknowledgeWarning(ctx, memberID, id); err != nil {
			t.Fatalf("ack %d: %v", id, err)
		}
	}
	// Backdate all four past the retention window.
	if _, err := database.ExecContext(ctx,
		`UPDATE moderation_actions SET acknowledged_at = datetime('now', '-100 days') WHERE id IN (?, ?, ?, ?)`,
		appealedID, withdrawnAppealID, upheldAppealID, unappealedID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if _, err := database.InsertAppeal(ctx, "pub-retention-appeal", appealedID, memberID, "please reconsider"); err != nil {
		t.Fatalf("InsertAppeal(open): %v", err)
	}
	withdrawnID, err := database.InsertAppeal(ctx, "pub-retention-withdrawn", withdrawnAppealID, memberID, "please reconsider")
	if err != nil {
		t.Fatalf("InsertAppeal(withdrawn): %v", err)
	}
	if ok, err := database.WithdrawAppeal(ctx, withdrawnID, memberID); err != nil || !ok {
		t.Fatalf("WithdrawAppeal: (%v, %v), want (true, nil)", ok, err)
	}
	upheldID, err := database.InsertAppeal(ctx, "pub-retention-upheld", upheldAppealID, memberID, "please reconsider")
	if err != nil {
		t.Fatalf("InsertAppeal(upheld): %v", err)
	}
	action, err := database.GetModerationAction(ctx, upheldAppealID)
	if err != nil {
		t.Fatalf("GetModerationAction: %v", err)
	}
	reversal := db.AppealedAction{ID: action.ID, Kind: action.Kind, TargetID: action.TargetID}
	if result, _, _, err := database.DecideAppealTx(ctx, upheldID, "open", 0, "upheld", ownerID, "no",
		false, memberID, permissions.ModerateMembers, permissions.Administrator, reversal, nil); err != nil || result != db.AppealWriteOK {
		t.Fatalf("DecideAppealTx: (%v, %v), want (AppealWriteOK, nil)", result, err)
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
		t.Error("the openly-appealed warning was retired — decision 8's UNIQUE(action_id) memory is now unenforceable for it")
	}
	if !remaining[withdrawnAppealID] {
		t.Error("the withdrawn-appeal warning was retired — a withdrawn appeal still carries the UNIQUE(action_id) memory")
	}
	if !remaining[upheldAppealID] {
		t.Error("the upheld-appeal warning was retired — a decided appeal still carries the UNIQUE(action_id) memory")
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
