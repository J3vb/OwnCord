package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Beyond sends, edits, reactions and voice joins, a timeout refuses creating
// a new DM or group DM, renaming a group DM, ringing a DM call, pinning in a
// DM, and setting a custom status. Each is set up before the timeout lands so
// only the timeout can be what refuses it.
func TestTimedOutUser_RefusedOnDMAndPresenceWrites(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	dms := NewDMService(f.database, f.mod.perms)
	channels := NewChannelService(f.database, f.mod.perms)

	group, err := dms.CreateGroupDM(ctx, fixtureMember2, []int64{fixtureMember, fixtureMod}, "before")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	direct, err := dms.CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	sent, err := f.messages.SendMessage(ctx, SendMessageParams{
		ChannelID: direct.Channel.ID, UserID: fixtureMember2, Username: "u5", Content: "hi",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	if _, err := f.mod.Timeout(ctx, fixtureMod, fixtureMember, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}

	if _, err := dms.CreateDM(ctx, fixtureMember, fixtureMod); !errors.Is(err, ErrTimedOut) {
		t.Errorf("new 1:1 DM while timed out = %v, want ErrTimedOut", err)
	}
	if reopened, err := dms.CreateDM(ctx, fixtureMember, fixtureMember2); err != nil || reopened.Created || reopened.Channel.ID != direct.Channel.ID {
		t.Errorf("reopening the existing 1:1 DM while timed out = %+v, %v; want the existing channel", reopened, err)
	}
	if _, err := dms.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "new"); !errors.Is(err, ErrTimedOut) {
		t.Errorf("CreateGroupDM while timed out = %v, want ErrTimedOut", err)
	}
	if _, err := dms.RenameGroupDM(ctx, fixtureMember, group.Channel.ID, "renamed"); !errors.Is(err, ErrTimedOut) {
		t.Errorf("RenameGroupDM while timed out = %v, want ErrTimedOut", err)
	}
	if _, err := dms.RingTargets(ctx, fixtureMember, direct.Channel.ID); !errors.Is(err, ErrTimedOut) {
		t.Errorf("RingTargets while timed out = %v, want ErrTimedOut", err)
	}
	if targets, err := dms.DeclineTargets(ctx, fixtureMember, group.Channel.ID); err != nil || len(targets) != 2 {
		t.Errorf("DeclineTargets while timed out = %v, %v; want the two other members", targets, err)
	}
	if err := f.messages.SetMessagePinned(ctx, fixtureMember, direct.Channel.ID, sent.MessageID, true); !errors.Is(err, ErrTimedOut) {
		t.Errorf("DM pin while timed out = %v, want ErrTimedOut", err)
	}
	status := "look at me"
	if _, err := channels.HandlePresenceUpdate(ctx, fixtureMember, "online", &status, nil); !errors.Is(err, ErrTimedOut) {
		t.Errorf("custom status while timed out = %v, want ErrTimedOut", err)
	}

	// Changing only the presence status, or clearing the custom status,
	// publishes no text of the user's own, so it stays allowed.
	if _, err := channels.HandlePresenceUpdate(ctx, fixtureMember, "idle", nil, nil); err != nil {
		t.Errorf("plain status change while timed out = %v, want nil", err)
	}
	cleared := ""
	if _, err := channels.HandlePresenceUpdate(ctx, fixtureMember, "online", &cleared, nil); err != nil {
		t.Errorf("clearing custom status while timed out = %v, want nil", err)
	}

	// The other participants are not timed out and keep every one of these.
	if _, err := dms.RenameGroupDM(ctx, fixtureMember2, group.Channel.ID, "renamed"); err != nil {
		t.Errorf("RenameGroupDM by a participant who is not timed out = %v", err)
	}
	if _, err := dms.RingTargets(ctx, fixtureMember2, direct.Channel.ID); err != nil {
		t.Errorf("RingTargets by a participant who is not timed out = %v", err)
	}
	if err := f.messages.SetMessagePinned(ctx, fixtureMember2, direct.Channel.ID, sent.MessageID, true); err != nil {
		t.Errorf("DM pin by a participant who is not timed out = %v", err)
	}
}
