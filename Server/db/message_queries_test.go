package db_test

import (
	"context"
	"slices"
	"strconv"
	"testing"

	"github.com/owncord/server/db"
)

// seedUser inserts a minimal test user and returns its ID.
func seedUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, "hash", 4)
	if err != nil {
		t.Fatalf("seedUser(%q): %v", username, err)
	}
	return id
}

// seedChannel inserts a minimal test channel and returns its ID.
func seedChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(context.Background(), name, "text", "", "", 0)
	if err != nil {
		t.Fatalf("seedChannel(%q): %v", name, err)
	}
	return id
}

// ─── CreateMessage ────────────────────────────────────────────────────────────

func TestCreateMessage_ReturnsID(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")
	chID := seedChannel(t, database, "general")

	id, err := database.CreateMessage(context.Background(), chID, userID, "hello", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}
}

func TestCreateMessage_WithReplyTo(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")
	chID := seedChannel(t, database, "general")

	parentID, _ := database.CreateMessage(context.Background(), chID, userID, "parent", nil)
	replyID, err := database.CreateMessage(context.Background(), chID, userID, "reply", &parentID)
	if err != nil {
		t.Fatalf("CreateMessage with reply: %v", err)
	}

	msg, _ := database.GetMessage(context.Background(), replyID)
	if msg.ReplyTo == nil || *msg.ReplyTo != parentID {
		t.Errorf("ReplyTo = %v, want %d", msg.ReplyTo, parentID)
	}
}

func TestCreateMessage_ContentPreserved(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "bob")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "test content", nil)
	msg, _ := database.GetMessage(context.Background(), id)
	if msg.Content != "test content" {
		t.Errorf("Content = %q, want 'test content'", msg.Content)
	}
}

// ─── GetMessage ───────────────────────────────────────────────────────────────

func TestGetMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	msg, err := database.GetMessage(context.Background(), 9999)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg != nil {
		t.Error("expected nil for non-existent message")
	}
}

func TestGetMessage_Fields(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "carol")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "hello world", nil)

	msg, err := database.GetMessage(context.Background(), id)
	if err != nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if msg == nil {
		t.Fatal("expected message, got nil")
	}
	if msg.ChannelID != chID {
		t.Errorf("ChannelID = %d, want %d", msg.ChannelID, chID)
	}
	if msg.UserID != userID {
		t.Errorf("UserID = %d, want %d", msg.UserID, userID)
	}
	if msg.Deleted {
		t.Error("expected Deleted=false for new message")
	}
	if msg.Pinned {
		t.Error("expected Pinned=false for new message")
	}
	if msg.EditedAt != nil {
		t.Error("expected EditedAt=nil for new message")
	}
}

// ─── GetMessages ──────────────────────────────────────────────────────────────

func TestGetMessages_EmptyChannel(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "empty")

	msgs, err := database.GetMessages(context.Background(), chID, 0, 50)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}
}

func TestGetMessages_ReturnsMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "dave")
	chID := seedChannel(t, database, "ch")

	for i := range 3 {
		_, err := database.CreateMessage(context.Background(), chID, userID, "msg", nil)
		if err != nil {
			t.Fatalf("CreateMessage %d: %v", i, err)
		}
	}

	msgs, err := database.GetMessages(context.Background(), chID, 0, 50)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages, got %d", len(msgs))
	}
}

func TestGetMessages_LimitRespected(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "eve")
	chID := seedChannel(t, database, "ch")

	for range 10 {
		_, _ = database.CreateMessage(context.Background(), chID, userID, "msg", nil)
	}

	msgs, _ := database.GetMessages(context.Background(), chID, 0, 5)
	if len(msgs) != 5 {
		t.Errorf("expected 5 messages (limit), got %d", len(msgs))
	}
}

func TestGetMessages_BeforePagination(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "frank")
	chID := seedChannel(t, database, "ch")

	ids := make([]int64, 0, 5)
	for range 5 {
		id, _ := database.CreateMessage(context.Background(), chID, userID, "msg", nil)
		ids = append(ids, id)
	}

	// Get messages before the 4th message (should get 3 messages: ids 0,1,2).
	msgs, _ := database.GetMessages(context.Background(), chID, ids[3], 50)
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages before id %d, got %d", ids[3], len(msgs))
	}
}

