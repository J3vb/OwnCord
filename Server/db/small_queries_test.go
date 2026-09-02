package db_test

import (
	"context"
	"testing"
)

// Small query helpers the larger flows call indirectly; pinned here so their
// contract is checked at the seam (and so the db floor holds when the
// package grows).

func TestDeleteOtherSessions_KeepsTheCurrentOne(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "multi", "hash", 4)
	keep, err := database.CreateSession(ctx, uid, "tok-keep", "laptop", "10.0.0.1")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	for _, tok := range []string{"tok-a", "tok-b"} {
		if _, err := database.CreateSession(ctx, uid, tok, "phone", "10.0.0.2"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	n, err := database.DeleteOtherSessions(ctx, uid, keep)
	if err != nil || n != 2 {
		t.Fatalf("DeleteOtherSessions = %d, %v; want 2 revoked", n, err)
	}
	sessions, _ := database.ListUserSessions(ctx, uid)
	if len(sessions) != 1 || sessions[0].ID != keep {
		t.Fatalf("sessions left = %+v, want only the kept one", sessions)
	}
}

func TestGetRoleForUser_ReadsTheRole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "member", "hash", 4)
	role, err := database.GetRoleForUser(ctx, uid)
	if err != nil || role == nil || role.ID != 4 {
		t.Fatalf("GetRoleForUser = %+v, %v; want the Member role", role, err)
	}
	if role, err := database.GetRoleForUser(ctx, 424242); err != nil || role != nil {
		t.Fatalf("GetRoleForUser(unknown) = %+v, %v; want nil, nil", role, err)
	}
}

func TestDMChannel_ParticipantsAndLookup(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	a, _ := database.CreateUser(ctx, "alice", "hash", 4)
	b, _ := database.CreateUser(ctx, "bob", "hash", 4)
	c, _ := database.CreateUser(ctx, "carol", "hash", 4)
	ch, created, err := database.GetOrCreateDMChannel(ctx, a, b)
	if err != nil || !created || ch == nil {
		t.Fatalf("GetOrCreateDMChannel = %+v, %v, %v", ch, created, err)
	}
	if n, err := database.CountDMParticipants(ctx, ch.ID); err != nil || n != 2 {
		t.Fatalf("CountDMParticipants = %d, %v; want 2", n, err)
	}
	if id, found, err := database.FindDMChannelIDBetween(ctx, b, a); err != nil || !found || id != ch.ID {
		t.Fatalf("FindDMChannelIDBetween(b, a) = %d, %v, %v; want the channel", id, found, err)
	}
	if _, found, err := database.FindDMChannelIDBetween(ctx, a, c); err != nil || found {
		t.Fatalf("FindDMChannelIDBetween(a, c) found = %v, %v; want none", found, err)
	}
}

func TestCountEventsInRange(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	for seq := int64(1); seq <= 3; seq++ {
		if err := database.PersistEvent(ctx, seq, "chat_message", 1, []byte(`{}`)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
	}
	for _, tc := range []struct{ after, upto, want int64 }{{0, 3, 3}, {1, 3, 2}, {3, 3, 0}, {0, 1, 1}} {
		if n, err := database.CountEventsInRange(ctx, tc.after, tc.upto); err != nil || n != tc.want {
			t.Errorf("CountEventsInRange(%d, %d) = %d, %v; want %d", tc.after, tc.upto, n, err, tc.want)
		}
	}
}
