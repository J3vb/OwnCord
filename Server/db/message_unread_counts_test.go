package db_test

import (
	"context"
	"testing"
)

// ─── UpdateReadState ──────────────────────────────────────────────────────────

func TestUpdateReadState_Upsert(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "ella")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "msg", nil)

	mustDo(t, "UpdateReadState", database.UpdateReadState(context.Background(), userID, chID, msgID))

	// Update again with higher message ID — should not error.
	msgID2, _ := database.CreateMessage(context.Background(), chID, userID, "msg2", nil)
	mustDo(t, "UpdateReadState second call", database.UpdateReadState(context.Background(), userID, chID, msgID2))
}

// ─── GetChannelUnreadCounts ─────────────────────────────────────────────────

func TestGetChannelUnreadCounts_NoMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreaduser")
	_ = seedChannel(t, database, "unreadchan")

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	// Should return entries for text channels even with 0 messages.
	if counts == nil {
		t.Fatal("GetChannelUnreadCounts returned nil")
	}
}

func TestGetChannelUnreadCounts_WithUnreadMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreaduser2")
	chID := seedChannel(t, database, "unreadchan2")

	// Create 3 messages, mark first as read.
	msg1, _ := database.CreateMessage(context.Background(), chID, userID, "msg1", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "msg2", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "msg3", nil)

	_ = database.UpdateReadState(context.Background(), userID, chID, msg1)

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu, ok := counts[chID]
	if !ok {
		t.Fatalf("channel %d not in unread counts", chID)
	}
	if cu.UnreadCount != 2 {
		t.Errorf("UnreadCount = %d, want 2", cu.UnreadCount)
	}
}

// A channel with more than 100 unread messages reports a capped count: the
// ready payload only needs "99+" to render, and bounding the subquery keeps a
// huge never-read channel from scanning every message row on every connect.
// A small channel is unaffected.
func TestGetChannelUnreadCounts_CapsAt100(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreadcap")
	bigChID := seedChannel(t, database, "bigchan")
	smallChID := seedChannel(t, database, "smallchan")

	for range 150 {
		mustCreateMessage(t, database, bigChID, userID, "msg", nil)
	}
	for range 3 {
		mustCreateMessage(t, database, smallChID, userID, "msg", nil)
	}

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	if got := counts[bigChID].UnreadCount; got != 100 {
		t.Errorf("big channel UnreadCount = %d, want 100 (capped)", got)
	}
	if got := counts[smallChID].UnreadCount; got != 3 {
		t.Errorf("small channel UnreadCount = %d, want 3 (uncapped)", got)
	}
}

// A channel with no messages must still yield a 0,0 entry — the correlated
// subquery rewrite must not silently drop empty channels from the ready
// payload's unread map.
func TestGetChannelUnreadCounts_ZeroMessageChannelYieldsZeros(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreadzero")
	chID := seedChannel(t, database, "emptychan")

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu, ok := counts[chID]
	if !ok {
		t.Fatalf("empty channel %d missing from unread counts", chID)
	}
	if cu.LastMessageID != 0 || cu.UnreadCount != 0 {
		t.Errorf("empty channel = {last:%d unread:%d}, want {0 0}", cu.LastMessageID, cu.UnreadCount)
	}
}

func TestGetChannelUnreadCounts_IncludesAnnouncementChannels(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreadann")
	annID := mustCreateChannel(t, database, "announcements", "announcement", "", "", 0)

	msgID, _ := database.CreateMessage(context.Background(), annID, userID, "server news", nil)

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu, ok := counts[annID]
	if !ok {
		t.Fatalf("announcement channel %d missing from unread counts", annID)
	}
	if cu.LastMessageID != msgID {
		t.Errorf("LastMessageID = %d, want %d", cu.LastMessageID, msgID)
	}
	if cu.UnreadCount != 1 {
		t.Errorf("UnreadCount = %d, want 1", cu.UnreadCount)
	}
}

// Deleted messages count neither toward unread nor toward last_msg_id.
func TestGetChannelUnreadCounts_ExcludesDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreaddel")
	chID := seedChannel(t, database, "unreaddelchan")

	keepID, _ := database.CreateMessage(context.Background(), chID, userID, "keep", nil)
	delID, _ := database.CreateMessage(context.Background(), chID, userID, "gone", nil)
	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), delID, userID, false))

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu := counts[chID]
	if cu.LastMessageID != keepID {
		t.Errorf("LastMessageID = %d, want %d (deleted excluded)", cu.LastMessageID, keepID)
	}
	if cu.UnreadCount != 1 {
		t.Errorf("UnreadCount = %d, want 1 (deleted excluded)", cu.UnreadCount)
	}
}

// ─── GetLatestMessageID ─────────────────────────────────────────────────────

func TestGetLatestMessageID_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "latestchan")

	id, err := database.GetLatestMessageID(context.Background(), chID)
	mustDo(t, "GetLatestMessageID", err)
	if id != 0 {
		t.Errorf("expected 0 for empty channel, got %d", id)
	}
}

