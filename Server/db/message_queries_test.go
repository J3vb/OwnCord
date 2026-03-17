package db_test

import (
	"testing"

	"github.com/owncord/server/db"
)

// seedUser inserts a minimal test user and returns its ID.
func seedUser(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(username, "hash", 4)
	if err != nil {
		t.Fatalf("seedUser(%q): %v", username, err)
	}
	return id
}

// seedChannel inserts a minimal test channel and returns its ID.
func seedChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "text", "", "", 0)
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

	id, err := database.CreateMessage(chID, userID, "hello", nil)
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

	parentID, _ := database.CreateMessage(chID, userID, "parent", nil)
	replyID, err := database.CreateMessage(chID, userID, "reply", &parentID)
	if err != nil {
		t.Fatalf("CreateMessage with reply: %v", err)
	}

	msg, _ := database.GetMessage(replyID)
	if msg.ReplyTo == nil || *msg.ReplyTo != parentID {
		t.Errorf("ReplyTo = %v, want %d", msg.ReplyTo, parentID)
	}
}

func TestCreateMessage_ContentPreserved(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "bob")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(chID, userID, "test content", nil)
	msg, _ := database.GetMessage(id)
	if msg.Content != "test content" {
		t.Errorf("Content = %q, want 'test content'", msg.Content)
	}
}

// ─── GetMessage ───────────────────────────────────────────────────────────────

func TestGetMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	msg, err := database.GetMessage(9999)
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

	id, _ := database.CreateMessage(chID, userID, "hello world", nil)

	msg, err := database.GetMessage(id)
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

	msgs, err := database.GetMessages(chID, 0, 50)
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
		_, err := database.CreateMessage(chID, userID, "msg", nil)
		if err != nil {
			t.Fatalf("CreateMessage %d: %v", i, err)
		}
	}

	msgs, err := database.GetMessages(chID, 0, 50)
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
		_, _ = database.CreateMessage(chID, userID, "msg", nil)
	}

	msgs, _ := database.GetMessages(chID, 0, 5)
	if len(msgs) != 5 {
		t.Errorf("expected 5 messages (limit), got %d", len(msgs))
	}
}

func TestGetMessages_BeforePagination(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "frank")
	chID := seedChannel(t, database, "ch")

	var ids []int64
	for range 5 {
		id, _ := database.CreateMessage(chID, userID, "msg", nil)
		ids = append(ids, id)
	}

	// Get messages before the 4th message (should get 3 messages: ids 0,1,2).
	msgs, _ := database.GetMessages(chID, ids[3], 50)
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages before id %d, got %d", ids[3], len(msgs))
	}
}

func TestGetMessages_IncludesUsername(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "grace")
	chID := seedChannel(t, database, "ch")

	_, _ = database.CreateMessage(chID, userID, "hi", nil)
	msgs, _ := database.GetMessages(chID, 0, 50)

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

	id, _ := database.CreateMessage(chID, userID, "original", nil)

	if err := database.EditMessage(id, userID, "updated"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}

	msg, _ := database.GetMessage(id)
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

	id, _ := database.CreateMessage(chID, ownerID, "original", nil)

	err := database.EditMessage(id, otherID, "hacked")
	if err == nil {
		t.Error("EditMessage by non-owner should return error")
	}
}

func TestEditMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "kim")

	err := database.EditMessage(9999, userID, "x")
	if err == nil {
		t.Error("EditMessage non-existent should return error")
	}
}

// ─── DeleteMessage ────────────────────────────────────────────────────────────

func TestDeleteMessage_OwnerCanDelete(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "larry")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(chID, userID, "bye", nil)

	if err := database.DeleteMessage(id, userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	msg, _ := database.GetMessage(id)
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

	id, _ := database.CreateMessage(chID, userID, "sensitive", nil)
	_ = database.DeleteMessage(id, userID, false)

	msg, _ := database.GetMessage(id)
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

	id, _ := database.CreateMessage(chID, ownerID, "msg", nil)

	err := database.DeleteMessage(id, otherID, false)
	if err == nil {
		t.Error("DeleteMessage by non-owner non-mod should return error")
	}
}

