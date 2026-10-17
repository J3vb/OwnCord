package db_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func contentOf(id int64) string { return fmt.Sprintf("added %d", id) }

func memberIDs(t *testing.T, database *db.DB, channelID int64) []int64 {
	t.Helper()
	ids, err := database.GetDMParticipantIDs(context.Background(), channelID)
	if err != nil {
		t.Fatalf("GetDMParticipantIDs: %v", err)
	}
	slices.Sort(ids)
	return ids
}

func assertOwnerIsMember(t *testing.T, database *db.DB, channelID int64) {
	t.Helper()
	owner := ownerOf(t, database, channelID)
	if members := memberIDs(t, database, channelID); !slices.Contains(members, owner) {
		t.Fatalf("dm_owner_id %d does not name a current member of %v", owner, members)
	}
}

// ─── Add ────────────────────────────────────────────────────────────────────

func TestAddGroupDMMembers_InsertsMembersRowsAndOpenState(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	erin := seedUser(t, f.database, "erin")

	change, err := f.database.AddGroupDMMembers(ctx, f.group, f.bob, []int64{dave, erin}, contentOf)
	if err != nil {
		t.Fatalf("AddGroupDMMembers: %v", err)
	}
	if want := []int64{f.alice, f.bob, f.carol, dave, erin}; !slices.Equal(change.MemberIDs, want) {
		t.Errorf("MemberIDs = %v, want %v", change.MemberIDs, want)
	}
	if len(change.Rows) != 2 {
		t.Fatalf("rows = %d, want one per added user", len(change.Rows))
	}
	for i, target := range []int64{dave, erin} {
		r := change.Rows[i]
		if r.Kind != db.MessageKindGroupAdd || r.AuthorID != f.bob || r.TargetUserID != target || r.Content != contentOf(target) || r.Timestamp == "" {
			t.Errorf("row %d = %+v, want a group_add by bob naming %d", i, r, target)
		}
		if got := count(t, f.database, `SELECT COUNT(*) FROM message_group_events WHERE message_id = ? AND target_user_id = ?`, r.MessageID, target); got != 1 {
			t.Errorf("row %d has no message_group_events detail", i)
		}
	}
	for _, uid := range []int64{dave, erin} {
		if got := count(t, f.database, `SELECT COUNT(*) FROM dm_open_state WHERE channel_id = ? AND user_id = ?`, f.group, uid); got != 1 {
			t.Errorf("user %d has no open state", uid)
		}
	}
	// The adder's own rows are not unread to them.
	if got := count(t, f.database, `SELECT COUNT(*) FROM read_states WHERE channel_id = ? AND user_id = ? AND last_message_id = ?`,
		f.group, f.bob, change.Rows[1].MessageID); got != 1 {
		t.Errorf("the actor's read state was not advanced to the last row")
	}
	assertOwnerIsMember(t, f.database, f.group)
}

func TestAddGroupDMMembers_SkipsExistingMembers(t *testing.T) {
	f := newGroupRowFixture(t)
	dave := seedUser(t, f.database, "dave")
	change, err := f.database.AddGroupDMMembers(context.Background(), f.group, f.alice, []int64{f.carol, dave, dave}, contentOf)
	if err != nil {
		t.Fatalf("AddGroupDMMembers: %v", err)
	}
	if len(change.Rows) != 1 || change.Rows[0].TargetUserID != dave {
		t.Errorf("rows = %+v, want exactly one row for dave", change.Rows)
	}
}

func TestAddGroupDMMembers_AllExistingIsRefused(t *testing.T) {
	f := newGroupRowFixture(t)
	_, err := f.database.AddGroupDMMembers(context.Background(), f.group, f.alice, []int64{f.bob, f.carol}, contentOf)
	if !errors.Is(err, db.ErrNoNewGroupMembers) {
		t.Fatalf("err = %v, want ErrNoNewGroupMembers", err)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group); got != 0 {
		t.Errorf("a refused add wrote %d rows", got)
	}
}

func TestAddGroupDMMembers_NonMemberAndOneToOneRefused(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	if _, err := f.database.AddGroupDMMembers(ctx, f.group, dave, []int64{dave}, contentOf); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("non-member add err = %v, want ErrNotFound", err)
	}
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, f.alice, f.bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if _, err := f.database.AddGroupDMMembers(ctx, dm.ID, f.alice, []int64{dave}, contentOf); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("1:1 add err = %v, want ErrNotFound", err)
	}
}