func TestGetMessages_IncludesUsername(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "grace")
	chID := seedChannel(t, database, "ch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hi", nil)
	msgs, _ := database.GetMessages(context.Background(), chID, 0, 50)

	if len(msgs) == 0 {
		t.Fatal("expected messages")
	}
	if msgs[0].Username != "grace" {
		t.Errorf("Username = %q, want 'grace'", msgs[0].Username)
	}
}

// ─── EditMessage ──────────────────────────────────────────────────────────────

func TestEditMessage_OwnerCanEdit(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "henry")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "original", nil)

	updated, err := database.EditMessage(context.Background(), id, userID, "updated")
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	// The RETURNING row must reflect the write without a re-read.
	if updated == nil || updated.Content != "updated" {
		t.Errorf("returned row Content = %+v, want 'updated'", updated)
	}
	if updated.EditedAt == nil {
		t.Error("returned row EditedAt should be set after edit")
	}

	msg, _ := database.GetMessage(context.Background(), id)
	if msg.Content != "updated" {
		t.Errorf("Content = %q, want 'updated'", msg.Content)
	}
	if msg.EditedAt == nil {
		t.Error("EditedAt should be set after edit")
	}
}

func TestEditMessage_NonOwnerCannotEdit(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "ivan")
	otherID := seedUser(t, database, "julia")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, ownerID, "original", nil)

	_, err := database.EditMessage(context.Background(), id, otherID, "hacked")
	if err == nil {
		t.Error("EditMessage by non-owner should return error")
	}
}

func TestEditMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "kim")

	_, err := database.EditMessage(context.Background(), 9999, userID, "x")
	if err == nil {
		t.Error("EditMessage non-existent should return error")
	}
}

// ─── DeleteMessage ────────────────────────────────────────────────────────────

func TestDeleteMessage_OwnerCanDelete(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "larry")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "bye", nil)

	if err := database.DeleteMessage(context.Background(), id, userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	msg, _ := database.GetMessage(context.Background(), id)
	if msg == nil {
		t.Fatal("soft-deleted message should still exist in DB")
	}
	if !msg.Deleted {
		t.Error("expected Deleted=true after soft delete")
	}
}

func TestDeleteMessage_ContentPreservedAfterSoftDelete(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "mia")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "sensitive", nil)
	_ = database.DeleteMessage(context.Background(), id, userID, false)

	msg, _ := database.GetMessage(context.Background(), id)
	// Content preserved for broadcast (soft delete only flags deleted=1).
	if msg.Content == "" {
		t.Error("content should be preserved on soft delete for broadcast purposes")
	}
}

func TestDeleteMessage_NonOwnerBlockedWithoutMod(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "nate")
	otherID := seedUser(t, database, "olivia")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, ownerID, "msg", nil)

	err := database.DeleteMessage(context.Background(), id, otherID, false)
	if err == nil {
		t.Error("DeleteMessage by non-owner non-mod should return error")
	}
}

func TestDeleteMessage_ModCanDeleteAny(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "pete")
	modID := seedUser(t, database, "quinn")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, ownerID, "msg", nil)

	if err := database.DeleteMessage(context.Background(), id, modID, true); err != nil {
		t.Fatalf("DeleteMessage by mod: %v", err)
	}

	msg, _ := database.GetMessage(context.Background(), id)
	if !msg.Deleted {
		t.Error("expected Deleted=true after mod delete")
	}
}

func TestDeleteMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "rachel")

	err := database.DeleteMessage(context.Background(), 9999, userID, true)
	if err == nil {
		t.Error("DeleteMessage non-existent should return error")
	}
}

// ─── PurgeChannelMessages ─────────────────────────────────────────────────────

