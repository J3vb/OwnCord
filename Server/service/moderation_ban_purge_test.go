package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const (
	// fixtureBanOnlyMod holds BAN_MEMBERS and READ_MESSAGES but not
	// MANAGE_MESSAGES.
	fixtureBanOnlyMod = int64(6)
	// fixtureManageOnly holds MANAGE_MESSAGES and READ_MESSAGES but not
	// BAN_MEMBERS.
	fixtureManageOnly = int64(7)
)

// banPurgeFixture is the moderation fixture plus two extra moderators, one
// missing MANAGE_MESSAGES and one missing BAN_MEMBERS. The target is member2
// (rank 40, below the mods at 80).
func banPurgeFixture(t *testing.T) *moderationActionsFixture {
	t.Helper()
	f := newModerationActionsFixture(t)
	seedRole(t, f.database, &db.Role{ID: 6, Name: "banonly", Permissions: permissions.BanMembers | permissions.ReadMessages, Position: 80})
	seedRole(t, f.database, &db.Role{ID: 7, Name: "manageonly", Permissions: permissions.ManageMessages | permissions.ReadMessages, Position: 80})
	seedUserRole(t, f.database, fixtureBanOnlyMod, 6)
	seedUserRole(t, f.database, fixtureManageOnly, 7)
	return f
}

// banPurgeMsg inserts a message by userID in channelID stamped age ago.
func banPurgeMsg(t *testing.T, database *db.DB, channelID, userID int64, age time.Duration) int64 {
	t.Helper()
	ctx := context.Background()
	id, err := database.CreateMessage(ctx, channelID, userID, "m", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	ts := time.Now().UTC().Add(-age).Format(dbtime.SQLiteLayout)
	if _, err := database.ExecContext(ctx, `UPDATE messages SET timestamp = ? WHERE id = ?`, ts, id); err != nil {
		t.Fatalf("stamp message: %v", err)
	}
	return id
}

func banPurgeBan(t *testing.T, f *moderationActionsFixture, target int64) {
	t.Helper()
	if _, err := f.database.BanUserWithAction(context.Background(), target, "x", nil, fixtureOwner, nil); err != nil {
		t.Fatalf("BanUserWithAction: %v", err)
	}
}

func banPurgeDeleted(t *testing.T, database *db.DB, id int64) bool {
	t.Helper()
	deleted, found, err := database.IsMessageDeleted(context.Background(), id)
	if err != nil || !found {
		t.Fatalf("IsMessageDeleted(%d) = %v, %v, %v", id, deleted, found, err)
	}
	return deleted
}

func banPurgeCount(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func banPurgeRows(t *testing.T, database *db.DB) (removals, audits int) {
	t.Helper()
	removals = banPurgeCount(t, database, `SELECT COUNT(*) FROM moderation_actions WHERE kind = 'removal'`)
	audits = banPurgeCount(t, database, `SELECT COUNT(*) FROM audit_log WHERE action = 'user_ban_purge'`)
	return removals, audits
}

func TestAuthorizeBanPurge_RequiresBanMembers(t *testing.T) {
	f := banPurgeFixture(t)
	if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureManageOnly, fixtureMember2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("AuthorizeBanPurge without BAN_MEMBERS = %v, want ErrForbidden", err)
	}
	if removals, audits := banPurgeRows(t, f.database); removals+audits != 0 {
		t.Errorf("a refused authorization wrote %d ledger and %d audit rows", removals, audits)
	}
}

func TestAuthorizeBanPurge_RequiresManageMessages(t *testing.T) {
	f := banPurgeFixture(t)
	if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureBanOnlyMod, fixtureMember2); !errors.Is(err, ErrForbidden) {
		t.Fatalf("AuthorizeBanPurge without MANAGE_MESSAGES = %v, want ErrForbidden", err)
	}
	if removals, audits := banPurgeRows(t, f.database); removals+audits != 0 {
		t.Errorf("a refused authorization wrote %d ledger and %d audit rows", removals, audits)
	}
	// Authority is checked before existence: no user-id enumeration.
	if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureBanOnlyMod, 9999); !errors.Is(err, ErrForbidden) {
		t.Errorf("unauthorized actor, missing target = %v, want ErrForbidden", err)
	}
	if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureMod, 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("authorized actor, missing target = %v, want ErrNotFound", err)
	}
	if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureMod, fixtureMember2); err != nil {
		t.Errorf("authorized actor and target = %v, want nil", err)
	}
}