// Edge case 1: two callers racing on one slot. The cap is counted inside the
// transaction, so exactly one of twenty concurrent single adds into a group of
// nine wins and the other nineteen get ErrGroupDMFull.
func TestAddGroupDMMembers_CapCountsInsideTx(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	members := make([]int64, 0, db.MaxGroupDMParticipants-1)
	for i := range db.MaxGroupDMParticipants - 1 {
		members = append(members, seedUser(t, database, fmt.Sprintf("m%d", i)))
	}
	ch, err := database.CreateGroupDMChannel(ctx, "Full soon", members[0], members)
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	const racers = 20
	candidates := make([]int64, racers)
	for i := range candidates {
		candidates[i] = seedUser(t, database, fmt.Sprintf("c%d", i))
	}

	var wg sync.WaitGroup
	errs := make([]error, racers)
	for i := range racers {
		wg.Go(func() {
			_, errs[i] = database.AddGroupDMMembers(ctx, ch.ID, members[0], []int64{candidates[i]}, contentOf)
		})
	}
	wg.Wait()

	wins, full := 0, 0
	for _, e := range errs {
		switch {
		case e == nil:
			wins++
		case errors.Is(e, db.ErrGroupDMFull):
			full++
		default:
			t.Errorf("unexpected error: %v", e)
		}
	}
	if wins != 1 || full != racers-1 {
		t.Fatalf("wins = %d, full = %d, want 1 and %d", wins, full, racers-1)
	}
	if got := len(memberIDs(t, database, ch.ID)); got != db.MaxGroupDMParticipants {
		t.Errorf("members = %d, want %d", got, db.MaxGroupDMParticipants)
	}
	if got := count(t, database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind = 2`, ch.ID); got != 1 {
		t.Errorf("group_add rows = %d, want 1 (a refused add writes none)", got)
	}
}

func TestAddGroupDMMembers_OverCapInOneCallWritesNothing(t *testing.T) {
	f := newGroupRowFixture(t)
	ids := make([]int64, 0, db.MaxGroupDMParticipants)
	for i := range db.MaxGroupDMParticipants {
		ids = append(ids, seedUser(t, f.database, fmt.Sprintf("x%d", i)))
	}
	_, err := f.database.AddGroupDMMembers(context.Background(), f.group, f.alice, ids[:db.MaxGroupDMParticipants-2], contentOf)
	if !errors.Is(err, db.ErrGroupDMFull) {
		t.Fatalf("err = %v, want ErrGroupDMFull", err)
	}
	if got := len(memberIDs(t, f.database, f.group)); got != 3 {
		t.Errorf("members = %d after a refused add, want 3", got)
	}
}

// ─── Remove ─────────────────────────────────────────────────────────────────

func TestRemoveGroupDMMember_OwnerOnly(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.bob, f.carol, "x"); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("non-owner remove err = %v, want ErrForbidden", err)
	}
	outsider := seedUser(t, f.database, "outsider")
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, outsider, f.carol, "x"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("non-member remove err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, outsider, "x"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("remove of a non-member err = %v, want ErrNotFound", err)
	}
	if got := len(memberIDs(t, f.database, f.group)); got != 3 {
		t.Errorf("members = %d after refused removes, want 3", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group); got != 0 {
		t.Errorf("refused removes wrote %d rows", got)
	}

	change, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.carol, "alice removed carol")
	if err != nil {
		t.Fatalf("owner remove: %v", err)
	}
	if want := []int64{f.alice, f.bob}; !slices.Equal(change.MemberIDs, want) {
		t.Errorf("MemberIDs = %v, want %v", change.MemberIDs, want)
	}
	if len(change.Rows) != 1 || change.Rows[0].Kind != db.MessageKindGroupRemove || change.Rows[0].AuthorID != f.alice || change.Rows[0].TargetUserID != f.carol {
		t.Errorf("rows = %+v, want one group_remove by alice naming carol", change.Rows)
	}
}

func TestRemoveGroupDMMember_SelfRefused(t *testing.T) {
	f := newGroupRowFixture(t)
	if _, err := f.database.RemoveGroupDMMember(context.Background(), f.group, f.alice, f.alice, "x"); !errors.Is(err, db.ErrForbidden) {
		t.Fatalf("self remove err = %v, want ErrForbidden", err)
	}
	if got := len(memberIDs(t, f.database, f.group)); got != 3 {
		t.Errorf("members = %d, want 3", got)
	}
}

func TestRemoveGroupDMMember_DeletesReadStateAndOpenState(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, 5)`, f.carol, f.group); err != nil {
		t.Fatalf("seed read state: %v", err)
	}
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.carol, "x"); err != nil {
		t.Fatalf("RemoveGroupDMMember: %v", err)
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM read_states WHERE channel_id = ? AND user_id = ?`,
		`SELECT COUNT(*) FROM dm_open_state WHERE channel_id = ? AND user_id = ?`,
		`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ? AND user_id = ?`,
	} {
		if got := count(t, f.database, q, f.group, f.carol); got != 0 {
			t.Errorf("%s = %d, want 0", q, got)
		}
	}
}

// Edge case 1, second half: an owner's remove racing the target's own leave
// yields exactly one row, "left" or "removed", never both.
func TestRemoveGroupDMMember_RacingLeaveGivesOneRow(t *testing.T) {
	for i := range 25 {
		f := newGroupRowFixture(t)
		ctx := context.Background()
		var wg sync.WaitGroup
		var removeErr, leaveErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, removeErr = f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.carol, "removed")
		}()
		go func() {
			defer wg.Done()
			_, leaveErr = f.database.LeaveGroupDM(ctx, f.carol, f.group, "left")
		}()
		wg.Wait()

		if (removeErr == nil) == (leaveErr == nil) {
			t.Fatalf("run %d: remove err %v, leave err %v: exactly one must succeed", i, removeErr, leaveErr)
		}
		if loser := errors.Join(removeErr, leaveErr); !errors.Is(loser, db.ErrNotFound) {
			t.Fatalf("run %d: the loser got %v, want ErrNotFound", i, loser)
		}
		if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind IN (3, 4)`, f.group); got != 1 {
			t.Fatalf("run %d: %d remove/leave rows, want exactly 1", i, got)
		}
	}
}