// purgeSeed inserts n messages into a fresh channel and returns the database,
// the channel id, and the message ids in insertion (oldest-first) order.
func purgeSeed(t *testing.T, n int) (*db.DB, int64, []int64) {
	t.Helper()
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "purger")
	chID := seedChannel(t, database, "purge-ch")
	ids := make([]int64, 0, n)
	for i := range n {
		id, err := database.CreateMessage(context.Background(), chID, userID,
			"msg"+strconv.Itoa(i), nil)
		if err != nil {
			t.Fatalf("CreateMessage %d: %v", i, err)
		}
		ids = append(ids, id)
	}
	return database, chID, ids
}

func TestPurgeChannelMessages_DeletesNewestFirst(t *testing.T) {
	database, chID, ids := purgeSeed(t, 5)

	got, err := database.PurgeChannelMessages(context.Background(), chID, 0, 2)
	if err != nil {
		t.Fatalf("PurgeChannelMessages: %v", err)
	}
	want := []int64{ids[4], ids[3]}
	if !slices.Equal(got, want) {
		t.Fatalf("purged ids = %v, want %v", got, want)
	}
	for _, id := range want {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg == nil || !msg.Deleted {
			t.Errorf("message %d should be soft-deleted", id)
		}
	}
	for _, id := range ids[:3] {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg == nil || msg.Deleted {
			t.Errorf("message %d should be untouched", id)
		}
	}
}

func TestPurgeChannelMessages_PreservesTombstones(t *testing.T) {
	database, chID, ids := purgeSeed(t, 3)

	if _, err := database.PurgeChannelMessages(context.Background(), chID, 0, 3); err != nil {
		t.Fatalf("PurgeChannelMessages: %v", err)
	}

	// The rows must survive with their content, so tombstones render and
	// reply_to targets still resolve — exactly as a single soft delete.
	for _, id := range ids {
		msg, err := database.GetMessage(context.Background(), id)
		if err != nil {
			t.Fatalf("GetMessage(%d): %v", id, err)
		}
		if msg == nil {
			t.Fatalf("message %d was hard-deleted", id)
		}
		if !msg.Deleted {
			t.Errorf("message %d not marked deleted", id)
		}
		if msg.Content == "" {
			t.Errorf("message %d lost its content", id)
		}
	}
}

func TestPurgeChannelMessages_SkipsAlreadyDeleted(t *testing.T) {
	database, chID, ids := purgeSeed(t, 4)
	if _, err := database.PurgeChannelMessages(context.Background(), chID, 0, 1); err != nil {
		t.Fatalf("first purge: %v", err)
	}

	got, err := database.PurgeChannelMessages(context.Background(), chID, 0, 10)
	if err != nil {
		t.Fatalf("second purge: %v", err)
	}
	want := []int64{ids[2], ids[1], ids[0]}
	if !slices.Equal(got, want) {
		t.Fatalf("second purge ids = %v, want %v", got, want)
	}
}

func TestPurgeChannelMessages_BeforeCursor(t *testing.T) {
	database, chID, ids := purgeSeed(t, 5)

	got, err := database.PurgeChannelMessages(context.Background(), chID, ids[2], 10)
	if err != nil {
		t.Fatalf("PurgeChannelMessages: %v", err)
	}
	want := []int64{ids[1], ids[0]}
	if !slices.Equal(got, want) {
		t.Fatalf("purged ids = %v, want %v", got, want)
	}
	for _, id := range ids[2:] {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg.Deleted {
			t.Errorf("message %d at/after the cursor should be untouched", id)
		}
	}
}

func TestPurgeChannelMessages_OtherChannelsUntouched(t *testing.T) {
	database, chID, ids := purgeSeed(t, 2)
	otherCh := seedChannel(t, database, "other")
	otherID, _ := database.CreateMessage(context.Background(), otherCh, ids[0], "keep", nil)

	if _, err := database.PurgeChannelMessages(context.Background(), chID, 0, 100); err != nil {
		t.Fatalf("PurgeChannelMessages: %v", err)
	}

	msg, _ := database.GetMessage(context.Background(), otherID)
	if msg == nil || msg.Deleted {
		t.Error("a message in another channel was purged")
	}
}

