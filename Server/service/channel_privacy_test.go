package service

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestChannelPrivacyService(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	svc := NewChannelPrivacyService(database)
	const memberRole = 4 // seeded is_default role

	pub, err := database.CreateChannel(ctx, "pub", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	locked, _ := database.CreateChannel(ctx, "locked", "voice", "", "", 1)
	allowed, _ := database.CreateChannel(ctx, "allowed", "text", "", "", 2)
	if err := database.UpsertChannelOverride(ctx, locked, memberRole, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("override: %v", err)
	}
	if err := database.UpsertChannelOverride(ctx, allowed, memberRole, permissions.ReadMessages, 0); err != nil {
		t.Fatalf("override: %v", err)
	}

	snap, err := svc.Snapshot(ctx)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	for id, want := range map[int64]bool{pub: false, locked: true, allowed: false, 9999: false} {
		if got := snap.Private(id); got != want {
			t.Errorf("snapshot.Private(%d) = %v, want %v", id, got, want)
		}
		single, err := svc.ChannelIsPrivate(ctx, id)
		if err != nil {
			t.Fatalf("ChannelIsPrivate(%d): %v", id, err)
		}
		if single != want {
			t.Errorf("ChannelIsPrivate(%d) = %v, want %v", id, single, want)
		}
	}

	// The default role's base lacking READ_MESSAGES makes an unoverridden channel private.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions & ? WHERE id = ?`, ^permissions.ReadMessages, memberRole); err != nil {
		t.Fatalf("strip read: %v", err)
	}
	if got, _ := svc.ChannelIsPrivate(ctx, pub); !got {
		t.Error("base without READ_MESSAGES: want private")
	}

	// No default role: not private, no error.
	if _, err := database.ExecContext(ctx, `UPDATE roles SET is_default = 0`); err != nil {
		t.Fatalf("clear default: %v", err)
	}
	snap, err = svc.Snapshot(ctx)
	if err != nil || snap.Private(locked) {
		t.Errorf("no default role snapshot: private=%v err=%v, want false, nil", snap.Private(locked), err)
	}
	if got, err := svc.ChannelIsPrivate(ctx, locked); got || err != nil {
		t.Errorf("no default role: ChannelIsPrivate = %v, %v; want false, nil", got, err)
	}
}