// Edge case 2: the owner is removed or leaves while a transfer to them is in
// flight. dm_owner_id names a current member whichever order the writer runs
// them in.
func TestRemoveVsOwnerLeave_HandOffWins(t *testing.T) {
	for range 25 {
		f := newGroupRowFixture(t)
		ctx := context.Background()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.bob, "removed") //nolint:errcheck // either order is legal
		}()
		go func() {
			defer wg.Done()
			_, _ = f.database.LeaveGroupDM(ctx, f.alice, f.group, "left") //nolint:errcheck // either order is legal
		}()
		wg.Wait()
		assertOwnerIsMember(t, f.database, f.group)
	}

	// Deterministic order: the leave commits first, the hand-off moves
	// ownership, and the old owner's remove fails its owner check.
	f := newGroupRowFixture(t)
	ctx := context.Background()
	if _, err := f.database.LeaveGroupDM(ctx, f.alice, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.bob, "removed"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("remove by the departed owner err = %v, want ErrNotFound", err)
	}
	if got := len(memberIDs(t, f.database, f.group)); got != 2 {
		t.Errorf("members = %d, want 2", got)
	}
	assertOwnerIsMember(t, f.database, f.group)
}

func TestTransferGroupDMOwner_RacingDeparturesKeepAMemberOwner(t *testing.T) {
	for i := range 25 {
		f := newGroupRowFixture(t)
		ctx := context.Background()
		var wg sync.WaitGroup
		wg.Add(3)
		go func() {
			defer wg.Done()
			_, _ = f.database.TransferGroupDMOwner(ctx, f.group, f.alice, f.bob) //nolint:errcheck // either order is legal
		}()
		go func() {
			defer wg.Done()
			_, _ = f.database.LeaveGroupDM(ctx, f.bob, f.group, "left") //nolint:errcheck // either order is legal
		}()
		go func() {
			defer wg.Done()
			_, _ = f.database.LeaveGroupDM(ctx, f.alice, f.group, "left") //nolint:errcheck // either order is legal
		}()
		wg.Wait()
		if len(memberIDs(t, f.database, f.group)) == 0 {
			t.Fatalf("run %d: the group vanished with a member left", i)
		}
		assertOwnerIsMember(t, f.database, f.group)
	}
}

