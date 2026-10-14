package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestGetMessagesAfter_AscendingPagesToTheNewest(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 12)

	page, hasMore, err := svc.GetMessagesAfter(context.Background(), 1, 10, ids[2], 4)
	if err != nil {
		t.Fatalf("GetMessagesAfter: %v", err)
	}
	got := make([]int64, 0, len(page))
	for _, m := range page {
		got = append(got, m.ID)
	}
	if want := ids[3:7]; !slices.Equal(got, want) {
		t.Errorf("page = %v, want %v (ascending, after the cursor)", got, want)
	}
	if !hasMore {
		t.Error("hasMore = false, want true while newer messages remain")
	}

	// The last page ends exactly at the newest message: has_more false.
	page, hasMore, err = svc.GetMessagesAfter(context.Background(), 1, 10, ids[7], 4)
	if err != nil {
		t.Fatalf("GetMessagesAfter(last): %v", err)
	}
	if len(page) != 4 || page[len(page)-1].ID != ids[11] || hasMore {
		t.Errorf("last page = %d rows, hasMore = %v; want 4 rows ending at %d, no more", len(page), hasMore, ids[11])
	}

	// Past the newest message: empty, nothing more.
	page, hasMore, err = svc.GetMessagesAfter(context.Background(), 1, 10, ids[11], 4)
	if err != nil || len(page) != 0 || hasMore {
		t.Errorf("after newest = (%d rows, %v, %v), want empty", len(page), hasMore, err)
	}
}

func TestGetMessagesAfter_ClampsLimit(t *testing.T) {
	svc, database := newTestMessageService(t)
	ids := seedAroundHistory(t, database, 10, 130)

	page, hasMore, err := svc.GetMessagesAfter(context.Background(), 1, 10, ids[0], 1000)
	if err != nil {
		t.Fatalf("GetMessagesAfter: %v", err)
	}
	if len(page) != 100 || !hasMore {
		t.Errorf("page = %d rows, hasMore = %v; want 100 rows and more", len(page), hasMore)
	}
}

func TestGetMessagesAfter_RejectsBadCursor(t *testing.T) {
	svc, _ := newTestMessageService(t)
	for _, after := range []int64{0, -1} {
		if _, _, err := svc.GetMessagesAfter(context.Background(), 1, 10, after, 50); !errors.Is(err, ErrBadRequest) {
			t.Errorf("after=%d error = %v, want ErrBadRequest", after, err)
		}
	}
}

func TestGetMessagesAfter_SameReadGateAsBefore(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: "online"})
	seedUser(t, database, &db.User{ID: 3, Username: "outsider", Status: "offline"})
	seedChannel(t, database, &db.Channel{ID: 13, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 13, 1)
	seedDMParticipant(t, database, 13, 2)
	ids := seedAroundHistory(t, database, 13, 3)

	_, _, afterErr := svc.GetMessagesAfter(context.Background(), 3, 13, ids[0], 50)
	_, _, beforeErr := svc.GetMessages(context.Background(), 3, 13, 0, 50)
	if !errors.Is(afterErr, ErrNotFound) || !errors.Is(beforeErr, ErrNotFound) {
		t.Fatalf("outsider after = %v, before = %v; want ErrNotFound for both", afterErr, beforeErr)
	}
	if _, _, err := svc.GetMessagesAfter(context.Background(), 3, 99999, ids[0], 50); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown channel error = %v, want ErrNotFound", err)
	}
	if page, _, err := svc.GetMessagesAfter(context.Background(), 1, 13, ids[0], 50); err != nil || len(page) != 2 {
		t.Errorf("participant page = (%d rows, %v), want 2 rows", len(page), err)
	}
}