func TestAuthorizeBanPurge_EqualRankRefused(t *testing.T) {
	f := banPurgeFixture(t)
	for _, target := range []int64{fixturePeerMod, fixtureOwner} {
		if err := f.mod.AuthorizeBanPurge(context.Background(), fixtureMod, target); !errors.Is(err, ErrForbidden) {
			t.Errorf("AuthorizeBanPurge(mod -> %d) = %v, want ErrForbidden", target, err)
		}
	}
}

func TestAuthorizeBanPurge_RateLimited(t *testing.T) {
	f := banPurgeFixture(t)
	f.mod.limiter = auth.NewRateLimiter()
	ctx := context.Background()
	if err := f.mod.AuthorizeBanPurge(ctx, fixtureMod, fixtureMember2); err != nil {
		t.Fatalf("first AuthorizeBanPurge = %v", err)
	}
	if err := f.mod.AuthorizeBanPurge(ctx, fixtureMod, fixtureMember2); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("second AuthorizeBanPurge within the window = %v, want ErrRateLimited", err)
	}
	// The limit is per actor.
	if err := f.mod.AuthorizeBanPurge(ctx, fixtureOwner, fixtureMember2); err != nil {
		t.Errorf("another actor = %v, want nil", err)
	}
}

func TestPurgeAfterBan_RequiresTargetBanned(t *testing.T) {
	f := banPurgeFixture(t)
	id := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if !errors.Is(res.Err, ErrBadRequest) || res.Deleted != 0 || len(res.Batches) != 0 {
		t.Fatalf("PurgeAfterBan on an unbanned target = %+v, want ErrBadRequest and nothing deleted", res)
	}
	if banPurgeDeleted(t, f.database, id) {
		t.Error("a message of an unbanned target was deleted")
	}
}

func TestPurgeAfterBan_RejectsNonHumanActor(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	id := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)

	for _, actor := range []int64{0, -1} {
		res := f.mod.PurgeAfterBan(context.Background(), actor, fixtureMember2, time.Hour)
		if !errors.Is(res.Err, ErrForbidden) || res.Deleted != 0 {
			t.Errorf("PurgeAfterBan(actor=%d) = %+v, want ErrForbidden", actor, res)
		}
	}
	if banPurgeDeleted(t, f.database, id) {
		t.Error("a non-human actor deleted a message")
	}
}

func TestPurgeAfterBan_RechecksAuthority(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	id := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)

	for name, actor := range map[string]int64{"no MANAGE_MESSAGES": fixtureBanOnlyMod, "no BAN_MEMBERS": fixtureManageOnly} {
		res := f.mod.PurgeAfterBan(context.Background(), actor, fixtureMember2, time.Hour)
		if !errors.Is(res.Err, ErrForbidden) {
			t.Errorf("%s: PurgeAfterBan = %+v, want ErrForbidden", name, res)
		}
	}
	for _, window := range []time.Duration{0, -time.Hour, banPurgeMaxWindow + time.Second} {
		res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, window)
		if !errors.Is(res.Err, ErrBadRequest) {
			t.Errorf("window %v: PurgeAfterBan = %+v, want ErrBadRequest", window, res)
		}
	}
	if banPurgeDeleted(t, f.database, id) {
		t.Error("a refused purge deleted a message")
	}
}

func TestPurgeAfterBan_PermissionLookupErrorSkipsChannel(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	id := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)

	// The message service resolves channel permissions through a store whose
	// override read fails; the moderation service's own checks are unaffected.
	failing := &overrideFailStore{Store: f.database}
	f.mod.messages = NewMessageService(f.database, NewPermissionService(failing, permissions.NewChecker(f.database)), nil)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || res.Deleted != 0 || !res.Complete {
		t.Fatalf("PurgeAfterBan = %+v, want a complete purge that skipped the channel", res)
	}
	if banPurgeDeleted(t, f.database, id) {
		t.Error("a channel whose permission lookup failed was purged")
	}
}

type overrideFailStore struct{ Store }

func (overrideFailStore) GetMemberGrants(context.Context, int64) (permissions.MemberGrants, error) {
	return permissions.MemberGrants{}, errors.New("override read failed")
}

