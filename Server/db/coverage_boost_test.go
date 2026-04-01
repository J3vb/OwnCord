package db_test

import (
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// ─── JoinVoiceChannelIfCapacity ─────────────────────────────────────────────

func TestVoice_JoinVoiceChannelIfCapacity_UnderLimit(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cap-u1")
	chanID := seedVoiceChannel(t, database, "cap-ch")

	err := database.JoinVoiceChannelIfCapacity(u1, chanID, 2)
	if err != nil {
		t.Fatalf("JoinVoiceChannelIfCapacity: %v", err)
	}

	state, err := database.GetVoiceState(u1)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil {
		t.Fatal("expected voice state after join")
	}
	if state.ChannelID != chanID {
		t.Errorf("ChannelID = %d, want %d", state.ChannelID, chanID)
	}
}

func TestVoice_JoinVoiceChannelIfCapacity_AtLimit(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cap-full1")
	u2 := seedVoiceUser(t, database, "cap-full2")
	u3 := seedVoiceUser(t, database, "cap-full3")
	chanID := seedVoiceChannel(t, database, "cap-full-ch")

	// Fill channel to capacity (max 2).
	if err := database.JoinVoiceChannelIfCapacity(u1, chanID, 2); err != nil {
		t.Fatalf("first join: %v", err)
	}
	if err := database.JoinVoiceChannelIfCapacity(u2, chanID, 2); err != nil {
		t.Fatalf("second join: %v", err)
	}

	// Third join should fail with ErrChannelFull.
	err := database.JoinVoiceChannelIfCapacity(u3, chanID, 2)
	if err == nil {
		t.Fatal("expected ErrChannelFull, got nil")
	}
	if err != db.ErrChannelFull {
		t.Errorf("error = %v, want ErrChannelFull", err)
	}
}

func TestVoice_JoinVoiceChannelIfCapacity_ReplacesOwnState(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cap-replace")
	ch1 := seedVoiceChannel(t, database, "cap-ch1")
	ch2 := seedVoiceChannel(t, database, "cap-ch2")

	// Join ch1, then join ch2 with capacity check — should replace.
	if err := database.JoinVoiceChannelIfCapacity(u1, ch1, 5); err != nil {
		t.Fatalf("join ch1: %v", err)
	}
	if err := database.JoinVoiceChannelIfCapacity(u1, ch2, 5); err != nil {
		t.Fatalf("join ch2: %v", err)
	}

	state, _ := database.GetVoiceState(u1)
	if state == nil || state.ChannelID != ch2 {
		t.Errorf("expected channel %d, got %v", ch2, state)
	}
}

// ─── GetAllVoiceStates ──────────────────────────────────────────────────────

func TestVoice_GetAllVoiceStates_Empty(t *testing.T) {
	database := newVoiceTestDB(t)

	states, err := database.GetAllVoiceStates()
	if err != nil {
		t.Fatalf("GetAllVoiceStates: %v", err)
	}
	if len(states) != 0 {
		t.Errorf("got %d states, want 0", len(states))
	}
}

func TestVoice_GetAllVoiceStates_MultipleChannels(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "all-vs-u1")
	u2 := seedVoiceUser(t, database, "all-vs-u2")
	u3 := seedVoiceUser(t, database, "all-vs-u3")
	ch1 := seedVoiceChannel(t, database, "all-vs-ch1")
	ch2 := seedVoiceChannel(t, database, "all-vs-ch2")

	_ = database.JoinVoiceChannel(u1, ch1)
	_ = database.JoinVoiceChannel(u2, ch1)
	_ = database.JoinVoiceChannel(u3, ch2)

	states, err := database.GetAllVoiceStates()
	if err != nil {
		t.Fatalf("GetAllVoiceStates: %v", err)
	}
	if len(states) != 3 {
		t.Errorf("got %d states, want 3", len(states))
	}
}

// ─── CountActiveCameras ─────────────────────────────────────────────────────

