package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// groupDMFixture returns a migrated database with three users (ids 1..3).
func groupDMFixture(t *testing.T) *db.DB {
	t.Helper()
	database := openMigratedMemory(t)
	for i, name := range []string{"ga", "gb", "gc"} {
		if got := seedUser(t, database, name); got != int64(i+1) {
			t.Fatalf("seedUser %s: expected id %d, got %d", name, i+1, got)
		}
	}
	return database
}

func TestCreateGroupDMChannel_OpensForEveryone(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	ch, err := database.CreateGroupDMChannel(ctx, "Crew", []int64{1, 2, 3})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	if ch.Name != "Crew" {
		t.Errorf("expected name Crew, got %q", ch.Name)
	}

	isGroup, err := database.IsGroupDM(ctx, ch.ID)
	if err != nil || !isGroup {
		t.Errorf("expected is_group=true, got %v (err=%v)", isGroup, err)
	}

	for _, uid := range []int64{1, 2, 3} {
		dms, listErr := database.GetUserDMChannels(ctx, uid)
		if listErr != nil {
			t.Fatalf("GetUserDMChannels(%d): %v", uid, listErr)
		}
		if len(dms) != 1 {
			t.Fatalf("user %d: expected 1 open DM, got %d", uid, len(dms))
		}
		if !dms[0].IsGroup || dms[0].Name != "Crew" {
			t.Errorf("user %d: expected the group, got %+v", uid, dms[0])
		}
		if len(dms[0].Recipients) != 2 {
			t.Errorf("user %d: expected 2 others, got %d", uid, len(dms[0].Recipients))
		}
		for _, r := range dms[0].Recipients {
			if r.ID == uid {
				t.Errorf("user %d appears in their own recipients list", uid)
			}
		}
	}
}

func TestCreateGroupDMChannel_RefusesUnderThree(t *testing.T) {
	database := groupDMFixture(t)
	if _, err := database.CreateGroupDMChannel(context.Background(), "", []int64{1, 2}); err == nil {
		t.Fatal("expected an error creating a 2-person group DM")
	}
}

// The 1:1 lookup must never return a group DM, even one whose membership has
// shrunk to exactly the two users being looked up.
func TestGetOrCreateDMChannel_IgnoresShrunkGroup(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	group, err := database.CreateGroupDMChannel(ctx, "Shrinking", []int64{1, 2, 3})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	if _, err = database.LeaveGroupDM(ctx, 3, group.ID); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}

	ch, created, err := database.GetOrCreateDMChannel(ctx, 1, 2)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if !created {
		t.Error("expected a brand-new 1:1 DM, not a reused channel")
	}
	if ch.ID == group.ID {
		t.Fatal("the 1:1 lookup returned the shrunk group DM")
	}
}

func TestLeaveGroupDM_DeletesChannelOnLastLeave(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	group, err := database.CreateGroupDMChannel(ctx, "Ephemeral", []int64{1, 2, 3})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}

	for i, uid := range []int64{1, 2, 3} {
		deleted, leaveErr := database.LeaveGroupDM(ctx, uid, group.ID)
		if leaveErr != nil {
			t.Fatalf("LeaveGroupDM(%d): %v", uid, leaveErr)
		}
		wantDeleted := i == 2
		if deleted != wantDeleted {
			t.Errorf("leave %d: deleted=%v, want %v", uid, deleted, wantDeleted)
		}
	}

	ch, err := database.GetChannel(ctx, group.ID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != nil {
		t.Error("channel survived the last participant leaving")
	}
}