func TestPurgeAfterBan_ChannelWithoutManageMessagesUntouched(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	ctx := context.Background()

	open := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	noManage := seedChannelID(t, f.database, 101, "no-manage")
	noRead := seedChannelID(t, f.database, 102, "no-read")
	seedChannelOverride(t, f.database, 2, noManage, 0, permissions.ManageMessages)
	seedChannelOverride(t, f.database, 2, noRead, 0, permissions.ReadMessages)
	keepManage := banPurgeMsg(t, f.database, noManage, fixtureMember2, time.Minute)
	keepRead := banPurgeMsg(t, f.database, noRead, fixtureMember2, time.Minute)

	res := f.mod.PurgeAfterBan(ctx, fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || !res.Complete || res.Deleted != 1 {
		t.Fatalf("PurgeAfterBan = %+v, want one deleted, complete", res)
	}
	if !banPurgeDeleted(t, f.database, open) {
		t.Error("the open channel's message was not deleted")
	}
	if banPurgeDeleted(t, f.database, keepManage) || banPurgeDeleted(t, f.database, keepRead) {
		t.Error("a channel the actor cannot read and manage was purged")
	}
}

func seedChannelID(t *testing.T, database *db.DB, id int64, name string) int64 {
	t.Helper()
	seedChannel(t, database, &db.Channel{ID: id, Name: name, Type: "text"})
	return id
}

func TestPurgeAfterBan_AdministratorCoversAllChannels(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	other := seedChannelID(t, f.database, 101, "second")
	seedChannelOverride(t, f.database, 2, other, 0, permissions.ManageMessages)
	a := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	b := banPurgeMsg(t, f.database, other, fixtureMember2, time.Minute)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureOwner, fixtureMember2, time.Hour)
	if res.Err != nil || !res.Complete || res.Deleted != 2 || len(res.Batches) != 2 {
		t.Fatalf("PurgeAfterBan = %+v, want two batches, two deleted", res)
	}
	if !banPurgeDeleted(t, f.database, a) || !banPurgeDeleted(t, f.database, b) {
		t.Error("an administrator's purge missed a channel")
	}
}

func TestPurgeAfterBan_DMsUntouched(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	dm := seedChannelID(t, f.database, 101, "dm-one")
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET type = 'dm' WHERE id = ?`, dm); err != nil {
		t.Fatalf("mark dm: %v", err)
	}
	inDM := banPurgeMsg(t, f.database, dm, fixtureMember2, time.Minute)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureOwner, fixtureMember2, time.Hour)
	if res.Err != nil || res.Deleted != 0 || !res.Complete {
		t.Fatalf("PurgeAfterBan = %+v, want nothing deleted", res)
	}
	if banPurgeDeleted(t, f.database, inDM) {
		t.Error("a direct message was purged")
	}
	if removals, audits := banPurgeRows(t, f.database); removals+audits != 0 {
		t.Errorf("an empty purge wrote %d ledger and %d audit rows", removals, audits)
	}
}

func TestPurgeAfterBan_WindowBoundary(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	// Seeded in ascending timestamp order: the floor search needs ids
	// monotonic with timestamps.
	outside := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, 90*time.Minute)
	inside := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, 30*time.Minute)
	newest := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, 0)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || res.Deleted != 2 {
		t.Fatalf("PurgeAfterBan = %+v, want two deleted", res)
	}
	if !banPurgeDeleted(t, f.database, inside) || !banPurgeDeleted(t, f.database, newest) {
		t.Error("a message inside the window was kept")
	}
	if banPurgeDeleted(t, f.database, outside) {
		t.Error("a message outside the window was deleted")
	}
}

func TestPurgeAfterBan_CapReportsIncomplete(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	f.mod.banPurgeRowCap = 3
	for range 5 {
		banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	}

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || res.Complete || res.Deleted != 3 {
		t.Fatalf("PurgeAfterBan = %+v, want 3 deleted and incomplete", res)
	}
	// Running it again continues where it stopped.
	res = f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || !res.Complete || res.Deleted != 2 {
		t.Fatalf("second PurgeAfterBan = %+v, want the remaining 2, complete", res)
	}
}

// cancelAfterFirstBatchStore cancels the purge's context once its first batch
// has committed.
type cancelAfterFirstBatchStore struct {
	Store
	cancel context.CancelFunc
}

func (s *cancelAfterFirstBatchStore) PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error) {
	ids, err := s.Store.PurgeUserChannelMessagesSince(ctx, channelID, userID, since, limit)
	s.cancel()
	return ids, err
}

func TestPurgeAfterBan_ContextCancelReturnsCommittedBatches(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	for range 150 {
		banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.mod.messages = NewMessageService(&cancelAfterFirstBatchStore{Store: f.database, cancel: cancel}, f.mod.perms, nil)

	res := f.mod.PurgeAfterBan(ctx, fixtureMod, fixtureMember2, time.Hour)
	if !errors.Is(res.Err, context.Canceled) || res.Complete {
		t.Fatalf("PurgeAfterBan = %+v, want a canceled, incomplete purge", res)
	}
	if res.Deleted != 100 || len(res.Batches) != 1 || len(res.Batches[0].MessageIDs) != 100 {
		t.Fatalf("committed batches = %+v (deleted %d), want the one batch of 100", res.Batches, res.Deleted)
	}
	// The records follow the committed count, and survive the canceled context.
	var reason string
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT reason FROM moderation_actions WHERE kind = 'removal' AND target_id = ?`, fixtureMember2).Scan(&reason); err != nil {
		t.Fatalf("ledger row: %v", err)
	}
	if reason != "100 messages removed with ban" {
		t.Errorf("ledger reason = %q, want the committed count", reason)
	}
}