// ─── Transfer ───────────────────────────────────────────────────────────────

func TestTransferGroupDMOwner_OwnerOnlyAndTargetMustBeMember(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	outsider := seedUser(t, f.database, "outsider")

	if _, err := f.database.TransferGroupDMOwner(ctx, f.group, f.bob, f.carol); !errors.Is(err, db.ErrForbidden) {
		t.Errorf("non-owner transfer err = %v, want ErrForbidden", err)
	}
	if _, err := f.database.TransferGroupDMOwner(ctx, f.group, outsider, f.carol); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("non-member transfer err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.TransferGroupDMOwner(ctx, f.group, f.alice, outsider); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("transfer to a non-member err = %v, want ErrNotFound", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.alice {
		t.Fatalf("owner = %d after refused transfers, want alice", got)
	}

	members, err := f.database.TransferGroupDMOwner(ctx, f.group, f.alice, f.carol)
	if err != nil {
		t.Fatalf("TransferGroupDMOwner: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.carol {
		t.Errorf("owner = %d, want carol", got)
	}
	if want := []int64{f.alice, f.bob, f.carol}; !slices.Equal(members, want) {
		t.Errorf("members = %v, want %v", members, want)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group); got != 0 {
		t.Errorf("a transfer wrote %d rows, want none", got)
	}
	// The former owner has no owner powers any more.
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.bob, "x"); !errors.Is(err, db.ErrForbidden) {
		t.Errorf("former owner remove err = %v, want ErrForbidden", err)
	}
}

// ─── Rename ─────────────────────────────────────────────────────────────────

func TestSetGroupDMName_WritesRow(t *testing.T) {
	f := newGroupRowFixture(t)
	change, err := f.database.SetGroupDMName(context.Background(), f.group, f.bob, "Raid night", "bob renamed it")
	if err != nil {
		t.Fatalf("SetGroupDMName: %v", err)
	}
	if len(change.Rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(change.Rows))
	}
	r := change.Rows[0]
	if r.Kind != db.MessageKindGroupRename || r.AuthorID != f.bob || r.Name == nil || *r.Name != "Raid night" || r.Content != "bob renamed it" {
		t.Errorf("row = %+v", r)
	}
	var name string
	if err := f.database.QueryRowContext(context.Background(), `SELECT name FROM channels WHERE id = ?`, f.group).Scan(&name); err != nil || name != "Raid night" {
		t.Errorf("channel name = %q (%v)", name, err)
	}
	if want := []int64{f.alice, f.bob, f.carol}; !slices.Equal(change.MemberIDs, want) {
		t.Errorf("MemberIDs = %v, want %v", change.MemberIDs, want)
	}
}

func TestSetGroupDMName_UnchangedNameNoRow(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	change, err := f.database.SetGroupDMName(ctx, f.group, f.bob, "Crew", "same")
	if err != nil {
		t.Fatalf("SetGroupDMName: %v", err)
	}
	if len(change.Rows) != 0 {
		t.Errorf("an unchanged name wrote rows: %+v", change.Rows)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group); got != 0 {
		t.Errorf("rows in the channel = %d, want 0", got)
	}
}

