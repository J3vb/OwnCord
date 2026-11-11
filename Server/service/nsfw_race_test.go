package service

import (
	"context"
	"errors"
	"testing"
	"time"

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
	seedMemberRole(t, database, permissions.SendMessages|permissions.ReadMessages)
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

// TestNSFWAcknowledge_DuplicatePUTRacingARevokeNeverReportsNotLabelled is
// Codex round 2, P3 / round 4, item B: the old code answered "not labelled"
// from a SEPARATE read taken after an idempotent (rows-affected 0) insert,
// racing a concurrent revoke of the SAME row — a duplicate PUT could get
// ErrNotNSFW (409 NOT_NSFW at the API) while the channel was still, at that
// very moment, labelled. db.AcknowledgeNSFW now folds the label check and
// the insert into ONE writer transaction.
//
// Deterministic, no sleep: db.SetAcknowledgeNSFWTxRaceHookForTest fires
// INSIDE that transaction, between the label check and the insert, while
// the duplicate PUT holds the sole writer connection
// (writer.SetMaxOpenConns(1) in db.go). A concurrent RevokeNSFW attempted
// from there, on a short deadline, can only time out waiting for that
// connection — never interleave with the read+write it's racing. This is
// what an OLD, two-statement AcknowledgeNSFW cannot do: nothing holds the
// writer across its separate check and insert, so the SAME concurrent
// revoke would complete inside that gap instead of timing out (proved by
// temporarily reverting to the pre-round-2 shape; see the PR description).
func TestNSFWAcknowledge_DuplicatePUTRacingARevokeNeverReportsNotLabelled(t *testing.T) {
	ctx, database, nsfw, _ := newNSFWRaceFixture(t)
	labelChannel(t, database, 10, true)
	mustDo(t, "first Acknowledge", nsfw.Acknowledge(ctx, 1, 10))

	t.Cleanup(func() { db.AcknowledgeNSFWTxRaceHook = nil })
	var hookRan bool
	db.AcknowledgeNSFWTxRaceHook = func() {
		hookRan = true
		timeoutCtx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if err := database.RevokeNSFW(timeoutCtx, 1, 10); !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("concurrent RevokeNSFW while the writer transaction is open = %v, want context.DeadlineExceeded — "+
				"it must block behind the single writer connection, never interleave with the open transaction", err)
		}
	}

	if err := nsfw.Acknowledge(ctx, 1, 10); err != nil {
		t.Fatalf("duplicate Acknowledge racing a concurrent revoke = %v, want nil — "+
			"the channel is still labelled throughout, so this must never answer ErrNotNSFW", err)
	}
	if !hookRan {
		t.Fatal("acknowledgeNSFWTxRaceHook never fired — the test exercised nothing")
	}

	// The transaction committed and released the writer — the identical
	// call, without a deadline, must now succeed.
	mustDo(t, "RevokeNSFW after the transaction released the writer", database.RevokeNSFW(ctx, 1, 10))
}

// The caller's `existing` snapshot can be stale by the time an edit commits.
// An edit that leaves the label as its snapshot had it keeps whatever a
// concurrent edit stored, acknowledgements included; an edit that turns the
// label off clears the acknowledgements on the RESULTING flag, even when the
// snapshot's read was taken before a concurrent relabel and acknowledgement.
func TestAdminUpdateChannel_StaleUnlabelledSnapshotKeepsAConcurrentLabelAndItsAcks(t *testing.T) {
	ctx, database, nsfwSvc, channels := newNSFWRaceFixture(t)

	existing, err := database.GetChannel(ctx, 10)
	if err != nil || existing == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if existing.NSFW {
		t.Fatal("precondition: channel must start unlabelled")
	}

	// Another admin labels it and a member acknowledges it after the read.
	labelChannel(t, database, 10, true)
	mustDo(t, "Acknowledge", nsfwSvc.Acknowledge(ctx, 1, 10))

	// This edit never named the label (false, as its snapshot had it).
	if _, _, err := channels.AdminUpdateChannel(ctx, 1, existing, AdminChannelUpdate{
		Name: "general", NSFW: false,
	}, nil); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}

	now, err := database.GetChannel(ctx, 10)
	if err != nil || now == nil || !now.NSFW {
		t.Fatalf("label after the edit = %+v, %v, want the concurrent label kept", now, err)
	}
	if ok, hErr := database.HasNSFWAcknowledgement(ctx, 1, 10); hErr != nil || !ok {
		t.Fatalf("HasNSFWAcknowledgement after the edit = (%v, %v), want (true, nil): the label it belongs to is still on", ok, hErr)
	}
}

// assertEditLeavesNoAcks labels channel 10, takes the snapshot, acknowledges,
// runs interleave (a concurrent change landing after the snapshot), then runs
// the edit req through that snapshot and expects the row unlabelled with no
// acknowledgement left.
func assertEditLeavesNoAcks(t *testing.T, req AdminChannelUpdate, interleave func(database *db.DB, nsfwSvc *NSFWService)) {
	t.Helper()
	ctx, database, nsfwSvc, channels := newNSFWRaceFixture(t)
	labelChannel(t, database, 10, true)
	existing, err := database.GetChannel(ctx, 10)
	if err != nil || existing == nil || !existing.NSFW {
		t.Fatalf("GetChannel: %+v, %v", existing, err)
	}
	mustDo(t, "Acknowledge", nsfwSvc.Acknowledge(ctx, 1, 10))
	interleave(database, nsfwSvc)

	if _, _, err := channels.AdminUpdateChannel(ctx, 1, existing, req, nil); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
	now, err := database.GetChannel(ctx, 10)
	if err != nil || now == nil || now.NSFW {
		t.Fatalf("label after the edit = %+v, %v, want it off", now, err)
	}
	if ok, hErr := database.HasNSFWAcknowledgement(ctx, 1, 10); hErr != nil || ok {
		t.Fatalf("HasNSFWAcknowledgement after the edit = (%v, %v), want (false, nil)", ok, hErr)
	}
}

func TestAdminUpdateChannel_ClearsAcksWhenTheEditTurnsTheLabelOff(t *testing.T) {
	assertEditLeavesNoAcks(t, AdminChannelUpdate{Name: "general", NSFW: false},
		func(*db.DB, *NSFWService) {})
}

// The snapshot was read while labelled, then another admin unlabelled and
// relabelled the channel and a member acknowledged the new labelling.
func TestAdminUpdateChannel_StaleLabelledSnapshotClearsAcksFromALaterLabelling(t *testing.T) {
	assertEditLeavesNoAcks(t, AdminChannelUpdate{Name: "general", NSFW: false},
		func(database *db.DB, nsfwSvc *NSFWService) {
			labelChannel(t, database, 10, false)
			labelChannel(t, database, 10, true)
			mustDo(t, "Acknowledge again", nsfwSvc.Acknowledge(context.Background(), 1, 10))
		})
}

// An edit that never touched the label (it still says labelled, as its
// snapshot did) leaves no acknowledgement behind an unlabelled row either: the
// rule does not depend on which way the edit reached the flag. A raw unlabel
// leaves the acknowledgement behind for it to find.
func TestAdminUpdateChannel_PositionOnlyEditClearsAcksLeftOnAnUnlabelledRow(t *testing.T) {
	assertEditLeavesNoAcks(t, AdminChannelUpdate{Name: "general", NSFW: true, Position: 3},
		func(database *db.DB, _ *NSFWService) {
			labelChannel(t, database, 10, false)
		})
}
