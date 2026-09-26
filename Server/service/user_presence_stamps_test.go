package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The connection lifecycle's two status writes moved onto UserService with
// B3-8's connection family. They are a pair: StampDisconnect deliberately
// leaves a chosen status standing, and StampConnect is the only thing that
// reads it back. Pinning them apart would let either half drift into
// "everyone comes online as online", which is the flash-online bug the
// invisible status exists to kill.

func TestUserService_StampConnectPreservesAChosenStatus(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()

	for _, tc := range []struct {
		saved, want, why string
	}{
		{db.StatusIdle, db.StatusIdle, "idle is a choice and survives"},
		{db.StatusDND, db.StatusDND, "dnd is a choice and survives"},
		{db.StatusInvisible, db.StatusInvisible, "appear-offline is a choice and survives; collapsing it here is the leak"},
		{db.StatusOnline, db.StatusOnline, "online is the default either way"},
		{db.StatusOffline, db.StatusOnline, "offline is what a disconnect writes, so it carries no intent to preserve"},
		{"some-legacy-value", db.StatusOnline, "an unknown value is not a choice"},
	} {
		userID := int64(len(tc.saved) + len(tc.want) + 1000)
		seedUser(t, database, &db.User{ID: userID, Username: seedUsername(userID), Status: tc.saved})

		got, err := svc.StampConnect(ctx, userID, tc.saved)
		if err != nil {
			t.Fatalf("StampConnect(%q): %v", tc.saved, err)
		}
		if got != tc.want {
			t.Errorf("StampConnect(%q) = %q, want %q — %s", tc.saved, got, tc.want, tc.why)
		}
		// The returned value is what the caller caches and broadcasts, so the
		// row has to agree with it.
		user, err := svc.Get(ctx, userID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if user.Status != got {
			t.Errorf("users.status = %q but StampConnect returned %q — the auth_ok reply "+
				"and the presence broadcast would claim a value the row disagrees with",
				user.Status, got)
		}
	}
}

// The pair, driven end to end: a chosen status has to survive the whole
// disconnect/reconnect cycle, not just the connect half.
func TestUserService_ChosenStatusSurvivesADisconnectCycle(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "chooser", Status: db.StatusDND})

	if _, err := svc.StampConnect(ctx, 1, db.StatusDND); err != nil {
		t.Fatalf("StampConnect: %v", err)
	}
	if err := svc.StampDisconnect(ctx, 1); err != nil {
		t.Fatalf("StampDisconnect: %v", err)
	}

	after, err := svc.Get(ctx, 1)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if after.Status != db.StatusDND {
		t.Fatalf("status after a disconnect = %q, want %q — the stamp must clear only the "+
			"non-choice \"online\", or the next connect has nothing left to preserve",
			after.Status, db.StatusDND)
	}
	// …and the next connect reads that choice back rather than forcing online.
	got, err := svc.StampConnect(ctx, 1, after.Status)
	if err != nil {
		t.Fatalf("StampConnect (reconnect): %v", err)
	}
	if got != db.StatusDND {
		t.Errorf("reconnect came online as %q, want %q", got, db.StatusDND)
	}
}

func TestUserService_StampDisconnectClearsOnlineOnly(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "plain", Status: db.StatusOnline})

	if err := svc.StampDisconnect(ctx, 1); err != nil {
		t.Fatalf("StampDisconnect: %v", err)
	}
	user, err := svc.Get(ctx, 1)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if user.Status != db.StatusOffline {
		t.Errorf("status after disconnecting an online user = %q, want %q", user.Status, db.StatusOffline)
	}
}

// A failed stamp is an error, never a silent success: the hub caches the
// returned status onto the live client, and a value the row never received
// would make auth_ok, the presence broadcast and the member list disagree for
// the rest of the session (OC-0298).
func TestUserService_PresenceStampsFailLoud(t *testing.T) {
	database := newTestDB(t)
	svc := NewUserService(database)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 1, Username: "doomed"})
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	got, err := svc.StampConnect(ctx, 1, db.StatusIdle)
	if !errors.Is(err, ErrInternal) {
		t.Errorf("StampConnect on a closed database: err = %v, want ErrInternal", err)
	}
	if got != "" {
		t.Errorf("StampConnect returned %q alongside an error — the caller must have nothing to cache", got)
	}
	if err := svc.StampDisconnect(ctx, 1); !errors.Is(err, ErrInternal) {
		t.Errorf("StampDisconnect on a closed database: err = %v, want ErrInternal", err)
	}
}
