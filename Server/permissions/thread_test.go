package permissions

import (
	"errors"
	"testing"
)

// A thread is visible exactly when its parent's overrides allow READ: the
// override map is keyed by the parent, and the thread's own id has no entry.
func TestVisibleChannelIDs_ThreadUsesParentOverride(t *testing.T) {
	ck := NewChecker(nil)
	base := ReadMessages | SendMessages
	channels := []ChannelRef{
		{ID: 1, Type: "text"},
		{ID: 2, Type: "text"},
		{ID: 10, Type: "thread", AuthorityID: 1},
		{ID: 20, Type: "thread", AuthorityID: 2},
		{ID: 21, Type: "thread", AuthorityID: 2, Archived: true},
	}
	overrides := map[int64]ChannelOverride{
		1: {Deny: ReadMessages},
		// An entry keyed by a thread id is ignored: threads have no overrides.
		10: {Allow: ReadMessages},
	}
	got := ck.VisibleChannelIDs(MemberGrants{Perms: base, Overrides: overrides}, channels)
	want := map[int64]bool{2: true, 20: true}
	if len(got) != len(want) {
		t.Fatalf("visible = %v, want %v", got, want)
	}
	for id := range want {
		if !got[id] {
			t.Errorf("channel %d not visible, want visible", id)
		}
	}
}

func TestThreadLockPredicates(t *testing.T) {
	member := Subject{RolePerms: ReadMessages | SendMessages | AddReactions,
		Channel: ChannelRef{Type: "thread", AuthorityID: 1, ThreadLocked: true}}
	mod := member
	mod.RolePerms |= ManageMessages

	if err := CanSendMessage(member); !errors.Is(err, ErrThreadLocked) {
		t.Errorf("member send = %v, want ErrThreadLocked", err)
	}
	if err := CanType(member); !errors.Is(err, ErrThreadLocked) {
		t.Errorf("member typing = %v, want ErrThreadLocked", err)
	}
	if err := CanAddReaction(member); !errors.Is(err, ErrThreadLocked) {
		t.Errorf("member reaction = %v, want ErrThreadLocked", err)
	}
	if err := CanViewChannel(member); err != nil {
		t.Errorf("member read = %v, want a locked thread readable", err)
	}
	for name, err := range map[string]error{
		"send": CanSendMessage(mod), "react": CanAddReaction(mod), "pin": CanPinMessage(mod),
	} {
		if err != nil {
			t.Errorf("moderator %s = %v, want allowed", name, err)
		}
	}
	unlocked := member
	unlocked.Channel.ThreadLocked = false
	if err := CanSendMessage(unlocked); err != nil {
		t.Errorf("member send in an open thread = %v", err)
	}
	// The lock never outranks a missing bit or a timeout.
	timedOut := mod
	timedOut.TimedOut = true
	if err := CanSendMessage(timedOut); !errors.Is(err, ErrTimedOut) {
		t.Errorf("timed-out moderator = %v, want ErrTimedOut", err)
	}
}