func TestVoice_CountActiveCameras_Zero(t *testing.T) {
	database := newVoiceTestDB(t)
	chanID := seedVoiceChannel(t, database, "cam-count-empty")

	count, err := database.CountActiveCameras(chanID)
	if err != nil {
		t.Fatalf("CountActiveCameras: %v", err)
	}
	if count != 0 {
		t.Errorf("count = %d, want 0", count)
	}
}

func TestVoice_CountActiveCameras_SomeCameras(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-cnt-u1")
	u2 := seedVoiceUser(t, database, "cam-cnt-u2")
	u3 := seedVoiceUser(t, database, "cam-cnt-u3")
	chanID := seedVoiceChannel(t, database, "cam-cnt-ch")

	_ = database.JoinVoiceChannel(u1, chanID)
	_ = database.JoinVoiceChannel(u2, chanID)
	_ = database.JoinVoiceChannel(u3, chanID)

	_ = database.UpdateVoiceCamera(u1, true)
	_ = database.UpdateVoiceCamera(u2, true)
	// u3 camera stays off.

	count, err := database.CountActiveCameras(chanID)
	if err != nil {
		t.Fatalf("CountActiveCameras: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
}

// ─── EnableCameraIfUnderLimit ───────────────────────────────────────────────

func TestVoice_EnableCameraIfUnderLimit_Success(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-limit-ok")
	chanID := seedVoiceChannel(t, database, "cam-limit-ch")

	_ = database.JoinVoiceChannel(u1, chanID)

	ok, err := database.EnableCameraIfUnderLimit(u1, chanID, 2)
	if err != nil {
		t.Fatalf("EnableCameraIfUnderLimit: %v", err)
	}
	if !ok {
		t.Error("expected camera to be enabled")
	}

	state, _ := database.GetVoiceState(u1)
	if state == nil || !state.Camera {
		t.Error("camera should be true after enable")
	}
}

func TestVoice_EnableCameraIfUnderLimit_AtLimit(t *testing.T) {
	database := newVoiceTestDB(t)
	u1 := seedVoiceUser(t, database, "cam-lim-u1")
	u2 := seedVoiceUser(t, database, "cam-lim-u2")
	u3 := seedVoiceUser(t, database, "cam-lim-u3")
	chanID := seedVoiceChannel(t, database, "cam-lim-ch")

	_ = database.JoinVoiceChannel(u1, chanID)
	_ = database.JoinVoiceChannel(u2, chanID)
	_ = database.JoinVoiceChannel(u3, chanID)

	// Enable cameras for u1 and u2 (max is 2).
	_, _ = database.EnableCameraIfUnderLimit(u1, chanID, 2)
	_, _ = database.EnableCameraIfUnderLimit(u2, chanID, 2)

	// u3 should be denied.
	ok, err := database.EnableCameraIfUnderLimit(u3, chanID, 2)
	if err != nil {
		t.Fatalf("EnableCameraIfUnderLimit: %v", err)
	}
	if ok {
		t.Error("expected camera to be denied at limit")
	}
}

// ─── SearchMessagesInChannels ───────────────────────────────────────────────

func TestSearchMessagesInChannels_FindsInAllowedChannels(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "srch-multi")
	ch1 := seedChannel(t, database, "srch-ch1")
	ch2 := seedChannel(t, database, "srch-ch2")
	ch3 := seedChannel(t, database, "srch-ch3")

	_, _ = database.CreateMessage(ch1, userID, "alpha keyword here", nil)
	_, _ = database.CreateMessage(ch2, userID, "beta keyword here", nil)
	_, _ = database.CreateMessage(ch3, userID, "gamma keyword here", nil)

	// Search only in ch1 and ch2.
	results, err := database.SearchMessagesInChannels("keyword", []int64{ch1, ch2}, 10)
	if err != nil {
		t.Fatalf("SearchMessagesInChannels: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results, got %d", len(results))
	}
	for _, r := range results {
		if r.ChannelID != ch1 && r.ChannelID != ch2 {
			t.Errorf("unexpected channel_id %d in results", r.ChannelID)
		}
	}
}

func TestSearchMessagesInChannels_EmptyQuery(t *testing.T) {
	database := openMigratedMemory(t)

	results, err := database.SearchMessagesInChannels("", []int64{1}, 10)
	if err != nil {
		t.Fatalf("SearchMessagesInChannels: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for empty query, got %d", len(results))
	}
}

func TestSearchMessagesInChannels_EmptyChannelIDs(t *testing.T) {
	database := openMigratedMemory(t)

	results, err := database.SearchMessagesInChannels("test", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessagesInChannels: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for no channels, got %d", len(results))
	}
}

func TestSearchMessagesInChannels_LimitRespected(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "srch-lim")
	ch1 := seedChannel(t, database, "srch-lim-ch")

	for range 5 {
		_, _ = database.CreateMessage(ch1, userID, "findme content here", nil)
	}

	results, err := database.SearchMessagesInChannels("findme", []int64{ch1}, 2)
	if err != nil {
		t.Fatalf("SearchMessagesInChannels: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results (limit), got %d", len(results))
	}
}

