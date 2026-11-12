package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestLookupChannel_StoreFailureIsInternalNotNotFound(t *testing.T) {
	svc, _ := newTestMessageService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := svc.GetMessages(ctx, 1, 10, 0, 50)
	if !errors.Is(err, ErrInternal) || errors.Is(err, ErrNotFound) {
		t.Fatalf("GetMessages with a dead context = %v, want ErrInternal and not ErrNotFound", err)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("the store cause is lost: %v", err)
	}
}

func TestLookupChannel_MissingRowIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)

	if _, err := lookupChannel(context.Background(), database, 99999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lookupChannel of a missing row = %v, want ErrNotFound", err)
	}
	if _, _, err := svc.GetMessages(context.Background(), 1, 99999, 0, 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetMessages of a missing channel = %v, want ErrNotFound", err)
	}
	if ch, err := lookupChannel(context.Background(), database, 10); err != nil || ch == nil {
		t.Fatalf("lookupChannel of an existing channel = (%v, %v)", ch, err)
	}
}

func TestReadSubject_LookupFailureIsInternalAndNonMemberStaysNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 3, Username: "outsider", Status: "offline"})
	seedChannel(t, database, &db.Channel{ID: 13, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 13, 1)

	dead, cancel := context.WithCancel(context.Background())
	cancel()
	for _, id := range []int64{10, 13} {
		ch, err := lookupChannel(context.Background(), database, id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := readSubject(dead, svc.st, svc.perms, 1, ch); !errors.Is(err, ErrInternal) {
			t.Errorf("readSubject(channel %d) with a dead context = %v, want ErrInternal", id, err)
		}
	}

	if _, _, err := svc.GetMessages(context.Background(), 3, 13, 0, 50); !errors.Is(err, ErrNotFound) {
		t.Errorf("a real non-member of a DM = %v, want ErrNotFound", err)
	}
}
