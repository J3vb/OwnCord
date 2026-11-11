package db_test

import (
	"context"
	"slices"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── GetMessagesForAPI ──────────────────────────────────────────────────────

func TestGetMessagesForAPI_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	chID := seedChannel(t, database, "apichan")
	userID := seedUser(t, database, "apiuser")

	msgs, err := database.GetMessagesForAPI(context.Background(), chID, 0, 50, userID)
	mustDo(t, "GetMessagesForAPI", err)
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
	mustDo(t, "GetMessagesForAPI", err)
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
	mustDo(t, "GetMessagesForAPI with before", err)
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
	mustDo(t, "GetMessagesForAPI", err)
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
	mustDo(t, "GetMessagesForAPI", err)
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
	mustDo(t, "GetMessagesAroundForAPI", err)
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
	mustDo(t, "GetMessagesAroundForAPI(first)", err)
	if len(first) != 4 || first[0].ID != ids[0] {
		t.Errorf("window at the first message = %d entries starting at %d, want 4 starting at %d",
			len(first), first[0].ID, ids[0])
	}

	last, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[3], 10, 10, userID)
	mustDo(t, "GetMessagesAroundForAPI(last)", err)
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
	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), ids[1], userID, false))

	msgs, err := database.GetMessagesAroundForAPI(context.Background(), chID, ids[2], 5, 5, userID)
	mustDo(t, "GetMessagesAroundForAPI", err)
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
	mustDo(t, "GetMessagesAroundForAPI", err)
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
	mustDo(t, "GetMessagesAroundForAPI", err)
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
	mustDo(t, "GetMessagesAroundForAPI", err)
	// Nothing is <= the centre in this channel below it, and nothing above it.
	if len(msgs) != 3 {
		t.Errorf("window size = %d; an out-of-range centre should still be bounded by the channel", len(msgs))
	}
}

// ─── GetMessagesAfterForAPI ─────────────────────────────────────────────────

func TestGetMessagesAfterForAPI_AscendingAfterCursor(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "afteru1")
	chID := seedChannel(t, database, "afterc1")
	otherCh := seedChannel(t, database, "afterc2")
	ids := seedAroundMessages(t, database, chID, userID, 10)
	seedAroundMessages(t, database, otherCh, userID, 3) // newer ids in another channel
	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), ids[6], userID, false))

	msgs, err := database.GetMessagesAfterForAPI(context.Background(), chID, ids[4], 3, userID)
	mustDo(t, "GetMessagesAfterForAPI", err)
	// Oldest-first, strictly after the cursor, deleted row skipped, capped at 3.
	want := []int64{ids[5], ids[7], ids[8]}
	got := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		got = append(got, m.ID)
	}
	if !slices.Equal(got, want) {
		t.Errorf("page = %v, want %v", got, want)
	}

	none, err := database.GetMessagesAfterForAPI(context.Background(), chID, ids[9], 5, userID)
	mustDo(t, "GetMessagesAfterForAPI(newest)", err)
	if len(none) != 0 {
		t.Errorf("page after the newest = %d rows, want 0", len(none))
	}
}