func TestSearchMessagesInChannels_ZeroLimit(t *testing.T) {
	database := openMigratedMemory(t)

	results, err := database.SearchMessagesInChannels("test", []int64{1}, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for zero limit, got %d", len(results))
	}
}

// ─── GetPinnedMessages ──────────────────────────────────────────────────────

func TestGetPinnedMessages_Empty(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pin-empty-u")
	chID := seedChannel(t, database, "pin-empty")

	msgs, err := database.GetPinnedMessages(chID, userID)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("expected 0 pinned messages, got %d", len(msgs))
	}
}

func TestGetPinnedMessages_ReturnsPinnedOnly(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pin-user")
	chID := seedChannel(t, database, "pin-ch")

	id1, _ := database.CreateMessage(chID, userID, "pinned msg", nil)
	_, _ = database.CreateMessage(chID, userID, "not pinned", nil)
	_ = database.SetMessagePinned(id1, true)

	msgs, err := database.GetPinnedMessages(chID, userID)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 pinned message, got %d", len(msgs))
	}
	if msgs[0].Content != "pinned msg" {
		t.Errorf("Content = %q, want 'pinned msg'", msgs[0].Content)
	}
	if !msgs[0].Pinned {
		t.Error("expected Pinned=true")
	}
}

// ─── SetMessagePinned ───────────────────────────────────────────────────────

func TestSetMessagePinned_Pin(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "setpin-u")
	chID := seedChannel(t, database, "setpin-ch")

	id, _ := database.CreateMessage(chID, userID, "to pin", nil)

	if err := database.SetMessagePinned(id, true); err != nil {
		t.Fatalf("SetMessagePinned(true): %v", err)
	}

	msg, _ := database.GetMessage(id)
	if msg == nil || !msg.Pinned {
		t.Error("message should be pinned")
	}
}

func TestSetMessagePinned_Unpin(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "unpin-u")
	chID := seedChannel(t, database, "unpin-ch")

	id, _ := database.CreateMessage(chID, userID, "to unpin", nil)
	_ = database.SetMessagePinned(id, true)
	if err := database.SetMessagePinned(id, false); err != nil {
		t.Fatalf("SetMessagePinned(false): %v", err)
	}

	msg, _ := database.GetMessage(id)
	if msg == nil || msg.Pinned {
		t.Error("message should not be pinned")
	}
}

func TestSetMessagePinned_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	err := database.SetMessagePinned(99999, true)
	if err == nil {
		t.Error("expected error for non-existent message")
	}
}

func TestSetMessagePinned_DeletedMessage(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pin-del-u")
	chID := seedChannel(t, database, "pin-del-ch")

	id, _ := database.CreateMessage(chID, userID, "deleted", nil)
	_ = database.DeleteMessage(id, userID, false)

	err := database.SetMessagePinned(id, true)
	if err == nil {
		t.Error("expected error when pinning deleted message")
	}
}

// ─── CreateAttachment ───────────────────────────────────────────────────────

