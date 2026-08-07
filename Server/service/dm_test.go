package service

import (
	"context"
	"errors"
	"testing"

	"github.com/owncord/server/db"
)

// GetUserByID has no banned filter (unlike ListMembers and the other lookups
// that normally surface a user to a caller), so CreateDM/CreateGroupDM must
// gate on ban status themselves or a hand-crafted recipient_id naming a
// deleted/banned account creates a dead-end DM channel and participant rows
// for the tombstone user (v116).

func TestDMService_CreateDM_RefusesBannedRecipient(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Banned: true})

	svc := NewDMService(database)
	_, err := svc.CreateDM(context.Background(), 1, 2)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateDM to a banned recipient = %v, want ErrNotFound", err)
	}
}

// A temporary ban that has already expired must not block the DM: login,
// WS auth and every other gate already treat this user as not-banned
// (auth.IsEffectivelyBanned), so refusing the DM here would be a stricter,
// inconsistent rule.
func TestDMService_CreateDM_AllowsLapsedTemporaryBan(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Banned: true})
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET ban_expires = '2020-01-01 00:00:00' WHERE id = 2`); err != nil {
		t.Fatalf("set stale ban_expires: %v", err)
	}

	svc := NewDMService(database)
	result, err := svc.CreateDM(context.Background(), 1, 2)
	if err != nil {
		t.Fatalf("CreateDM to a user with a lapsed temporary ban: %v", err)
	}
	if result.Channel == nil {
		t.Fatal("expected a DM channel to be created")
	}
}

func TestDMService_CreateGroupDM_RefusesBannedRecipient(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "alice"})
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol", Banned: true})

	svc := NewDMService(database)
	_, err := svc.CreateGroupDM(context.Background(), 1, []int64{2, 3}, "")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateGroupDM with a banned recipient = %v, want ErrNotFound", err)
	}
}