func TestPurgeChannelMessages_EmptyChannelAndZeroLimit(t *testing.T) {
	database, chID, _ := purgeSeed(t, 1)

	got, err := database.PurgeChannelMessages(context.Background(), chID, 0, 0)
	if err != nil {
		t.Fatalf("zero limit: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("zero limit purged %v, want none", got)
	}

	emptyCh := seedChannel(t, database, "empty")
	got, err = database.PurgeChannelMessages(context.Background(), emptyCh, 0, 50)
	if err != nil {
		t.Fatalf("empty channel: %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("empty channel returned %v, want empty non-nil slice", got)
	}
}

// ─── Reactions ────────────────────────────────────────────────────────────────

func TestAddReaction_Success(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "sam")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	if err := database.AddReaction(context.Background(), msgID, userID, "👍"); err != nil {
		t.Fatalf("AddReaction: %v", err)
	}
}

func TestAddReaction_UniqueConstraint(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "tina")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	_ = database.AddReaction(context.Background(), msgID, userID, "❤️")
	err := database.AddReaction(context.Background(), msgID, userID, "❤️")
	if err == nil {
		t.Error("adding duplicate reaction should return error")
	}
}

func TestRemoveReaction_Success(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "uma")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	_ = database.AddReaction(context.Background(), msgID, userID, "😂")
	if err := database.RemoveReaction(context.Background(), msgID, userID, "😂"); err != nil {
		t.Fatalf("RemoveReaction: %v", err)
	}
}

func TestRemoveReaction_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "victor")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	err := database.RemoveReaction(context.Background(), msgID, userID, "🔥")
	if err == nil {
		t.Error("removing non-existent reaction should return error")
	}
}

func TestGetReactions_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "wendy")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil {
		t.Fatalf("GetReactions: %v", err)
	}
	if len(counts) != 0 {
		t.Errorf("expected 0 reactions, got %d", len(counts))
	}
}

func TestGetReactions_Counts(t *testing.T) {
	database := openMigratedMemory(t)
	u1 := seedUser(t, database, "xavier")
	u2 := seedUser(t, database, "yvonne")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, u1, "hi", nil)

	_ = database.AddReaction(context.Background(), msgID, u1, "👍")
	_ = database.AddReaction(context.Background(), msgID, u2, "👍")
	_ = database.AddReaction(context.Background(), msgID, u1, "❤️")

	counts, _ := database.GetReactions(context.Background(), msgID)
	if len(counts) != 2 {
		t.Fatalf("expected 2 emoji types, got %d", len(counts))
	}
	for _, rc := range counts {
		switch rc.Emoji {
		case "👍":
			if rc.Count != 2 {
				t.Errorf("👍 count = %d, want 2", rc.Count)
			}
		case "❤️":
			if rc.Count != 1 {
				t.Errorf("❤️ count = %d, want 1", rc.Count)
			}
		default:
			t.Errorf("unexpected emoji %q", rc.Emoji)
		}
	}
}

// ─── SearchMessages ───────────────────────────────────────────────────────────

func TestSearchMessages_FindsMatch(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "zara")
	chID := seedChannel(t, database, "searchch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello world fts test", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "unrelated content here", nil)

	results, err := database.SearchMessages(context.Background(), "hello", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
	if results[0].Content != "hello world fts test" {
		t.Errorf("Content = %q, want 'hello world fts test'", results[0].Content)
	}
}

func TestSearchMessages_FilterByChannel(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "adam")
	ch1 := seedChannel(t, database, "ch1")
	ch2 := seedChannel(t, database, "ch2")

	_, _ = database.CreateMessage(context.Background(), ch1, userID, "needle in channel 1", nil)
	_, _ = database.CreateMessage(context.Background(), ch2, userID, "needle in channel 2", nil)

	results, _ := database.SearchMessages(context.Background(), "needle", &ch1, 10)
	if len(results) != 1 {
		t.Errorf("expected 1 result in ch1, got %d", len(results))
	}
	if results[0].ChannelID != ch1 {
		t.Errorf("ChannelID = %d, want %d", results[0].ChannelID, ch1)
	}
}