func TestCreateAttachment_Success(t *testing.T) {
	database := openMigratedMemory(t)

	err := database.CreateAttachment("att-001", "photo.png", "stored-001.png", "image/png", 12345, nil, nil)
	if err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}

	att, err := database.GetAttachmentByID("att-001")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("expected attachment, got nil")
	}
	if att.Filename != "photo.png" {
		t.Errorf("Filename = %q, want 'photo.png'", att.Filename)
	}
	if att.Size != 12345 {
		t.Errorf("Size = %d, want 12345", att.Size)
	}
	if att.MimeType != "image/png" {
		t.Errorf("MimeType = %q, want 'image/png'", att.MimeType)
	}
}

func TestCreateAttachment_WithDimensions(t *testing.T) {
	database := openMigratedMemory(t)

	w, h := 1920, 1080
	err := database.CreateAttachment("att-dim", "photo.jpg", "stored-dim.jpg", "image/jpeg", 54321, &w, &h)
	if err != nil {
		t.Fatalf("CreateAttachment with dims: %v", err)
	}

	att, _ := database.GetAttachmentByID("att-dim")
	if att == nil {
		t.Fatal("expected attachment")
	}
}

// ─── DeleteOrphanedAttachments ──────────────────────────────────────────────

func TestDeleteOrphanedAttachments_RemovesOrphans(t *testing.T) {
	database := openMigratedMemory(t)

	// Create an unlinked attachment (message_id IS NULL).
	_ = database.CreateAttachment("orphan-1", "file.txt", "stored-orphan.txt", "text/plain", 100, nil, nil)

	// Use a cutoff far in the future so the attachment is considered old.
	files, err := database.DeleteOrphanedAttachments("2099-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 orphan, got %d", len(files))
	}
	if files[0] != "stored-orphan.txt" {
		t.Errorf("stored_as = %q, want 'stored-orphan.txt'", files[0])
	}

	// Should be removed from DB.
	att, _ := database.GetAttachmentByID("orphan-1")
	if att != nil {
		t.Error("orphaned attachment should be deleted from DB")
	}
}

func TestDeleteOrphanedAttachments_KeepsLinked(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "orphan-linked-u")
	chID := seedChannel(t, database, "orphan-linked-ch")

	// Create attachment and link it to a message.
	_ = database.CreateAttachment("linked-1", "file.txt", "stored-linked.txt", "text/plain", 100, nil, nil)
	msgID, _ := database.CreateMessage(chID, userID, "with attachment", nil)
	_, _ = database.LinkAttachmentsToMessage(msgID, []string{"linked-1"})

	files, err := database.DeleteOrphanedAttachments("2099-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 orphans (linked), got %d", len(files))
	}
}

func TestDeleteOrphanedAttachments_CutoffRespected(t *testing.T) {
	database := openMigratedMemory(t)

	_ = database.CreateAttachment("future-1", "file.txt", "stored-future.txt", "text/plain", 100, nil, nil)

	// Cutoff in the past — newly created attachment should NOT be deleted.
	files, err := database.DeleteOrphanedAttachments("2000-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected 0 orphans (cutoff too old), got %d", len(files))
	}
}

// ─── GetAllChannelPermissionsForRole ────────────────────────────────────────

func TestGetAllChannelPermissionsForRole_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	result, err := database.GetAllChannelPermissionsForRole(4)
	if err != nil {
		t.Fatalf("GetAllChannelPermissionsForRole: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty map, got %d entries", len(result))
	}
}

func TestGetAllChannelPermissionsForRole_WithOverrides(t *testing.T) {
	database := openMigratedMemory(t)

	ch1, _ := database.CreateChannel("perm-ch1", "text", "", "", 0)
	ch2, _ := database.CreateChannel("perm-ch2", "text", "", "", 0)

	// Insert overrides for role 4.
	_, _ = database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
		ch1, 4, int64(0x100), int64(0x200),
	)
	_, _ = database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
		ch2, 4, int64(0x300), int64(0),
	)

	result, err := database.GetAllChannelPermissionsForRole(4)
	if err != nil {
		t.Fatalf("GetAllChannelPermissionsForRole: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result))
	}
	if o, ok := result[ch1]; !ok || o.Allow != 0x100 || o.Deny != 0x200 {
		t.Errorf("ch1 override = %+v, want allow=0x100 deny=0x200", result[ch1])
	}
}