func TestDeleteMessage_ModCanDeleteAny(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "pete")
	modID := seedUser(t, database, "quinn")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(chID, ownerID, "msg", nil)

	if err := database.DeleteMessage(id, modID, true); err != nil {
		t.Fatalf("DeleteMessage by mod: %v", err)
	}

	msg, _ := database.GetMessage(id)
	if !msg.Deleted {
		t.Error("expected Deleted=true after mod delete")
	}
}

func TestDeleteMessage_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "rachel")

	err := database.DeleteMessage(9999, userID, true)
	if err == nil {
		t.Error("DeleteMessage non-existent should return error")
	}
}

// ─── Reactions ────────────────────────────────────────────────────────────────

func TestAddReaction_Success(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "sam")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "hi", nil)

	if err := database.AddReaction(msgID, userID, "👍"); err != nil {
		t.Fatalf("AddReaction: %v", err)
	}
}

func TestAddReaction_UniqueConstraint(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "tina")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "hi", nil)

	_ = database.AddReaction(msgID, userID, "❤️")
	err := database.AddReaction(msgID, userID, "❤️")
	if err == nil {
		t.Error("adding duplicate reaction should return error")
	}
}

func TestRemoveReaction_Success(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "uma")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "hi", nil)

	_ = database.AddReaction(msgID, userID, "😂")
	if err := database.RemoveReaction(msgID, userID, "😂"); err != nil {
		t.Fatalf("RemoveReaction: %v", err)
	}
}

func TestRemoveReaction_NotFound(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "victor")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "hi", nil)

	err := database.RemoveReaction(msgID, userID, "🔥")
	if err == nil {
		t.Error("removing non-existent reaction should return error")
	}
}

func TestGetReactions_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "wendy")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "hi", nil)

	counts, err := database.GetReactions(msgID)
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
	msgID, _ := database.CreateMessage(chID, u1, "hi", nil)

	_ = database.AddReaction(msgID, u1, "👍")
	_ = database.AddReaction(msgID, u2, "👍")
	_ = database.AddReaction(msgID, u1, "❤️")

	counts, _ := database.GetReactions(msgID)
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

	_, _ = database.CreateMessage(chID, userID, "hello world fts test", nil)
	_, _ = database.CreateMessage(chID, userID, "unrelated content here", nil)

	results, err := database.SearchMessages("hello", nil, 10)
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

	_, _ = database.CreateMessage(ch1, userID, "needle in channel 1", nil)
	_, _ = database.CreateMessage(ch2, userID, "needle in channel 2", nil)

	results, _ := database.SearchMessages("needle", &ch1, 10)
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
	_, _ = database.CreateMessage(chID, userID, "hello there", nil)

	results, _ := database.SearchMessages("xyzzy", nil, 10)
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestSearchMessages_LimitRespected(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "carl")
	chID := seedChannel(t, database, "ch")

	for range 5 {
		_, _ = database.CreateMessage(chID, userID, "searchable keyword content", nil)
	}

	results, _ := database.SearchMessages("keyword", nil, 3)
	if len(results) != 3 {
		t.Errorf("expected 3 results (limit), got %d", len(results))
	}
}

func TestSearchMessages_DeletedNotReturned(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "diana")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(chID, userID, "vanishing keyword message", nil)
	_ = database.DeleteMessage(id, userID, false)

	results, _ := database.SearchMessages("vanishing", nil, 10)
	if len(results) != 0 {
		t.Errorf("expected 0 results (deleted excluded), got %d", len(results))
	}
}

// ─── UpdateReadState ──────────────────────────────────────────────────────────

func TestUpdateReadState_Upsert(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "ella")
	chID := seedChannel(t, database, "ch")
	msgID, _ := database.CreateMessage(chID, userID, "msg", nil)

	if err := database.UpdateReadState(userID, chID, msgID); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	// Update again with higher message ID — should not error.
	msgID2, _ := database.CreateMessage(chID, userID, "msg2", nil)
	if err := database.UpdateReadState(userID, chID, msgID2); err != nil {
		t.Fatalf("UpdateReadState second call: %v", err)
	}
}