func TestPurgeAfterBan_ReversesMentionBadges(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	ctx := context.Background()

	before := banPurgeMsg(t, f.database, fixtureChannel, fixtureOwner, time.Minute)
	if _, err := f.database.ReplaceMessageMentions(ctx, before, []int64{fixtureMember}, false, nil); err != nil {
		t.Fatalf("ReplaceMessageMentions(before): %v", err)
	}
	if err := f.database.IncrementMentionCounts(ctx, fixtureChannel, before, []int64{fixtureMember}); err != nil {
		t.Fatalf("IncrementMentionCounts(before): %v", err)
	}
	spam := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	if _, err := f.database.ReplaceMessageMentions(ctx, spam, []int64{fixtureMember}, false, nil); err != nil {
		t.Fatalf("ReplaceMessageMentions(spam): %v", err)
	}
	if err := f.database.IncrementMentionCounts(ctx, fixtureChannel, spam, []int64{fixtureMember}); err != nil {
		t.Fatalf("IncrementMentionCounts(spam): %v", err)
	}
	mentions := func() int {
		t.Helper()
		counts, err := f.database.GetChannelUnreadCounts(ctx, fixtureMember)
		if err != nil {
			t.Fatalf("GetChannelUnreadCounts: %v", err)
		}
		return counts[fixtureChannel].MentionCount
	}
	if got := mentions(); got != 2 {
		t.Fatalf("mention_count before the purge = %d, want 2", got)
	}

	res := f.mod.PurgeAfterBan(ctx, fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || res.Deleted != 1 {
		t.Fatalf("PurgeAfterBan = %+v, want one deleted", res)
	}
	if got := mentions(); got != 1 {
		t.Errorf("mention_count after the purge = %d, want 1 (the value before the purged message)", got)
	}
}

// failSecondBatchStore lets the first purge batch through and fails the
// second with a plain error.
type failSecondBatchStore struct {
	Store
	calls int
}

func (s *failSecondBatchStore) PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error) {
	s.calls++
	if s.calls > 1 {
		return nil, errors.New("disk I/O error")
	}
	return s.Store.PurgeUserChannelMessagesSince(ctx, channelID, userID, since, limit)
}

