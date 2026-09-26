package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// OC-0454: the send path advances the author's read state inside the
// message transaction instead of taking a second writer checkout after the
// commit. These lock that the insert alone leaves the author read up to their
// own message, on both insert paths.

func assertReadState(t *testing.T, database *db.DB, userID, channelID, want int64) {
	t.Helper()
	got, _, found, err := database.GetReadState(context.Background(), userID, channelID)
	if err != nil {
		t.Fatalf("GetReadState(%d, %d): %v", userID, channelID, err)
	}
	if !found || got != want {
		t.Fatalf("read state for user %d = %d (found %v), want %d", userID, got, found, want)
	}
}

func TestCreateMessageWithMentions_AdvancesAuthorReadState(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msg, err := database.CreateMessageWithMentions(ctx, 1, 1, "hi @bob", nil, []int64{2}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	assertReadState(t, database, 1, 1, msg.ID)

	// Only the author: the mentioned recipient still has it unread.
	if _, _, found, err := database.GetReadState(ctx, 2, 1); err != nil || found {
		t.Fatalf("recipient read state found=%v err=%v, want no row", found, err)
	}
}

func TestCreateMessageDelivery_AdvancesAuthorReadStateOnlyOnInsert(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	author := seedUser(t, database, "alice")
	other := seedUser(t, database, "bob")
	channel := seedChannel(t, database, "general")

	p := storageDeliveryParams(author, channel)
	first, err := database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatalf("CreateMessageDelivery: %v", err)
	}
	assertReadState(t, database, author, channel, first.Message.ID)

	// The author reads past a later message; a duplicate retry of the first
	// send must not drag the read state back to it.
	later, err := database.CreateMessageWithMentions(ctx, channel, other, "later", nil, nil, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.UpdateReadState(ctx, author, channel, later.ID); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}
	retry, err := database.CreateMessageDelivery(ctx, p)
	if err != nil {
		t.Fatalf("retry CreateMessageDelivery: %v", err)
	}
	if !retry.Duplicate {
		t.Fatalf("retry = %+v, want a duplicate", retry)
	}
	assertReadState(t, database, author, channel, later.ID)
}
