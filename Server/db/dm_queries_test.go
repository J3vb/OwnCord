package db_test

import (
	"testing"
)

// ─── GetOrCreateDMChannel ───────────────────────────────────────────────────

func TestGetOrCreateDMChannel_CreatesNew(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, created, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if !created {
		t.Error("expected created=true for new DM channel")
	}
	if ch == nil {
		t.Fatal("expected channel, got nil")
	}
	if ch.Type != "dm" {
		t.Errorf("Type = %q, want 'dm'", ch.Type)
	}
	if ch.ID <= 0 {
		t.Errorf("expected positive channel ID, got %d", ch.ID)
	}
}

func TestGetOrCreateDMChannel_Idempotent(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch1, created1, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("first GetOrCreateDMChannel: %v", err)
	}
	if !created1 {
		t.Error("expected created=true on first call")
	}

	ch2, created2, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("second GetOrCreateDMChannel: %v", err)
	}
	if created2 {
		t.Error("expected created=false on second call")
	}
	if ch1.ID != ch2.ID {
		t.Errorf("channel IDs differ: %d vs %d", ch1.ID, ch2.ID)
	}
}

func TestGetOrCreateDMChannel_IdempotentReversedOrder(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch1, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel(u1,u2): %v", err)
	}

	// Reversed argument order should find the same channel.
	ch2, created, err := database.GetOrCreateDMChannel(user2, user1)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel(u2,u1): %v", err)
	}
	if created {
		t.Error("expected created=false when called with reversed user order")
	}
	if ch1.ID != ch2.ID {
		t.Errorf("channel IDs differ: %d vs %d", ch1.ID, ch2.ID)
	}
}

func TestGetOrCreateDMChannel_ReopensForCaller(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// Close the DM for user1.
	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	// Verify user1 no longer sees it.
	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 0 {
		t.Errorf("expected 0 open DMs after close, got %d", len(dms))
	}

	// Call GetOrCreateDMChannel again — should re-open for user1.
	ch2, created, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel after close: %v", err)
	}
	if created {
		t.Error("expected created=false (reuse existing channel)")
	}
	if ch2.ID != ch.ID {
		t.Errorf("expected same channel ID %d, got %d", ch.ID, ch2.ID)
	}

	// User1 should now see the DM again.
	dms, err = database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels after reopen: %v", err)
	}
	if len(dms) != 1 {
		t.Errorf("expected 1 open DM after reopen, got %d", len(dms))
	}
}

// ─── GetUserDMChannels ──────────────────────────────────────────────────────

func TestGetUserDMChannels_EmptyList(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 0 {
		t.Errorf("expected 0 DMs, got %d", len(dms))
	}
}

func TestGetUserDMChannels_ReturnsOpenDMs(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")
	user3 := seedUser(t, database, "charlie")

	_, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel(u1,u2): %v", err)
	}
	_, _, err = database.GetOrCreateDMChannel(user1, user3)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel(u1,u3): %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 2 {
		t.Fatalf("expected 2 DMs, got %d", len(dms))
	}

	// Verify recipient info is correct (one should be bob, one charlie).
	names := map[string]bool{}
	for _, dm := range dms {
		names[dm.Recipient.Username] = true
	}
	if !names["bob"] {
		t.Error("expected recipient 'bob' in DMs")
	}
	if !names["charlie"] {
		t.Error("expected recipient 'charlie' in DMs")
	}
}

func TestGetUserDMChannels_ExcludesClosedDMs(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 0 {
		t.Errorf("expected 0 DMs after close, got %d", len(dms))
	}

	// User2 should still see the DM (only user1 closed it).
	dms2, err := database.GetUserDMChannels(user2)
	if err != nil {
		t.Fatalf("GetUserDMChannels(user2): %v", err)
	}
	if len(dms2) != 1 {
		t.Errorf("expected 1 DM for user2, got %d", len(dms2))
	}
}

func TestGetUserDMChannels_UnreadCount(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// Send 3 messages from user2 in the DM channel.
	msg1, err := database.CreateMessage(ch.ID, user2, "hello", nil)
	if err != nil {
		t.Fatalf("CreateMessage 1: %v", err)
	}
	_, err = database.CreateMessage(ch.ID, user2, "how are you", nil)
	if err != nil {
		t.Fatalf("CreateMessage 2: %v", err)
	}
	_, err = database.CreateMessage(ch.ID, user2, "anyone there?", nil)
	if err != nil {
		t.Fatalf("CreateMessage 3: %v", err)
	}

	// Mark user1 as having read only the first message.
	if err := database.UpdateReadState(user1, ch.ID, msg1); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 {
		t.Fatalf("expected 1 DM, got %d", len(dms))
	}
	if dms[0].UnreadCount != 2 {
		t.Errorf("UnreadCount = %d, want 2", dms[0].UnreadCount)
	}
}

func TestGetUserDMChannels_NoMessages(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	_, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 {
		t.Fatalf("expected 1 DM, got %d", len(dms))
	}
	if dms[0].LastMessageID != nil {
		t.Errorf("expected nil LastMessageID, got %d", *dms[0].LastMessageID)
	}
	if dms[0].UnreadCount != 0 {
		t.Errorf("UnreadCount = %d, want 0", dms[0].UnreadCount)
	}
}

