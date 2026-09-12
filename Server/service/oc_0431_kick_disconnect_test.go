package service

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeKickDisconnectNotifier is a ModActionNotifier that also implements
// sessionDisconnector, like *ws.Hub does — forceLogout (OC-0431) must
// type-assert s.notifier to this shape and disconnect the target's live
// socket immediately, the same way recovery.go's redemption path and
// profile_handler.go's sign-out-everywhere path already do.
type fakeKickDisconnectNotifier struct {
	mu           sync.Mutex
	disconnected []int64
}

func (f *fakeKickDisconnectNotifier) NotifyModAction(int64, int64, string, string, *time.Time) {}

func (f *fakeKickDisconnectNotifier) DisconnectRevokedUser(userID int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disconnected = append(f.disconnected, userID)
}

func (f *fakeKickDisconnectNotifier) calls() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.disconnected...)
}

// TestForceLogout_DisconnectsLiveSocket is OC-0431: ForceLogout ("Kick")
// deletes every session row of the target but, without this, never drops
// their live WebSocket — it would keep receiving broadcasts and sending
// frames for up to 30 seconds until the hub's sweep catches the now-missing
// session row. Every sibling revocation path (self sign-out-everywhere,
// account recovery, ban) already disconnects synchronously; kick — the one
// action whose entire purpose is immediate ejection — must too.
func TestForceLogout_DisconnectsLiveSocket(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()

	notifier := &fakeKickDisconnectNotifier{}
	f.mod.SetNotifier(notifier)

	if err := f.mod.ForceLogout(ctx, fixtureMod, fixtureMember); err != nil {
		t.Fatalf("ForceLogout: %v", err)
	}

	got := notifier.calls()
	if len(got) != 1 || got[0] != fixtureMember {
		t.Fatalf("DisconnectRevokedUser calls = %v, want exactly [%d]", got, fixtureMember)
	}
}