func TestGetLatestMessageID_ReturnsHighest(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "latestuser")
	chID := seedChannel(t, database, "latestchan2")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "first", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "second", nil)
	lastID, _ := database.CreateMessage(context.Background(), chID, userID, "third", nil)

	id, err := database.GetLatestMessageID(context.Background(), chID)
	mustDo(t, "GetLatestMessageID", err)
	if id != lastID {
		t.Errorf("GetLatestMessageID = %d, want %d", id, lastID)
	}
}

func TestGetLatestMessageID_ExcludesDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "latestdel")
	chID := seedChannel(t, database, "latestdelchan")

	id1, _ := database.CreateMessage(context.Background(), chID, userID, "keep", nil)
	id2, _ := database.CreateMessage(context.Background(), chID, userID, "delete me", nil)
	_ = database.DeleteMessage(context.Background(), id2, userID, false)

	latestID, err := database.GetLatestMessageID(context.Background(), chID)
	mustDo(t, "GetLatestMessageID", err)
	if latestID != id1 {
		t.Errorf("GetLatestMessageID = %d, want %d (deleted excluded)", latestID, id1)
	}
}

// ─── GetChannelUnreadCounts: DM rows ────────────────────────────────────────

// DM channels the user participates in must appear, so the ready payload can
// ship a real mention_count for them instead of resetting the badge to 0 on
// every reconnect.
func TestGetChannelUnreadCounts_IncludesParticipatingDMs(t *testing.T) {
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "dmunreadalice")
	bob := seedUser(t, database, "dmunreadbob")

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), alice, bob)
	mustDo(t, "GetOrCreateDMChannel", err)
	msgID, _ := database.CreateMessage(context.Background(), ch.ID, bob, "hey", nil)
	mustDo(t, "IncrementMentionCounts", database.IncrementMentionCounts(context.Background(), ch.ID, msgID, []int64{alice}))

	counts, err := database.GetChannelUnreadCounts(context.Background(), alice)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu, ok := counts[ch.ID]
	if !ok {
		t.Fatalf("DM channel %d missing from unread counts for a participant", ch.ID)
	}
	if cu.LastMessageID != msgID {
		t.Errorf("LastMessageID = %d, want %d", cu.LastMessageID, msgID)
	}
	if cu.UnreadCount != 1 {
		t.Errorf("UnreadCount = %d, want 1", cu.UnreadCount)
	}
	if cu.MentionCount != 1 {
		t.Errorf("MentionCount = %d, want 1", cu.MentionCount)
	}
}

func TestGetChannelUnreadCounts_ExcludesForeignDMs(t *testing.T) {
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "dmforeignalice")
	bob := seedUser(t, database, "dmforeignbob")
	outsider := seedUser(t, database, "dmforeignoutsider")

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), alice, bob)
	mustDo(t, "GetOrCreateDMChannel", err)
	_, _ = database.CreateMessage(context.Background(), ch.ID, bob, "private", nil)

	counts, err := database.GetChannelUnreadCounts(context.Background(), outsider)
	mustDo(t, "GetChannelUnreadCounts", err)
	if _, ok := counts[ch.ID]; ok {
		t.Errorf("DM channel %d leaked into a non-participant's unread counts", ch.ID)
	}
}

// LastReadMessageID is the caller's own read pointer, distinct from the
// channel's newest message, and 0 for a channel with no read_states row.
func TestGetChannelUnreadCounts_LastReadMessageID(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)
	reader := seedUser(t, database, "pointerreader")
	other := seedUser(t, database, "pointerother")
	read := seedChannel(t, database, "pointer-read")
	untouched := seedChannel(t, database, "pointer-untouched")

	first := mustCreateMessage(t, database, read, reader, "one", nil)
	last := mustCreateMessage(t, database, read, reader, "two", nil)
	mustCreateMessage(t, database, untouched, reader, "x", nil)
	mustDo(t, "UpdateReadState", database.UpdateReadState(ctx, reader, read, first))

	counts, err := database.GetChannelUnreadCounts(ctx, reader)
	mustDo(t, "GetChannelUnreadCounts", err)
	if got := counts[read].LastReadMessageID; got != first {
		t.Errorf("LastReadMessageID = %d, want %d", got, first)
	}
	if got := counts[read].LastMessageID; got != last {
		t.Errorf("LastMessageID = %d, want newest message %d", got, last)
	}
	if got := counts[untouched].LastReadMessageID; got != 0 {
		t.Errorf("channel with no read row: LastReadMessageID = %d, want 0", got)
	}

	// Another user's pointer must not leak into this user's answer.
	otherCounts, err := database.GetChannelUnreadCounts(ctx, other)
	mustDo(t, "GetChannelUnreadCounts(other)", err)
	if got := otherCounts[read].LastReadMessageID; got != 0 {
		t.Errorf("other user LastReadMessageID = %d, want 0", got)
	}
}
