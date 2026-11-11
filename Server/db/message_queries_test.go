package db_test

import (
	"context"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
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

// seedChannelRawSQL inserts a text channel with plain SQL, so it works against
// a schema older than the current writers expect (a test that migrates only up
// to some version and then seeds). seedChannel uses the generated writer, which
// names columns a partly migrated database may not have yet.
func seedChannelRawSQL(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (name, type) VALUES (?, 'text')`, name)
	if err != nil {
		t.Fatalf("seedChannelRawSQL(%q): %v", name, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("seedChannelRawSQL(%q) id: %v", name, err)
	}
	return id
}

// ─── CreateMessage ────────────────────────────────────────────────────────────

func TestCreateMessage_ReturnsID(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")
	chID := seedChannel(t, database, "general")

	id := mustCreateMessage(t, database, chID, userID, "hello", nil)
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}
}

func TestCreateMessage_WithReplyTo(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")
	chID := seedChannel(t, database, "general")

	parentID, _ := database.CreateMessage(context.Background(), chID, userID, "parent", nil)
	replyID := mustCreateMessage(t, database, chID, userID, "reply", &parentID)

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
	mustDo(t, "GetMessage", err)
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
	mustDo(t, "GetMessage", err)
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
	mustDo(t, "GetMessages", err)
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
	mustDo(t, "GetMessages", err)
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
	mustDo(t, "EditMessage", err)
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

	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), id, userID, false))

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

	mustDo(t, "DeleteMessage by mod", database.DeleteMessage(context.Background(), id, modID, true))

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
	mustDo(t, "PurgeChannelMessages", err)
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
	mustDo(t, "second purge", err)
	want := []int64{ids[2], ids[1], ids[0]}
	if !slices.Equal(got, want) {
		t.Fatalf("second purge ids = %v, want %v", got, want)
	}
}

func TestPurgeChannelMessages_BeforeCursor(t *testing.T) {
	database, chID, ids := purgeSeed(t, 5)

	got, err := database.PurgeChannelMessages(context.Background(), chID, ids[2], 10)
	mustDo(t, "PurgeChannelMessages", err)
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
	mustDo(t, "zero limit", err)
	if len(got) != 0 {
		t.Fatalf("zero limit purged %v, want none", got)
	}

	emptyCh := seedChannel(t, database, "empty")
	got, err = database.PurgeChannelMessages(context.Background(), emptyCh, 0, 50)
	mustDo(t, "empty channel", err)
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

	mustDo(t, "AddReaction", database.AddReaction(context.Background(), msgID, userID, "👍"))
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
	mustDo(t, "RemoveReaction", database.RemoveReaction(context.Background(), msgID, userID, "😂"))
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
	mustDo(t, "GetReactions", err)
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

// ─── GetReactionUsers ───────────────────────────────────────────────────────

func TestGetReactionUsers_ReturnsReactorsInReactionOrder(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "reactusers")
	author := seedUser(t, database, "reactauthor")
	first := seedUser(t, database, "reactfirst")
	second := seedUser(t, database, "reactsecond")
	msgID, _ := database.CreateMessage(context.Background(), chID, author, "react to me", nil)

	// second reacts before first, so reaction order (not user id) decides.
	mustDo(t, "AddReaction(second)", database.AddReaction(context.Background(), msgID, second, "👍"))
	mustDo(t, "AddReaction(first)", database.AddReaction(context.Background(), msgID, first, "👍"))
	// A different emoji on the same message must not leak in.
	mustDo(t, "AddReaction(other emoji)", database.AddReaction(context.Background(), msgID, author, "🎉"))

	users, err := database.GetReactionUsers(context.Background(), msgID, "👍", 100)
	mustDo(t, "GetReactionUsers", err)
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
	mustDo(t, "GetReactionUsers", err)
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
	mustDo(t, "GetReactionUsers", err)
	if len(users) != db.MaxReactionUsers {
		t.Errorf("len(users) = %d, want %d", len(users), db.MaxReactionUsers)
	}

	// A non-positive limit means "the cap", not "nothing".
	users, err = database.GetReactionUsers(context.Background(), msgID, "👍", 0)
	mustDo(t, "GetReactionUsers(0)", err)
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
	mustDo(t, "GetReactionUsers", err)
	if len(users) != 2 {
		t.Errorf("len(users) = %d, want 2", len(users))
	}
}

// ─── GetPinnedMessages ────────────────────────────────────────────────────────

// TestGetPinnedMessages_Capped pins more messages than db.MaxPinnedMessages and
// verifies the query stays bounded instead of returning every pinned row. An
// uncapped GetPinnedMessages feeds an unbounded message-ID slice into the
// shared IN-list batch fetches (reactions/attachments/mentions); past
// SQLite's ~32766 bound-parameter limit that fails every call permanently
// ("too many SQL variables"). This pins the cap well below that ceiling.
func TestGetPinnedMessages_Capped(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pinner")
	chID := seedChannel(t, database, "pins")

	// One pin through the API, the rest set-based: a thousand round trips each
	// way cost seconds under the race detector.
	first := mustCreateMessage(t, database, chID, userID, "msg", nil)
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: first, Pinned: true, UserID: 1}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}
	total := db.MaxPinnedMessages + 5
	if _, err := database.ExecContext(context.Background(), `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
		INSERT INTO messages (channel_id, user_id, content, pinned, pinned_at)
		SELECT ?, ?, 'msg', 1, datetime('now', printf('+%d seconds', i)) FROM s`, total-1, chID, userID); err != nil {
		t.Fatalf("seed pinned messages: %v", err)
	}

	msgs, err := database.GetPinnedMessages(context.Background(), chID, userID)
	mustDo(t, "GetPinnedMessages", err)
	// One row past the cap is returned so the caller can report truncation.
	if len(msgs) != db.MaxPinnedMessages+1 {
		t.Errorf("GetPinnedMessages returned %d pins, want MaxPinnedMessages+1 (%d)", len(msgs), db.MaxPinnedMessages+1)
	}
}

// TestGetPinnedMessages_OrdersByPinRecency pins an older message AFTER a newer
// one and checks the newer pin sorts first (F5). Ordering by message id put the
// newer pin at the bottom.
func TestGetPinnedMessages_OrdersByPinRecency(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pinorder")
	chID := seedChannel(t, database, "pinsorder")

	first := mustCreateMessage(t, database, chID, userID, "older message", nil)
	second := mustCreateMessage(t, database, chID, userID, "newer message", nil)

	// Pin the NEWER message first, then the OLDER one, so message-id order and
	// pin-recency order disagree.
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: second, Pinned: true, UserID: 1}); err != nil {
		t.Fatalf("pin second: %v", err)
	}
	// Windows' wall clock ticks coarsely, so two back-to-back pins can share a
	// stamp and tie. Wait for the clock to advance so the pins are ordered.
	for start := time.Now().UnixNano(); time.Now().UnixNano() == start; {
		time.Sleep(time.Millisecond)
	}
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: first, Pinned: true, UserID: 1}); err != nil {
		t.Fatalf("pin first: %v", err)
	}

	msgs, err := database.GetPinnedMessages(context.Background(), chID, userID)
	mustDo(t, "GetPinnedMessages", err)
	if len(msgs) != 2 {
		t.Fatalf("got %d pins, want 2", len(msgs))
	}
	if msgs[0].ID != first {
		t.Errorf("most-recently-pinned should sort first: got id %d, want %d", msgs[0].ID, first)
	}
}
