package db_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

const banPurgeTSLayout = "2006-01-02 15:04:05"

// banPurgeStamp is a stored-format UTC timestamp d before now.
func banPurgeStamp(d time.Duration) string {
	return time.Now().UTC().Add(-d).Format(banPurgeTSLayout)
}

func TestPurgeUserChannelMessagesSince_OnlyAuthorAndWindow(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	target, other := seedUser(t, database, "bp-target"), seedUser(t, database, "bp-other")
	ch, otherCh := seedChannel(t, database, "bp-one"), seedChannel(t, database, "bp-two")

	old := seedStamped(t, database, ch, target, "old", banPurgeStamp(48*time.Hour))
	inWindow := seedStamped(t, database, ch, target, "recent", banPurgeStamp(time.Hour))
	otherAuthor := seedStamped(t, database, ch, other, "theirs", banPurgeStamp(time.Hour))
	otherChannel := seedStamped(t, database, otherCh, target, "elsewhere", banPurgeStamp(time.Hour))

	ids, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(24*time.Hour), 100)
	if err != nil {
		t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
	}
	if !slices.Equal(ids, []int64{inWindow}) {
		t.Fatalf("purged ids = %v, want [%d]", ids, inWindow)
	}
	for id, wantDeleted := range map[int64]bool{old: false, inWindow: true, otherAuthor: false, otherChannel: false} {
		deleted, found, err := database.IsMessageDeleted(ctx, id)
		if err != nil || !found || deleted != wantDeleted {
			t.Errorf("message %d: deleted=%v found=%v err=%v, want deleted=%v", id, deleted, found, err, wantDeleted)
		}
	}
}

func TestPurgeUserChannelMessagesSince_SkipsAlreadyDeleted(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	target := seedUser(t, database, "bp-target")
	ch := seedChannel(t, database, "bp-one")

	gone := seedStamped(t, database, ch, target, "gone", banPurgeStamp(time.Hour))
	live := seedStamped(t, database, ch, target, "live", banPurgeStamp(time.Hour))
	if _, err := database.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, gone); err != nil {
		t.Fatalf("pre-delete: %v", err)
	}

	ids, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(24*time.Hour), 100)
	if err != nil {
		t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
	}
	if !slices.Equal(ids, []int64{live}) {
		t.Fatalf("purged ids = %v, want [%d] (a pre-deleted id must not be returned)", ids, live)
	}
	again, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(24*time.Hour), 100)
	if err != nil || len(again) != 0 {
		t.Fatalf("second purge = %v, %v; want nothing left", again, err)
	}
}

func TestPurgeUserChannelMessagesSince_LimitBatches(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	target := seedUser(t, database, "bp-target")
	ch := seedChannel(t, database, "bp-one")
	for range 250 {
		seedStamped(t, database, ch, target, "spam", banPurgeStamp(time.Minute))
	}

	sizes := make([]int, 0, 4)
	for range 4 {
		ids, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(time.Hour), 100)
		if err != nil {
			t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
		}
		sizes = append(sizes, len(ids))
		if !slices.IsSortedFunc(ids, func(a, b int64) int { return int(b - a) }) {
			t.Errorf("batch ids not newest first: %v", ids)
		}
	}
	if !slices.Equal(sizes, []int{100, 100, 50, 0}) {
		t.Fatalf("batch sizes = %v, want [100 100 50 0]", sizes)
	}

	ids, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(time.Hour), 0)
	if err != nil || len(ids) != 0 {
		t.Fatalf("limit 0 = %v, %v; want a no-op", ids, err)
	}
}

func TestListUserMessageChannelsSince_ExcludesDMGroupDMArchived(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	target := seedUser(t, database, "bp-target")
	text := seedChannel(t, database, "bp-text")
	archived := seedChannel(t, database, "bp-archived")
	oldOnly := seedChannel(t, database, "bp-old")
	dm, err := database.CreateChannel(ctx, "bp-dm", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(dm): %v", err)
	}
	groupDM, err := database.CreateChannel(ctx, "bp-group", "dm", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(group dm): %v", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, archived); err != nil {
		t.Fatalf("archive: %v", err)
	}

	recent := banPurgeStamp(time.Hour)
	for _, ch := range []int64{text, archived, dm, groupDM} {
		seedStamped(t, database, ch, target, "msg", recent)
	}
	seedStamped(t, database, oldOnly, target, "msg", banPurgeStamp(72*time.Hour))
	deletedCh := seedChannel(t, database, "bp-deleted")
	gone := seedStamped(t, database, deletedCh, target, "msg", recent)
	if _, err := database.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, gone); err != nil {
		t.Fatalf("pre-delete: %v", err)
	}

	got, err := database.ListUserMessageChannelsSince(ctx, target, banPurgeStamp(24*time.Hour))
	if err != nil {
		t.Fatalf("ListUserMessageChannelsSince: %v", err)
	}
	if !slices.Equal(got, []int64{text}) {
		t.Fatalf("channels = %v, want only the live text channel [%d]", got, text)
	}
}