func TestSearchMessages_NoResults(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "beth")
	chID := seedChannel(t, database, "ch")
	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello there", nil)

	results, _ := database.SearchMessages(context.Background(), "xyzzy", nil, 10)
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestSearchMessages_LimitRespected(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "carl")
	chID := seedChannel(t, database, "ch")

	for range 5 {
		_, _ = database.CreateMessage(context.Background(), chID, userID, "searchable keyword content", nil)
	}

	results, _ := database.SearchMessages(context.Background(), "keyword", nil, 3)
	if len(results) != 3 {
		t.Errorf("expected 3 results (limit), got %d", len(results))
	}
}

func TestSearchMessages_DeletedNotReturned(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "diana")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "vanishing keyword message", nil)
	_ = database.DeleteMessage(context.Background(), id, userID, false)

	results, _ := database.SearchMessages(context.Background(), "vanishing", nil, 10)
	if len(results) != 0 {
		t.Errorf("expected 0 results (deleted excluded), got %d", len(results))
	}
}

// Migration 019 narrows the messages_au trigger to AFTER UPDATE OF content;
// an edit must still reindex the FTS table (old term gone, new term found).
func TestSearchMessages_EditReindexes(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "edith")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "obsolete wording here", nil)
	if _, err := database.EditMessage(context.Background(), id, userID, "fresh wording here"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}

	stale, _ := database.SearchMessages(context.Background(), "obsolete", nil, 10)
	if len(stale) != 0 {
		t.Errorf("expected 0 results for pre-edit content, got %d", len(stale))
	}
	updated, _ := database.SearchMessages(context.Background(), "fresh", nil, 10)
	if len(updated) != 1 {
		t.Errorf("expected 1 result for post-edit content, got %d", len(updated))
	}
}

// Pinning updates a non-content column, which the narrowed trigger must
// ignore — the message stays searchable and the FTS index stays consistent.
func TestSearchMessages_PinnedMessageStaysSearchable(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pinny")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "pinworthy announcement", nil)
	if err := database.SetMessagePinned(context.Background(), id, true); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}

	results, err := database.SearchMessages(context.Background(), "pinworthy", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected pinned message to remain searchable, got %d results", len(results))
	}
}

// ─── UpdateReadState ──────────────────────────────────────────────────────────

func TestUpdateReadState_Upsert(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "ella")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "msg", nil)

	if err := database.UpdateReadState(context.Background(), userID, chID, msgID); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	// Update again with higher message ID — should not error.
	msgID2, _ := database.CreateMessage(context.Background(), chID, userID, "msg2", nil)
	if err := database.UpdateReadState(context.Background(), userID, chID, msgID2); err != nil {
		t.Fatalf("UpdateReadState second call: %v", err)
	}
}

// ─── GetMessagesForAPI ──────────────────────────────────────────────────────

func TestGetMessagesForAPI_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "apichan")
	userID := seedUser(t, database, "apiuser")

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, 0, 50, userID)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}
}

func TestGetMessagesForAPI_ReturnsUserObject(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "apiuser2")
	chID := seedChannel(t, database, "apichan2")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello api", nil)

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, 0, 50, userID)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].User.Username != "apiuser2" {
		t.Errorf("User.Username = %q, want 'apiuser2'", msgs[0].User.Username)
	}
	if msgs[0].User.ID != userID {
		t.Errorf("User.ID = %d, want %d", msgs[0].User.ID, userID)
	}
	if msgs[0].Content != "hello api" {
		t.Errorf("Content = %q, want 'hello api'", msgs[0].Content)
	}
}

func TestGetMessagesForAPI_BeforePagination(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "apipage")
	chID := seedChannel(t, database, "apich")

	ids := make([]int64, 0, 5)
	for range 5 {
		id, _ := database.CreateMessage(context.Background(), chID, userID, "msg", nil)
		ids = append(ids, id)
	}

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, ids[3], 50, userID)
	if err != nil {
		t.Fatalf("GetMessagesForAPI with before: %v", err)
	}
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages before id %d, got %d", ids[3], len(msgs))
	}
}

