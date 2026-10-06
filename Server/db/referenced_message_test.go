package db_test

import (
	"context"
	"strings"
	"testing"
)

func TestGetMessagesForAPI_ReferencedMessageSnippet(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	ch := seedChannel(t, database, "general")

	parent, _ := database.CreateMessage(ctx, ch, alice, strings.Repeat("x", 150), nil)
	reply, _ := database.CreateMessage(ctx, ch, bob, "re", &parent)
	plain, _ := database.CreateMessage(ctx, ch, bob, "no reply", nil)

	msgs, err := database.GetMessagesForAPI(ctx, ch, 0, 50, bob)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[int64]int{}
	for i, m := range msgs {
		byID[m.ID] = i
	}
	ref := msgs[byID[reply]].ReferencedMessage
	if ref == nil || ref.ID != parent || ref.Deleted || ref.User == nil || ref.User.Username != "alice" {
		t.Fatalf("referenced_message = %+v", ref)
	}
	if got := len([]rune(ref.Content)); got != 100 {
		t.Errorf("snippet runes = %d, want 100", got)
	}
	if msgs[byID[plain]].ReferencedMessage != nil {
		t.Error("a non-reply must have a nil referenced_message")
	}
}

func TestGetMessagesForAPI_ReferencedMessageRedactedWhenParentDeleted(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	ch := seedChannel(t, database, "general")

	parent, _ := database.CreateMessage(ctx, ch, alice, "secret", nil)
	reply, _ := database.CreateMessage(ctx, ch, alice, "re", &parent)
	if err := database.DeleteMessage(ctx, parent, alice, false); err != nil {
		t.Fatal(err)
	}

	msgs, err := database.GetMessagesForAPI(ctx, ch, 0, 50, alice)
	if err != nil {
		t.Fatal(err)
	}
	ref := msgs[0].ReferencedMessage
	if msgs[0].ID != reply || ref == nil || !ref.Deleted || ref.Content != "" || ref.User != nil || ref.HasAttachments {
		t.Fatalf("deleted parent must be redacted, got %+v", ref)
	}
}

func TestGetMessagesForAPI_ReferencedMessageNeverCrossesChannels(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	chA := seedChannel(t, database, "a")
	chB := seedChannel(t, database, "b")

	parent, _ := database.CreateMessage(ctx, chA, alice, "private to a", nil)
	_, _ = database.CreateMessage(ctx, chB, alice, "re", &parent)

	msgs, err := database.GetMessagesForAPI(ctx, chB, 0, 50, alice)
	if err != nil {
		t.Fatal(err)
	}
	if msgs[0].ReferencedMessage != nil {
		t.Fatalf("cross-channel reply_to leaked %+v", msgs[0].ReferencedMessage)
	}
}

func TestGetMessagesAroundAndPinned_ReferencedMessage(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	ch := seedChannel(t, database, "general")

	parent, _ := database.CreateMessage(ctx, ch, alice, "old", nil)
	reply, _ := database.CreateMessage(ctx, ch, alice, "re", &parent)
	if err := database.SetMessagePinned(ctx, reply, true); err != nil {
		t.Fatal(err)
	}

	around, err := database.GetMessagesAroundForAPI(ctx, ch, reply, 0, 0, alice)
	if err != nil || len(around) != 1 || around[0].ReferencedMessage == nil || around[0].ReferencedMessage.ID != parent {
		t.Fatalf("around: %v %+v", err, around)
	}
	pins, err := database.GetPinnedMessages(ctx, ch, alice)
	if err != nil || len(pins) != 1 || pins[0].ReferencedMessage == nil || pins[0].ReferencedMessage.ID != parent {
		t.Fatalf("pins: %v %+v", err, pins)
	}
}