// ─── GetChannelTypes ────────────────────────────────────────────────────────

func TestGetChannelTypes_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	result, err := database.GetChannelTypes(nil)
	if err != nil {
		t.Fatalf("GetChannelTypes: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty map, got %d", len(result))
	}
}

func TestGetChannelTypes_ReturnsTypes(t *testing.T) {
	database := openMigratedMemory(t)

	ch1, _ := database.CreateChannel("type-text", "text", "", "", 0)
	ch2, _ := database.CreateChannel("type-voice", "voice", "", "", 0)

	result, err := database.GetChannelTypes([]int64{ch1, ch2})
	if err != nil {
		t.Fatalf("GetChannelTypes: %v", err)
	}
	if result[ch1] != "text" {
		t.Errorf("ch1 type = %q, want 'text'", result[ch1])
	}
	if result[ch2] != "voice" {
		t.Errorf("ch2 type = %q, want 'voice'", result[ch2])
	}
}

func TestGetChannelTypes_NonExistentIDs(t *testing.T) {
	database := openMigratedMemory(t)

	result, err := database.GetChannelTypes([]int64{99999})
	if err != nil {
		t.Fatalf("GetChannelTypes: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty map for non-existent IDs, got %d", len(result))
	}
}

// ─── CountUsersWithoutTOTP ──────────────────────────────────────────────────