func TestGetMessagesForAPI_WithReactions(t *testing.T) {
	database := openMigratedMemory(t)
	u1 := seedUser(t, database, "reactuser1")
	u2 := seedUser(t, database, "reactuser2")
	chID := seedChannel(t, database, "reactchan")

	msgID, _ := database.CreateMessage(context.Background(), chID, u1, "react me", nil)
	_ = database.AddReaction(context.Background(), msgID, u1, "👍")
	_ = database.AddReaction(context.Background(), msgID, u2, "👍")

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, 0, 50, u1)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if len(msgs[0].Reactions) != 1 {
		t.Fatalf("expected 1 reaction type, got %d", len(msgs[0].Reactions))
	}
	if msgs[0].Reactions[0].Count != 2 {
		t.Errorf("reaction count = %d, want 2", msgs[0].Reactions[0].Count)
	}
	if !msgs[0].Reactions[0].Me {
		t.Error("Me should be true for requesting user who reacted")
	}
}

func TestGetMessagesForAPI_ExcludesDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "apidel")
	chID := seedChannel(t, database, "apidelchan")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "deleted msg", nil)
	_ = database.DeleteMessage(context.Background(), id, userID, false)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "visible msg", nil)

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, 0, 50, userID)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	if len(msgs) != 1 {
		t.Errorf("expected 1 message (deleted excluded), got %d", len(msgs))
	}
}

// ─── GetMessagesAroundForAPI ────────────────────────────────────────────────

// seedAroundMessages fills a channel with n messages and returns their ids in
// ascending order.
func seedAroundMessages(t *testing.T, database *db.DB, chID, userID int64, n int) []int64 {
	t.Helper()
	ids := make([]int64, 0, n)
	for i := range n {
		id, err := database.CreateMessage(context.Background(), chID, userID, "m"+strconv.Itoa(i), nil)
		if err != nil {
			t.Fatalf("CreateMessage %d: %v", i, err)
		}
		ids = append(ids, id)
	}
	return ids
}

func TestGetMessagesAroundForAPI_CentersAndOrdersAscending(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu1")
	chID := seedChannel(t, database, "aroundc1")
	ids := seedAroundMessages(t, database, chID, userID, 20)

	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[10], 3, 2, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI: %v", err)
	}
	// 3 older + centre + 2 newer.
	want := []int64{ids[7], ids[8], ids[9], ids[10], ids[11], ids[12]}
	got := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		got = append(got, m.ID)
	}
	if !slices.Equal(got, want) {
		t.Errorf("window = %v, want %v", got, want)
	}
}

func TestGetMessagesAroundForAPI_ClampsAtChannelEdges(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu2")
	chID := seedChannel(t, database, "aroundc2")
	ids := seedAroundMessages(t, database, chID, userID, 4)

	first, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[0], 10, 10, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI(first): %v", err)
	}
	if len(first) != 4 || first[0].ID != ids[0] {
		t.Errorf("window at the first message = %d entries starting at %d, want 4 starting at %d",
			len(first), first[0].ID, ids[0])
	}

	last, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[3], 10, 10, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI(last): %v", err)
	}
	if len(last) != 4 || last[len(last)-1].ID != ids[3] {
		t.Errorf("window at the last message = %d entries ending at %d, want 4 ending at %d",
			len(last), last[len(last)-1].ID, ids[3])
	}
}

func TestGetMessagesAroundForAPI_ExcludesDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu3")
	chID := seedChannel(t, database, "aroundc3")
	ids := seedAroundMessages(t, database, chID, userID, 5)
	if err := database.DeleteMessage(context.Background(), ids[1], userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[2], 5, 5, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI: %v", err)
	}
	for _, m := range msgs {
		if m.ID == ids[1] {
			t.Fatalf("deleted message %d present in the window", ids[1])
		}
	}
	if len(msgs) != 4 {
		t.Errorf("window size = %d, want 4", len(msgs))
	}
}