func TestSetGroupDMName_ClearWritesEmptyName(t *testing.T) {
	f := newGroupRowFixture(t)
	change, err := f.database.SetGroupDMName(context.Background(), f.group, f.alice, "", "alice cleared it")
	if err != nil {
		t.Fatalf("SetGroupDMName: %v", err)
	}
	if len(change.Rows) != 1 || change.Rows[0].Name == nil || *change.Rows[0].Name != "" {
		t.Fatalf("rows = %+v, want one rename row with an empty name", change.Rows)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_group_events WHERE message_id = ? AND name = ''`, change.Rows[0].MessageID); got != 1 {
		t.Errorf("the empty name was not stored as ''")
	}
}

func TestSetGroupDMName_NonMemberRefused(t *testing.T) {
	f := newGroupRowFixture(t)
	outsider := seedUser(t, f.database, "outsider")
	if _, err := f.database.SetGroupDMName(context.Background(), f.group, outsider, "x", "y"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// ─── Leave ──────────────────────────────────────────────────────────────────

func TestLeaveGroupDM_WritesLeaveRowAndDeletesReadState(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, 5, 2)`, f.bob, f.group); err != nil {
		t.Fatalf("seed read state: %v", err)
	}
	res, err := f.database.LeaveGroupDM(ctx, f.bob, f.group, "bob left")
	if err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if res.Deleted || res.Row == nil || res.Row.Kind != db.MessageKindGroupLeave || res.Row.AuthorID != f.bob || res.Row.Content != "bob left" {
		t.Fatalf("result = %+v", res)
	}
	if want := []int64{f.alice, f.carol}; !slices.Equal(res.MemberIDs, want) {
		t.Errorf("MemberIDs = %v, want %v", res.MemberIDs, want)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM read_states WHERE channel_id = ? AND user_id = ?`, f.group, f.bob); got != 0 {
		t.Errorf("the leaver's read state survived")
	}
}

func TestLeaveGroupDM_NonMemberGetsNotFoundAndNoRow(t *testing.T) {
	f := newGroupRowFixture(t)
	outsider := seedUser(t, f.database, "outsider")
	if _, err := f.database.LeaveGroupDM(context.Background(), outsider, f.group, "x"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind <> 0`, f.group); got != 0 {
		t.Errorf("a refused leave wrote %d rows", got)
	}
}

func TestLeaveGroupDM_LastLeaverWritesNoRow(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	for _, uid := range []int64{f.alice, f.bob} {
		if _, err := f.database.LeaveGroupDM(ctx, uid, f.group, "left"); err != nil {
			t.Fatalf("LeaveGroupDM: %v", err)
		}
	}
	res, err := f.database.LeaveGroupDM(ctx, f.carol, f.group, "left")
	if err != nil || !res.Deleted || res.Row != nil {
		t.Fatalf("last leave = %+v, %v, want Deleted and no row", res, err)
	}
}

// ─── Owner hand-off skips banned members ────────────────────────────────────

func banUser(t *testing.T, database *db.DB, id int64, expires *time.Time) {
	t.Helper()
	if err := database.BanUser(context.Background(), id, "test", expires); err != nil {
		t.Fatalf("BanUser: %v", err)
	}
}

func TestLeaveGroupDM_HandOffSkipsBannedMember(t *testing.T) {
	f := newGroupRowFixture(t)
	banUser(t, f.database, f.bob, nil)
	if _, err := f.database.LeaveGroupDM(context.Background(), f.alice, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.carol {
		t.Errorf("owner = %d, want carol (bob is banned from the server)", got)
	}
}

func TestLeaveGroupDM_HandOffCountsLapsedBanAsMember(t *testing.T) {
	f := newGroupRowFixture(t)
	lapsed := time.Now().UTC().Add(-time.Hour)
	banUser(t, f.database, f.bob, &lapsed)
	if _, err := f.database.LeaveGroupDM(context.Background(), f.alice, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.bob {
		t.Errorf("owner = %d, want bob (his temporary ban has lapsed)", got)
	}
}

func TestLeaveGroupDM_HandOffFallsBackWhenEveryoneLeftIsBanned(t *testing.T) {
	f := newGroupRowFixture(t)
	banUser(t, f.database, f.bob, nil)
	banUser(t, f.database, f.carol, nil)
	if _, err := f.database.LeaveGroupDM(context.Background(), f.alice, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.bob {
		t.Errorf("owner = %d, want bob: the owner must name a member even when all are banned", got)
	}
	assertOwnerIsMember(t, f.database, f.group)
}

func TestEraseAccount_HandOffSkipsBannedMember(t *testing.T) {
	f := newGroupRowFixture(t)
	banUser(t, f.database, f.bob, nil)
	if _, err := f.database.EraseAccount(context.Background(), f.alice, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.carol {
		t.Errorf("owner = %d, want carol (bob is banned from the server)", got)
	}
	assertOwnerIsMember(t, f.database, f.group)
}
