package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// newPurgeService builds a MessageService with a moderator (user 2, role 20,
// READ_MESSAGES|MANAGE_MESSAGES) alongside the plain member (user 1) that
// newTestMessageService seeds, plus a DM channel both users participate in.
func newPurgeService(t *testing.T) (*MessageService, *db.DB) {
	t.Helper()
	svc, database := newTestMessageService(t)
	seedRole(t, database, &db.Role{
		ID:          20,
		Name:        "purge-mod",
		Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages,
		Position:    5,
	})
	seedUser(t, database, &db.User{ID: 2, Username: "mod", Status: "online"})
	seedUserRole(t, database, 2, 20)
	seedChannel(t, database, &db.Channel{ID: 11, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 11, 1)
	seedDMParticipant(t, database, 11, 2)
	return svc, database
}

// seedPurgeMessages inserts n messages into channelID and returns their ids in
// insertion (oldest-first) order.
func seedPurgeMessages(t *testing.T, database *db.DB, channelID int64, n int) []int64 {
	t.Helper()
	ids := make([]int64, 0, n)
	for range n {
		id, err := database.CreateMessage(context.Background(), channelID, 1, "spam", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		ids = append(ids, id)
	}
	return ids
}

func TestPurgeMessages_ModeratorPurgesNewest(t *testing.T) {
	svc, database := newPurgeService(t)
	ids := seedPurgeMessages(t, database, 10, 5)

	result, err := svc.PurgeMessages(context.Background(), 2, 10, 2, 0)
	if err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}
	if len(result.MessageIDs) != 2 {
		t.Fatalf("purged %d messages, want 2", len(result.MessageIDs))
	}
	if result.ChannelID != 10 {
		t.Errorf("ChannelID = %d, want 10", result.ChannelID)
	}
	if result.MessageIDs[0] != ids[4] || result.MessageIDs[1] != ids[3] {
		t.Errorf("purged ids = %v, want newest-first %v", result.MessageIDs, []int64{ids[4], ids[3]})
	}
}

func TestPurgeMessages_TombstonesPreserved(t *testing.T) {
	svc, database := newPurgeService(t)
	ids := seedPurgeMessages(t, database, 10, 3)

	if _, err := svc.PurgeMessages(context.Background(), 2, 10, 3, 0); err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}

	// Soft delete only: the rows and their content must survive so clients
	// render tombstones and reply targets still resolve.
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

func TestPurgeMessages_MissingManageMessagesDenied(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 10, 3)

	// User 1 holds SEND_MESSAGES|READ_MESSAGES but not MANAGE_MESSAGES.
	_, err := svc.PurgeMessages(context.Background(), 1, 10, 3, 0)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}

	msgs, _, listErr := svc.GetMessages(context.Background(), 1, 10, 0, 50)
	if listErr != nil {
		t.Fatalf("GetMessages: %v", listErr)
	}
	if len(msgs) != 3 {
		t.Errorf("denied purge still deleted messages: %d remain, want 3", len(msgs))
	}
}

// A role with MANAGE_MESSAGES but READ_MESSAGES denied on the channel (what the
// admin panel's "Can access" toggle writes) must not be able to wipe it.
func TestPurgeMessages_DeniedReadCannotPurge(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 10, 3)
	seedChannelOverride(t, database, 20, 10, 0, permissions.ReadMessages)

	_, err := svc.PurgeMessages(context.Background(), 2, 10, 3, 0)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestPurgeMessages_DMRejected(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 11, 3)

	_, err := svc.PurgeMessages(context.Background(), 2, 11, 3, 0)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden for a DM channel", err)
	}

	msgs, _, listErr := svc.GetMessages(context.Background(), 2, 11, 0, 50)
	if listErr != nil {
		t.Fatalf("GetMessages: %v", listErr)
	}
	if len(msgs) != 3 {
		t.Errorf("DM purge deleted messages: %d remain, want 3", len(msgs))
	}
}

func TestPurgeMessages_LimitClampedToMax(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 10, maxPurgeLimit+10)

	result, err := svc.PurgeMessages(context.Background(), 2, 10, 5000, 0)
	if err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}
	if len(result.MessageIDs) != maxPurgeLimit {
		t.Fatalf("purged %d messages, want the clamp of %d", len(result.MessageIDs), maxPurgeLimit)
	}

	msgs, _, listErr := svc.GetMessages(context.Background(), 2, 10, 0, maxPurgeLimit)
	if listErr != nil {
		t.Fatalf("GetMessages: %v", listErr)
	}
	if len(msgs) != 10 {
		t.Errorf("%d messages remain, want 10", len(msgs))
	}
}

func TestPurgeMessages_NonPositiveLimitRejected(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 10, 2)

	for _, limit := range []int{0, -1} {
		if _, err := svc.PurgeMessages(context.Background(), 2, 10, limit, 0); !errors.Is(err, ErrBadRequest) {
			t.Errorf("limit %d: err = %v, want ErrBadRequest", limit, err)
		}
	}
}

func TestPurgeMessages_BeforeCursorHonored(t *testing.T) {
	svc, database := newPurgeService(t)
	ids := seedPurgeMessages(t, database, 10, 4)

	result, err := svc.PurgeMessages(context.Background(), 2, 10, 100, ids[2])
	if err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}
	if len(result.MessageIDs) != 2 {
		t.Fatalf("purged %v, want the two messages below the cursor", result.MessageIDs)
	}
	for _, id := range ids[2:] {
		msg, _ := database.GetMessage(context.Background(), id)
		if msg.Deleted {
			t.Errorf("message %d at/after the cursor was purged", id)
		}
	}
}

func TestPurgeMessages_ChannelNotFound(t *testing.T) {
	svc, _ := newPurgeService(t)

	if _, err := svc.PurgeMessages(context.Background(), 2, 9999, 10, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := svc.PurgeMessages(context.Background(), 2, 0, 10, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("channel 0: err = %v, want ErrBadRequest", err)
	}
}

func TestPurgeMessages_EmptyChannelSucceedsWithNoIDs(t *testing.T) {
	svc, _ := newPurgeService(t)

	result, err := svc.PurgeMessages(context.Background(), 2, 10, 50, 0)
	if err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}
	if result.MessageIDs == nil {
		t.Fatal("MessageIDs is nil, want an empty slice")
	}
	if len(result.MessageIDs) != 0 {
		t.Fatalf("purged %v, want none", result.MessageIDs)
	}
}

func TestPurgeMessages_WritesOneAuditEntry(t *testing.T) {
	svc, database := newPurgeService(t)
	seedPurgeMessages(t, database, 10, 4)

	if _, err := svc.PurgeMessages(context.Background(), 2, 10, 4, 0); err != nil {
		t.Fatalf("PurgeMessages: %v", err)
	}

	entries, err := database.GetAuditLog(context.Background(), 50, 0)
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	var purges int
	for _, e := range entries {
		if e.Action == "message_purge" {
			purges++
			if e.TargetID != 10 {
				t.Errorf("audit target_id = %d, want the channel id 10", e.TargetID)
			}
			if e.Detail == "" {
				t.Error("audit detail is empty, want the purged count")
			}
		}
	}
	if purges != 1 {
		t.Fatalf("wrote %d message_purge audit entries, want exactly 1", purges)
	}
}