func TestCountUsersWithoutTOTP_AllWithout(t *testing.T) {
	database := openMigratedMemory(t)
	_, _ = database.CreateUser("totp-u1", "hash", 4)
	_, _ = database.CreateUser("totp-u2", "hash", 4)

	count, err := database.CountUsersWithoutTOTP()
	if err != nil {
		t.Fatalf("CountUsersWithoutTOTP: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}
}

func TestCountUsersWithoutTOTP_WithTOTPSetup(t *testing.T) {
	database := openMigratedMemory(t)
	uid, _ := database.CreateUser("totp-with", "hash", 4)
	_, _ = database.CreateUser("totp-without", "hash", 4)

	secret := "JBSWY3DPEHPK3PXP"
	_ = database.UpdateUserTOTPSecret(uid, &secret)

	count, err := database.CountUsersWithoutTOTP()
	if err != nil {
		t.Fatalf("CountUsersWithoutTOTP: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want 1 (one has TOTP)", count)
	}
}

// ─── UpdateUserTOTPSecret ───────────────────────────────────────────────────

func TestUpdateUserTOTPSecret_Set(t *testing.T) {
	database := openMigratedMemory(t)
	uid, _ := database.CreateUser("totp-set", "hash", 4)

	secret := "JBSWY3DPEHPK3PXP"
	if err := database.UpdateUserTOTPSecret(uid, &secret); err != nil {
		t.Fatalf("UpdateUserTOTPSecret(set): %v", err)
	}

	user, _ := database.GetUserByID(uid)
	if user == nil || user.TOTPSecret == nil || *user.TOTPSecret != secret {
		t.Error("TOTP secret should be set")
	}
}

func TestUpdateUserTOTPSecret_Clear(t *testing.T) {
	database := openMigratedMemory(t)
	uid, _ := database.CreateUser("totp-clear", "hash", 4)

	secret := "JBSWY3DPEHPK3PXP"
	_ = database.UpdateUserTOTPSecret(uid, &secret)
	if err := database.UpdateUserTOTPSecret(uid, nil); err != nil {
		t.Fatalf("UpdateUserTOTPSecret(clear): %v", err)
	}

	user, _ := database.GetUserByID(uid)
	if user == nil || user.TOTPSecret != nil {
		t.Error("TOTP secret should be nil after clear")
	}
}

// ─── CreateUserWithInvite ───────────────────────────────────────────────────

func TestCreateUserWithInvite_Success(t *testing.T) {
	database := openMigratedMemory(t)
	// Create a user who will create the invite.
	creatorID, _ := database.CreateUser("invite-creator", "hash", 2)

	code, err := database.CreateInvite(creatorID, 5, nil)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	uid, err := database.CreateUserWithInvite("newuser", "hash", 4, code)
	if err != nil {
		t.Fatalf("CreateUserWithInvite: %v", err)
	}
	if uid <= 0 {
		t.Errorf("expected positive user ID, got %d", uid)
	}

	// Verify invite use count incremented.
	inv, _ := database.GetInvite(code)
	if inv == nil || inv.Uses != 1 {
		t.Errorf("invite uses = %v, want 1", inv)
	}
}

func TestCreateUserWithInvite_InvalidCode(t *testing.T) {
	database := openMigratedMemory(t)

	_, err := database.CreateUserWithInvite("baduser", "hash", 4, "nonexistent-code")
	if err == nil {
		t.Error("expected error for invalid invite code")
	}
}

func TestCreateUserWithInvite_RevokedInvite(t *testing.T) {
	database := openMigratedMemory(t)
	creatorID, _ := database.CreateUser("inv-revoke-creator", "hash", 2)

	code, _ := database.CreateInvite(creatorID, 0, nil)
	_ = database.RevokeInvite(code)

	_, err := database.CreateUserWithInvite("revokeduser", "hash", 4, code)
	if err == nil {
		t.Error("expected error for revoked invite")
	}
}

func TestCreateUserWithInvite_ExpiredInvite(t *testing.T) {
	database := openMigratedMemory(t)
	creatorID, _ := database.CreateUser("inv-expire-creator", "hash", 2)

	// Create an invite that expires in the past.
	pastTime := time.Now().Add(-1 * time.Hour)
	code, _ := database.CreateInvite(creatorID, 0, &pastTime)

	_, err := database.CreateUserWithInvite("expireduser", "hash", 4, code)
	if err == nil {
		t.Error("expected error for expired invite")
	}
}

// ─── ListInvites (db layer) ─────────────────────────────────────────────────

func TestListInvites_DB_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	invites, err := database.ListInvites()
	if err != nil {
		t.Fatalf("ListInvites: %v", err)
	}
	if len(invites) != 0 {
		t.Errorf("expected 0 invites, got %d", len(invites))
	}
}

func TestListInvites_DB_ReturnsAll(t *testing.T) {
	database := openMigratedMemory(t)
	creatorID, _ := database.CreateUser("list-inv-creator", "hash", 2)

	_, _ = database.CreateInvite(creatorID, 5, nil)
	_, _ = database.CreateInvite(creatorID, 0, nil)

	invites, err := database.ListInvites()
	if err != nil {
		t.Fatalf("ListInvites: %v", err)
	}
	if len(invites) != 2 {
		t.Errorf("expected 2 invites, got %d", len(invites))
	}
}

func TestUseInviteAtomic_NonExistent(t *testing.T) {
	database := openMigratedMemory(t)

	err := database.UseInviteAtomic("does-not-exist")
	if err == nil {
		t.Error("expected error for non-existent invite")
	}
}

// ─── SearchMessages edge cases ──────────────────────────────────────────────

func TestSearchMessages_EmptyQuery(t *testing.T) {
	database := openMigratedMemory(t)

	results, err := database.SearchMessages("", nil, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for empty query, got %d", len(results))
	}
}

func TestSearchMessages_ZeroLimit(t *testing.T) {
	database := openMigratedMemory(t)

	results, err := database.SearchMessages("test", nil, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for zero limit, got %d", len(results))
	}
}

func TestSearchMessages_SpecialCharsStripped(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "srch-special")
	chID := seedChannel(t, database, "srch-special-ch")

	_, _ = database.CreateMessage(chID, userID, "hello world content", nil)

	// FTS special chars should be stripped, leaving a valid query.
	results, err := database.SearchMessages("hello* \"world\"", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessages with special chars: %v", err)
	}
	// Should not crash, results may vary.
	_ = results
}