func TestBanPurge_HiddenFromSearchPinsAndUnread(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	target, reader := seedUser(t, database, "bp-target"), seedUser(t, database, "bp-reader")
	ch := seedChannel(t, database, "bp-one")

	spam := seedStamped(t, database, ch, target, "findme spam", banPurgeStamp(time.Minute))
	keep := seedStamped(t, database, ch, reader, "findme keep", banPurgeStamp(time.Minute))
	if _, err := database.ExecContext(ctx, `UPDATE messages SET pinned = 1, pinned_at = ? WHERE id = ?`, banPurgeStamp(time.Minute), spam); err != nil {
		t.Fatalf("pin: %v", err)
	}

	search := func() []int64 {
		t.Helper()
		rs, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{Text: "findme", ChannelIDs: []int64{ch}}, db.SearchPage{Limit: 50})
		if err != nil {
			t.Fatalf("SearchMessagesFiltered: %v", err)
		}
		ids := resultIDs(rs)
		slices.Sort(ids)
		return ids
	}
	if got := search(); !slices.Equal(got, []int64{spam, keep}) {
		t.Fatalf("before purge search = %v, want both rows", got)
	}
	if pins, err := database.GetPinnedMessages(ctx, ch, reader); err != nil || len(pins) != 1 {
		t.Fatalf("before purge pins = %d, %v; want 1", len(pins), err)
	}
	counts, err := database.GetChannelUnreadCounts(ctx, reader)
	if err != nil || counts[ch].UnreadCount != 2 {
		t.Fatalf("before purge unread = %+v, %v; want 2", counts[ch], err)
	}

	if _, err := database.PurgeUserChannelMessagesSince(ctx, ch, target, banPurgeStamp(time.Hour), 100); err != nil {
		t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
	}

	if got := search(); !slices.Equal(got, []int64{keep}) {
		t.Errorf("after purge search = %v, want [%d]", got, keep)
	}
	if pins, err := database.GetPinnedMessages(ctx, ch, reader); err != nil || len(pins) != 0 {
		t.Errorf("after purge pins = %d, %v; want none", len(pins), err)
	}
	counts, err = database.GetChannelUnreadCounts(ctx, reader)
	if err != nil || counts[ch].UnreadCount != 1 || counts[ch].LastMessageID != keep {
		t.Errorf("after purge unread = %+v, %v; want 1 unread, last id %d", counts[ch], err, keep)
	}
}

func TestRecordRemovalAction_WritesOneRowTargetingTheAuthor(t *testing.T) {
	database, ownerID, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	if err := database.RecordRemovalAction(ctx, memberID, ownerID, "3 messages removed with ban"); err != nil {
		t.Fatalf("RecordRemovalAction: %v", err)
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil {
		t.Fatalf("ListModerationActionsForTarget: %v", err)
	}
	if len(rows) != 1 || rows[0].Kind != "removal" || rows[0].Reason != "3 messages removed with ban" {
		t.Fatalf("rows = %+v, want one removal row with the reason", rows)
	}
}

func TestRecordRemovalAction_RefusesAnErasedActor(t *testing.T) {
	database, _, memberID := newModerationActionsTestDB(t)
	ctx := context.Background()

	for _, actor := range []int64{0, 987654} {
		if err := database.RecordRemovalAction(ctx, memberID, actor, "x"); err == nil {
			t.Errorf("RecordRemovalAction(actor=%d) = nil, want an error", actor)
		}
	}
	rows, err := database.ListModerationActionsForTarget(ctx, memberID)
	if err != nil || len(rows) != 0 {
		t.Fatalf("rows after refused writes = %+v, %v; want none", rows, err)
	}
}