func TestGetMessagesAroundForAPI_ScopedToChannel(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu4")
	chA := seedChannel(t, database, "aroundc4a")
	chB := seedChannel(t, database, "aroundc4b")
	idsA := seedAroundMessages(t, database, chA, userID, 3)
	seedAroundMessages(t, database, chB, userID, 3)

	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chA, idsA[1], 10, 10, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("window size = %d, want the 3 messages of channel A only", len(msgs))
	}
	for _, m := range msgs {
		if m.ChannelID != chA {
			t.Errorf("message %d belongs to channel %d, not %d", m.ID, m.ChannelID, chA)
		}
	}
}

func TestGetMessagesAroundForAPI_NegativeCountsClampToZero(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu5")
	chID := seedChannel(t, database, "aroundc5")
	ids := seedAroundMessages(t, database, chID, userID, 5)

	// A negative count must not become a negative SQL LIMIT (which SQLite
	// reads as "no limit" and would silently return the whole channel).
	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[2], -4, -4, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI: %v", err)
	}
	if len(msgs) != 1 || msgs[0].ID != ids[2] {
		t.Errorf("window = %d entries, want just the centre %d", len(msgs), ids[2])
	}
}

func TestGetMessagesAroundForAPI_UnknownCentreIsEmpty(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "aroundu6")
	chID := seedChannel(t, database, "aroundc6")
	seedAroundMessages(t, database, chID, userID, 3)

	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chID, 999999, 5, 5, userID)
	if err != nil {
		t.Fatalf("GetMessagesAroundForAPI: %v", err)
	}
	// Nothing is <= the centre in this channel below it, and nothing above it.
	if len(msgs) != 3 {
		t.Errorf("window size = %d; an out-of-range centre should still be bounded by the channel", len(msgs))
	}
}

// ─── GetChannelUnreadCounts ─────────────────────────────────────────────────

func TestGetChannelUnreadCounts_NoMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreaduser")
	_ = seedChannel(t, database, "unreadchan")

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
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
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	cu, ok := counts[chID]
	if !ok {
		t.Fatalf("channel %d not in unread counts", chID)
	}
	if cu.UnreadCount != 2 {
		t.Errorf("UnreadCount = %d, want 2", cu.UnreadCount)
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
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
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
	annID, err := database.CreateChannel(context.Background(), "announcements", "announcement", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(announcement): %v", err)
	}
	voiceID, err := database.CreateChannel(context.Background(), "voicechan", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(voice): %v", err)
	}

	msgID, _ := database.CreateMessage(context.Background(), annID, userID, "server news", nil)

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
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
	if _, ok := counts[voiceID]; ok {
		t.Errorf("voice channel %d must not appear in unread counts", voiceID)
	}
}

// Deleted messages count neither toward unread nor toward last_msg_id.
func TestGetChannelUnreadCounts_ExcludesDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unreaddel")
	chID := seedChannel(t, database, "unreaddelchan")

	keepID, _ := database.CreateMessage(context.Background(), chID, userID, "keep", nil)
	delID, _ := database.CreateMessage(context.Background(), chID, userID, "gone", nil)
	if err := database.DeleteMessage(context.Background(), delID, userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	counts, err := database.GetChannelUnreadCounts(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
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
	if err != nil {
		t.Fatalf("GetLatestMessageID: %v", err)
	}
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
	if err != nil {
		t.Fatalf("GetLatestMessageID: %v", err)
	}
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
	if err != nil {
		t.Fatalf("GetLatestMessageID: %v", err)
	}
	if latestID != id1 {
		t.Errorf("GetLatestMessageID = %d, want %d (deleted excluded)", latestID, id1)
	}
}

// ─── GetReactionUsers ───────────────────────────────────────────────────────

func TestGetReactionUsers_ReturnsReactorsInReactionOrder(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "reactusers")
	author := seedUser(t, database, "reactauthor")
	first := seedUser(t, database, "reactfirst")
	second := seedUser(t, database, "reactsecond")
	msgID, _ := database.CreateMessage(context.Background(), chID, author, "react to me", nil)

	// second reacts before first, so reaction order (not user id) decides.
	if err := database.AddReaction(context.Background(), msgID, second, "👍"); err != nil {
		t.Fatalf("AddReaction(second): %v", err)
	}
	if err := database.AddReaction(context.Background(), msgID, first, "👍"); err != nil {
		t.Fatalf("AddReaction(first): %v", err)
	}
	// A different emoji on the same message must not leak in.
	if err := database.AddReaction(context.Background(), msgID, author, "🎉"); err != nil {
		t.Fatalf("AddReaction(other emoji): %v", err)
	}

	users, err := database.GetReactionUsers(context.Background(), msgID, "👍", 100)
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("len(users) = %d, want 2 (%+v)", len(users), users)
	}
	if users[0].Username != "reactsecond" || users[1].Username != "reactfirst" {
		t.Errorf("order = [%s %s], want [reactsecond reactfirst]", users[0].Username, users[1].Username)
	}
	if users[0].ID != second {
		t.Errorf("users[0].ID = %d, want %d", users[0].ID, second)
	}
}