func TestGetUserDMChannels_LastMessagePreview(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	_, err = database.CreateMessage(ch.ID, user2, "first message", nil)
	if err != nil {
		t.Fatalf("CreateMessage 1: %v", err)
	}
	lastMsgID, err := database.CreateMessage(ch.ID, user2, "latest message", nil)
	if err != nil {
		t.Fatalf("CreateMessage 2: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 {
		t.Fatalf("expected 1 DM, got %d", len(dms))
	}
	if dms[0].LastMessageID == nil {
		t.Fatal("expected non-nil LastMessageID")
	}
	if *dms[0].LastMessageID != lastMsgID {
		t.Errorf("LastMessageID = %d, want %d", *dms[0].LastMessageID, lastMsgID)
	}
	if dms[0].LastMessage != "latest message" {
		t.Errorf("LastMessage = %q, want 'latest message'", dms[0].LastMessage)
	}
}

// ─── IsDMParticipant ────────────────────────────────────────────────────────

func TestIsDMParticipant_ValidParticipant(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	ok, err := database.IsDMParticipant(user1, ch.ID)
	if err != nil {
		t.Fatalf("IsDMParticipant(user1): %v", err)
	}
	if !ok {
		t.Error("expected true for user1")
	}

	ok, err = database.IsDMParticipant(user2, ch.ID)
	if err != nil {
		t.Fatalf("IsDMParticipant(user2): %v", err)
	}
	if !ok {
		t.Error("expected true for user2")
	}
}

func TestIsDMParticipant_NonParticipant(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")
	user3 := seedUser(t, database, "charlie")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	ok, err := database.IsDMParticipant(user3, ch.ID)
	if err != nil {
		t.Fatalf("IsDMParticipant(user3): %v", err)
	}
	if ok {
		t.Error("expected false for non-participant user3")
	}
}

func TestIsDMParticipant_NonExistentChannel(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")

	ok, err := database.IsDMParticipant(user1, 99999)
	if err != nil {
		t.Fatalf("IsDMParticipant: %v", err)
	}
	if ok {
		t.Error("expected false for non-existent channel")
	}
}

// ─── OpenDM / CloseDM ──────────────────────────────────────────────────────

func TestOpenDM_Idempotent(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// Already open from creation — opening again should not error.
	if err := database.OpenDM(user1, ch.ID); err != nil {
		t.Errorf("OpenDM (idempotent) error: %v", err)
	}

	// Should still have exactly 1 DM.
	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 {
		t.Errorf("expected 1 DM after idempotent open, got %d", len(dms))
	}
}

func TestCloseDM_RemovesFromOpenList(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 0 {
		t.Errorf("expected 0 DMs after close, got %d", len(dms))
	}
}

func TestCloseDM_Idempotent(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// Close twice — should not error.
	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Errorf("first CloseDM error: %v", err)
	}
	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Errorf("second CloseDM (idempotent) error: %v", err)
	}
}

func TestOpenDM_AfterClose(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	if err := database.CloseDM(user1, ch.ID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	if err := database.OpenDM(user1, ch.ID); err != nil {
		t.Fatalf("OpenDM after close: %v", err)
	}

	dms, err := database.GetUserDMChannels(user1)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 {
		t.Errorf("expected 1 DM after reopen, got %d", len(dms))
	}
}

// ─── GetDMParticipantIDs ────────────────────────────────────────────────────

func TestGetDMParticipantIDs_ReturnsBoth(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	ids, err := database.GetDMParticipantIDs(ch.ID)
	if err != nil {
		t.Fatalf("GetDMParticipantIDs: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 participant IDs, got %d", len(ids))
	}

	idSet := map[int64]bool{ids[0]: true, ids[1]: true}
	if !idSet[user1] {
		t.Errorf("expected user1 ID %d in participants", user1)
	}
	if !idSet[user2] {
		t.Errorf("expected user2 ID %d in participants", user2)
	}
}

func TestGetDMParticipantIDs_NonExistentChannel(t *testing.T) {
	database := openMigratedMemory(t)

	ids, err := database.GetDMParticipantIDs(99999)
	if err != nil {
		t.Fatalf("GetDMParticipantIDs: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected 0 IDs for non-existent channel, got %d", len(ids))
	}
}

// ─── GetDMRecipient ─────────────────────────────────────────────────────────

func TestGetDMRecipient_ReturnsOtherUser(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")
	user2 := seedUser(t, database, "bob")

	ch, _, err := database.GetOrCreateDMChannel(user1, user2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// From user1's perspective, recipient should be user2.
	recipient, err := database.GetDMRecipient(ch.ID, user1)
	if err != nil {
		t.Fatalf("GetDMRecipient(user1): %v", err)
	}
	if recipient == nil {
		t.Fatal("expected recipient, got nil")
	}
	if recipient.ID != user2 {
		t.Errorf("recipient ID = %d, want %d", recipient.ID, user2)
	}
	if recipient.Username != "bob" {
		t.Errorf("recipient Username = %q, want 'bob'", recipient.Username)
	}

	// From user2's perspective, recipient should be user1.
	recipient2, err := database.GetDMRecipient(ch.ID, user2)
	if err != nil {
		t.Fatalf("GetDMRecipient(user2): %v", err)
	}
	if recipient2 == nil {
		t.Fatal("expected recipient, got nil")
	}
	if recipient2.ID != user1 {
		t.Errorf("recipient ID = %d, want %d", recipient2.ID, user1)
	}
	if recipient2.Username != "alice" {
		t.Errorf("recipient Username = %q, want 'alice'", recipient2.Username)
	}
}

func TestGetDMRecipient_NonExistentChannel(t *testing.T) {
	database := openMigratedMemory(t)
	user1 := seedUser(t, database, "alice")

	recipient, err := database.GetDMRecipient(99999, user1)
	if err != nil {
		t.Fatalf("GetDMRecipient: %v", err)
	}
	if recipient != nil {
		t.Errorf("expected nil for non-existent channel, got user ID %d", recipient.ID)
	}
}
