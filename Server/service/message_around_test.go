package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedAroundHistory fills channelID with n messages authored by user 1 and
// returns their ids oldest-first.
func seedAroundHistory(t *testing.T, database *db.DB, channelID int64, n int) []int64 {
	t.Helper()
	ids := make([]int64, 0, n)
	for range n {
		id, err := database.CreateMessage(context.Background(), channelID, 1, "history", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		ids = append(ids, id)
	}
	return ids
}

func TestGetMessagesAround_SplitsTheLimitAroundTheCentre(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 40)

	window, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[20], 11)
	if err != nil {
		t.Fatalf("GetMessagesAround: %v", err)
	}
	if len(window.Messages) != 11 {
		t.Fatalf("window size = %d, want 11", len(window.Messages))
	}
	// limit 11 → 5 older, centre, 5 newer.
	if window.Messages[5].ID != ids[20] {
		t.Errorf("centre at index 5 = %d, want %d", window.Messages[5].ID, ids[20])
	}
	if !window.HasMoreBefore || !window.HasMoreAfter {
		t.Errorf("HasMoreBefore = %v, HasMoreAfter = %v; want both true",
			window.HasMoreBefore, window.HasMoreAfter)
	}
}

func TestGetMessagesAround_EdgesReportNoMore(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 30)

	first, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[0], 10)
	if err != nil {
		t.Fatalf("GetMessagesAround(first): %v", err)
	}
	if first.HasMoreBefore {
		t.Error("HasMoreBefore = true at the oldest message")
	}
	if !first.HasMoreAfter {
		t.Error("HasMoreAfter = false with 29 newer messages")
	}

	last, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[len(ids)-1], 10)
	if err != nil {
		t.Fatalf("GetMessagesAround(last): %v", err)
	}
	if last.HasMoreAfter {
		t.Error("HasMoreAfter = true at the newest message")
	}
	if !last.HasMoreBefore {
		t.Error("HasMoreBefore = false with 29 older messages")
	}
}

func TestGetMessagesAround_ExactFitReportsNoMore(t *testing.T) {
	svc, database := newTestMessageService(t)
	// limit 5 → 2 older + centre + 2 newer, and the channel holds exactly that.
	ids := seedAroundHistory(t, database, 10, 5)

	window, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[2], 5)
	if err != nil {
		t.Fatalf("GetMessagesAround: %v", err)
	}
	if len(window.Messages) != 5 {
		t.Fatalf("window size = %d, want 5", len(window.Messages))
	}
	if window.HasMoreBefore || window.HasMoreAfter {
		t.Errorf("HasMoreBefore = %v, HasMoreAfter = %v; a window that exactly covers the channel has no more",
			window.HasMoreBefore, window.HasMoreAfter)
	}
}

func TestGetMessagesAround_ClampsLimit(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 150)

	window, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[75], 5000)
	if err != nil {
		t.Fatalf("GetMessagesAround: %v", err)
	}
	if len(window.Messages) != 100 {
		t.Errorf("window size = %d, want the 100 cap", len(window.Messages))
	}

	// A zero/negative limit falls back to the 50 default rather than returning
	// an empty window.
	window, err = svc.GetMessagesAround(context.Background(), 1, 10, ids[75], 0)
	if err != nil {
		t.Fatalf("GetMessagesAround(limit=0): %v", err)
	}
	if len(window.Messages) != 50 {
		t.Errorf("default window size = %d, want 50", len(window.Messages))
	}
}

func TestGetMessagesAround_RejectsBadIDs(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 3)

	if _, err := svc.GetMessagesAround(context.Background(), 1, 10, 0, 50); !errors.Is(err, ErrBadRequest) {
		t.Errorf("message_id 0 error = %v, want ErrBadRequest", err)
	}
	if _, err := svc.GetMessagesAround(context.Background(), 1, 0, ids[0], 50); !errors.Is(err, ErrBadRequest) {
		t.Errorf("channel_id 0 error = %v, want ErrBadRequest", err)
	}
	if _, err := svc.GetMessagesAround(context.Background(), 1, 999, ids[0], 50); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown channel error = %v, want ErrNotFound", err)
	}
}

func TestGetMessagesAround_MessageFromAnotherChannelIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedChannel(t, database, &db.Channel{ID: 12, Name: "other", Type: "text"})
	otherIDs := seedAroundHistory(t, database, 12, 2)

	_, err := svc.GetMessagesAround(context.Background(), 1, 10, otherIDs[0], 50)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-channel centre error = %v, want ErrNotFound", err)
	}
}

func TestGetMessagesAround_DeletedCentreIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 3)
	if err := database.DeleteMessage(context.Background(), ids[1], 1, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// History omits soft-deleted rows, so there is no row to centre on — the
	// jump must fail loudly rather than land on an arbitrary neighbour.
	_, err := svc.GetMessagesAround(context.Background(), 1, 10, ids[1], 50)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted centre error = %v, want ErrNotFound", err)
	}
}

func TestGetMessagesAround_DMNonParticipantIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: "online"})
	seedUser(t, database, &db.User{ID: 3, Username: "outsider", Status: "offline"})
	seedChannel(t, database, &db.Channel{ID: 13, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 13, 1)
	seedDMParticipant(t, database, 13, 2)
	msgID, err := database.CreateMessage(context.Background(), 13, 1, "private", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	if _, err := svc.GetMessagesAround(context.Background(), 3, 13, msgID, 50); !errors.Is(err, ErrNotFound) {
		t.Errorf("outsider error = %v, want ErrNotFound", err)
	}
	window, err := svc.GetMessagesAround(context.Background(), 1, 13, msgID, 50)
	if err != nil {
		t.Fatalf("participant GetMessagesAround: %v", err)
	}
	if len(window.Messages) != 1 {
		t.Errorf("participant window size = %d, want 1", len(window.Messages))
	}
}