// TestLeaveGroupDM_LastLeavePreservesAttachmentsForReclaim locks the
// attachment-unlink fix: messages.channel_id and attachments.message_id both
// cascade ON DELETE (migrations/001), so deleting the channel row on the last
// leave would otherwise destroy the attachment rows too — the only handle the
// orphan sweep (DeleteOrphanedAttachments) has on the uploaded files,
// stranding them on disk with no query left able to name them.
func TestLeaveGroupDM_LastLeavePreservesAttachmentsForReclaim(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	group, err := database.CreateGroupDMChannel(ctx, "Ephemeral", []int64{1, 2, 3})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}

	msgID, err := database.CreateMessage(ctx, group.ID, 1, "look at this", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-leave-1", "photo.png", "stored-photo.png", "image/png", 2048, 1,
	); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, 1, []string{"att-leave-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	for _, uid := range []int64{1, 2, 3} {
		if _, err := database.LeaveGroupDM(ctx, uid, group.ID); err != nil {
			t.Fatalf("LeaveGroupDM(%d): %v", uid, err)
		}
	}

	ch, err := database.GetChannel(ctx, group.ID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch != nil {
		t.Error("channel survived the last participant leaving")
	}

	att, err := database.GetAttachmentByID(ctx, "att-leave-1")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("attachment row was destroyed by the channel-delete cascade; want it unlinked and preserved for the orphan sweep")
	}
	if att.MessageID != nil {
		t.Errorf("attachment MessageID = %v, want nil (unlinked ahead of the cascade)", *att.MessageID)
	}
}

func TestSetDMChannelName_RefusesNonDM(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	textID, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.SetDMChannelName(ctx, textID, "hijacked"); err != nil {
		t.Fatalf("SetDMChannelName: %v", err)
	}

	ch, err := database.GetChannel(ctx, textID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if ch.Name != "general" {
		t.Errorf("a text channel was renamed through the DM route: %q", ch.Name)
	}
}

// An invisible participant must read as offline to everyone but themselves,
// on the DM list exactly as everywhere else.
func TestGetDMParticipants_CollapsesInvisible(t *testing.T) {
	database := groupDMFixture(t)
	ctx := context.Background()

	group, err := database.CreateGroupDMChannel(ctx, "Ghosts", []int64{1, 2, 3})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, 2, db.StatusInvisible); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	others, err := database.GetDMParticipants(ctx, group.ID, 1)
	if err != nil {
		t.Fatalf("GetDMParticipants: %v", err)
	}
	for _, p := range others {
		if p.ID == 2 && p.Status != db.StatusOffline {
			t.Errorf("invisible user leaked as %q to another participant", p.Status)
		}
	}

	self, err := database.GetDMParticipants(ctx, group.ID, 2)
	if err != nil {
		t.Fatalf("GetDMParticipants: %v", err)
	}
	for _, p := range self {
		if p.ID == 2 && p.Status != db.StatusInvisible {
			t.Errorf("the owner of an invisible status sees %q, want invisible", p.Status)
		}
	}
}

func TestNewDMChannelInfo_ExcludesViewerAndPicksRecipient(t *testing.T) {
	participants := []db.DMUser{
		{ID: 1, Username: "a"},
		{ID: 2, Username: "b"},
		{ID: 3, Username: "c"},
	}
	info := db.NewDMChannelInfo(7, "Trio", true, participants, 2)

	if info.ChannelID != 7 || info.Name != "Trio" || !info.IsGroup {
		t.Errorf("unexpected header fields: %+v", info)
	}
	if len(info.Recipients) != 2 {
		t.Fatalf("expected 2 recipients, got %d", len(info.Recipients))
	}
	for _, r := range info.Recipients {
		if r.ID == 2 {
			t.Error("the viewer is in their own recipients list")
		}
	}
	// Backward compat: a pre-group client reads `recipient` alone.
	if info.Recipient.ID != 1 {
		t.Errorf("expected the first other participant as the compat recipient, got %d", info.Recipient.ID)
	}
}

// A DM with no other participants (the moment before the row is cleaned up)
// must produce an empty list, not a nil one — clients iterate it directly.
func TestNewDMChannelInfo_EmptyRecipientsIsNotNil(t *testing.T) {
	info := db.NewDMChannelInfo(9, "", false, []db.DMUser{{ID: 5}}, 5)
	if info.Recipients == nil {
		t.Fatal("recipients must be an empty slice, not nil")
	}
	if len(info.Recipients) != 0 {
		t.Errorf("expected no recipients, got %d", len(info.Recipients))
	}
}