func TestGetReactionUsers_UnknownEmojiIsEmptyNotError(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "reactempty")
	userID := seedUser(t, database, "reactnone")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hi", nil)

	users, err := database.GetReactionUsers(context.Background(), msgID, "🐉", 100)
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(users) != 0 {
		t.Errorf("len(users) = %d, want 0", len(users))
	}
}

func TestGetReactionUsers_ClampsLimitToMax(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "reactclamp")
	author := seedUser(t, database, "clampauthor")
	msgID, _ := database.CreateMessage(context.Background(), chID, author, "many", nil)

	const reactors = db.MaxReactionUsers + 5
	for i := range reactors {
		uid := seedUser(t, database, "clamper"+strconv.Itoa(i))
		if err := database.AddReaction(context.Background(), msgID, uid, "👍"); err != nil {
			t.Fatalf("AddReaction(%d): %v", i, err)
		}
	}

	// A caller asking for more than the cap still gets at most the cap.
	users, err := database.GetReactionUsers(context.Background(), msgID, "👍", 10_000)
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(users) != db.MaxReactionUsers {
		t.Errorf("len(users) = %d, want %d", len(users), db.MaxReactionUsers)
	}

	// A non-positive limit means "the cap", not "nothing".
	users, err = database.GetReactionUsers(context.Background(), msgID, "👍", 0)
	if err != nil {
		t.Fatalf("GetReactionUsers(0): %v", err)
	}
	if len(users) != db.MaxReactionUsers {
		t.Errorf("len(users) with limit 0 = %d, want %d", len(users), db.MaxReactionUsers)
	}
}

func TestGetReactionUsers_RespectsSmallerLimit(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "reactsmall")
	author := seedUser(t, database, "smallauthor")
	msgID, _ := database.CreateMessage(context.Background(), chID, author, "some", nil)
	for i := range 5 {
		uid := seedUser(t, database, "smaller"+strconv.Itoa(i))
		_ = database.AddReaction(context.Background(), msgID, uid, "👍")
	}

	users, err := database.GetReactionUsers(context.Background(), msgID, "👍", 2)
	if err != nil {
		t.Fatalf("GetReactionUsers: %v", err)
	}
	if len(users) != 2 {
		t.Errorf("len(users) = %d, want 2", len(users))
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
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, _ := database.CreateMessage(context.Background(), ch.ID, bob, "hey", nil)
	if err := database.IncrementMentionCounts(context.Background(), ch.ID, msgID, []int64{alice}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	counts, err := database.GetChannelUnreadCounts(context.Background(), alice)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
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
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	_, _ = database.CreateMessage(context.Background(), ch.ID, bob, "private", nil)

	counts, err := database.GetChannelUnreadCounts(context.Background(), outsider)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	if _, ok := counts[ch.ID]; ok {
		t.Errorf("DM channel %d leaked into a non-participant's unread counts", ch.ID)
	}
}