func TestPurgeAfterBan_StoreErrorAfterFirstBatch(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	for range 150 {
		banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	}
	f.mod.messages = NewMessageService(&failSecondBatchStore{Store: f.database}, f.mod.perms, nil)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if !errors.Is(res.Err, ErrInternal) || res.Complete {
		t.Fatalf("PurgeAfterBan = %+v, want an internal-error, incomplete purge", res)
	}
	if res.Deleted != 100 || len(res.Batches) != 1 {
		t.Fatalf("committed batches = %+v (deleted %d), want the one batch of 100", res.Batches, res.Deleted)
	}
	var reason string
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT reason FROM moderation_actions WHERE kind = 'removal' AND target_id = ?`, fixtureMember2).Scan(&reason); err != nil {
		t.Fatalf("ledger row: %v", err)
	}
	if reason != "100 messages removed with ban" {
		t.Errorf("ledger reason = %q, want the committed count", reason)
	}
}

func TestPurgeAfterBan_OneLedgerRowAndOneAuditRow(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	other := seedChannelID(t, f.database, 101, "second")
	for range 3 {
		banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	}
	banPurgeMsg(t, f.database, other, fixtureMember2, time.Minute)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureOwner, fixtureMember2, 2*time.Hour)
	if res.Err != nil || res.Deleted != 4 {
		t.Fatalf("PurgeAfterBan = %+v, want 4 deleted", res)
	}
	if removals, audits := banPurgeRows(t, f.database); removals != 1 || audits != 1 {
		t.Fatalf("rows = %d removal, %d audit; want one of each", removals, audits)
	}
	var actor int64
	var reason string
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT actor_id, reason FROM moderation_actions WHERE kind = 'removal' AND target_id = ?`, fixtureMember2).Scan(&actor, &reason); err != nil {
		t.Fatalf("ledger row: %v", err)
	}
	if actor != fixtureOwner || reason != "4 messages removed with ban" {
		t.Errorf("ledger row = actor %d reason %q", actor, reason)
	}
	var detail string
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT detail FROM audit_log WHERE action = 'user_ban_purge' AND target_id = ?`, fixtureMember2).Scan(&detail); err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if detail != "deleted 4 messages from the last 7200 seconds" {
		t.Errorf("audit detail = %q", detail)
	}
}

func TestPurgeAfterBan_NothingDeletedWritesNeither(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, 48*time.Hour)

	res := f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour)
	if res.Err != nil || res.Deleted != 0 || !res.Complete || len(res.Batches) != 0 {
		t.Fatalf("PurgeAfterBan = %+v, want an empty, complete purge", res)
	}
	if removals, audits := banPurgeRows(t, f.database); removals+audits != 0 {
		t.Errorf("an empty purge wrote %d ledger and %d audit rows", removals, audits)
	}
}

func TestPurgeAfterBan_ConcurrentPurgesDoNotDoubleCount(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	const rows = 250
	all := make([]int64, 0, rows)
	for range rows {
		all = append(all, banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute))
	}

	actors := []int64{fixtureMod, fixtureOwner}
	results := make([]BanPurgeResult, len(actors))
	var wg sync.WaitGroup
	for i, actor := range actors {
		wg.Go(func() {
			results[i] = f.mod.PurgeAfterBan(context.Background(), actor, fixtureMember2, time.Hour)
		})
	}
	wg.Wait()

	total := 0
	var seen []int64
	for _, r := range results {
		if r.Err != nil || !r.Complete {
			t.Fatalf("PurgeAfterBan = %+v, want a complete purge", r)
		}
		total += r.Deleted
		for _, b := range r.Batches {
			seen = append(seen, b.MessageIDs...)
		}
	}
	slices.Sort(seen)
	slices.Sort(all)
	if total != rows || !slices.Equal(seen, all) {
		t.Fatalf("total deleted = %d (%d distinct ids), want each of the %d rows counted once", total, len(slices.Compact(seen)), rows)
	}
}

func TestPurgeAfterBan_SemaphoreWaitHonoursContext(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	f.mod.banPurgeSem <- struct{}{}
	defer func() { <-f.mod.banPurgeSem }()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	res := f.mod.PurgeAfterBan(ctx, fixtureMod, fixtureMember2, time.Hour)
	if !errors.Is(res.Err, context.DeadlineExceeded) || res.Deleted != 0 {
		t.Fatalf("PurgeAfterBan behind a held semaphore = %+v, want the context error", res)
	}
}

func TestPurgeAfterBan_ChecksAfterSemaphoreWait(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	id := banPurgeMsg(t, f.database, fixtureChannel, fixtureMember2, time.Minute)
	f.mod.banPurgeSem <- struct{}{}

	done := make(chan BanPurgeResult, 1)
	go func() { done <- f.mod.PurgeAfterBan(context.Background(), fixtureMod, fixtureMember2, time.Hour) }()
	time.Sleep(20 * time.Millisecond)
	if err := f.database.UnbanUser(context.Background(), fixtureMember2); err != nil {
		t.Fatalf("UnbanUser: %v", err)
	}
	<-f.mod.banPurgeSem

	res := <-done
	if !errors.Is(res.Err, ErrBadRequest) || res.Deleted != 0 {
		t.Fatalf("PurgeAfterBan after an unban while queued = %+v, want a refusal", res)
	}
	if banPurgeDeleted(t, f.database, id) {
		t.Error("a purge queued before an unban deleted a message")
	}
}
