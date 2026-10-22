package ws

import (
	"context"
	"github.com/J3vb/OwnCord/Server/permissions"
	"testing"
	"time"
)

func TestCarriesChatState_IncludesThreads(t *testing.T) {
	for typ, want := range map[string]bool{
		"text": true, "announcement": true, "voice": true, "thread": true,
		"dm": false, "category": false, "": false,
	} {
		if got := carriesChatState(typ); got != want {
			t.Errorf("carriesChatState(%q) = %v, want %v", typ, got, want)
		}
	}
}

// A held thread takes its parent's NSFW label and consent in the readable set.
func TestComputeReadableChannels_ThreadFollowsParentConsent(t *testing.T) {
	f := newThreadWSFixture(t)
	ctx := context.Background()
	c, _ := f.connect(t, "nsfwreader")
	allowed := func() map[int64]bool { return map[int64]bool{f.parent: true, f.thread: true} }

	// Unlabelled parent: both stay readable, the thread included.
	got, err := f.hub.computeReadableChannels(ctx, f.database, c.user, allowed())
	if err != nil || !got[f.parent] || !got[f.thread] {
		t.Fatalf("unlabelled: %v, %v", got, err)
	}

	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.parent); err != nil {
		t.Fatal(err)
	}
	got, err = f.hub.computeReadableChannels(ctx, f.database, c.user, allowed())
	if err != nil || got[f.parent] || got[f.thread] {
		t.Fatalf("labelled and unacknowledged: %v, %v, want neither readable", got, err)
	}

	// A thread not in the allowed set is never added by the narrowing.
	got, err = f.hub.computeReadableChannels(ctx, f.database, c.user, map[int64]bool{f.parent: true})
	if err != nil || got[f.thread] || got[f.parent] {
		t.Fatalf("parent only: %v, %v", got, err)
	}

	if _, err := f.database.AcknowledgeNSFW(ctx, c.userID, f.parent); err != nil {
		t.Fatal(err)
	}
	got, err = f.hub.computeReadableChannels(ctx, f.database, c.user, allowed())
	if err != nil || !got[f.parent] || !got[f.thread] {
		t.Fatalf("acknowledged: %v, %v, want both readable", got, err)
	}
}

func TestComputeReadableChannels_ReadFailureIsAnError(t *testing.T) {
	f := newThreadWSFixture(t)
	c, _ := f.connect(t, "failing")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, err := f.hub.computeReadableChannels(ctx, f.database, c.user, map[int64]bool{f.thread: true}); err == nil {
		t.Errorf("a cancelled read produced %v, want an error", got)
	}
}

func TestAdmitHeldThread_NeedsAVisibleParent(t *testing.T) {
	f := newThreadWSFixture(t)
	ctx := context.Background()
	c, _ := f.connect(t, "holder")

	// No thread held: nothing is added.
	allowed := map[int64]bool{f.parent: true}
	if err := f.hub.admitHeldThread(ctx, f.database, c.userID, allowed); err != nil || allowed[f.thread] {
		t.Fatalf("empty slot: %v, %v", allowed, err)
	}
	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != f.thread {
		t.Fatal("setup: focus refused")
	}
	if err := f.hub.admitHeldThread(ctx, f.database, c.userID, allowed); err != nil || !allowed[f.thread] {
		t.Fatalf("visible parent: %v, %v, want the held thread admitted", allowed, err)
	}
	// The thread alone never admits itself: a parent the user cannot see admits nothing.
	hidden := map[int64]bool{}
	if err := f.hub.admitHeldThread(ctx, f.database, c.userID, hidden); err != nil || hidden[f.thread] {
		t.Fatalf("hidden parent: %v, %v", hidden, err)
	}
	// A user with no live socket is a no-op.
	none := map[int64]bool{f.parent: true}
	if err := f.hub.admitHeldThread(ctx, f.database, 987654, none); err != nil || len(none) != 1 {
		t.Fatalf("no socket: %v, %v", none, err)
	}
	// A failing read is surfaced.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := f.hub.admitHeldThread(cancelled, f.database, c.userID, map[int64]bool{f.parent: true}); err == nil {
		t.Error("a failing channel read was swallowed")
	}
}

func TestRevokeHeldThread_ReleasesOnlyTheLostParentsThread(t *testing.T) {
	f := newThreadWSFixture(t)
	ctx := context.Background()
	c, send := f.connect(t, "revokee")

	f.hub.revokeHeldThread(ctx, c, f.parent) // nothing held: no-op
	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != f.thread {
		t.Fatal("setup: focus refused")
	}
	f.hub.revokeHeldThread(ctx, c, f.parent+1000) // another parent was lost: the thread stays
	if c.getThreadID() != f.thread {
		t.Fatal("a revoke of an unrelated parent released the thread")
	}
	f.hub.revokeHeldThread(ctx, c, f.parent)
	if c.getThreadID() != 0 {
		t.Fatalf("slot = %d after its parent was revoked, want 0", c.getThreadID())
	}
	f.hub.BroadcastToChannel(f.thread, []byte(`{"type":"chat_message","payload":{}}`))
	if got := drainFor(send, 200*time.Millisecond); countType(got, "chat_message") != 0 {
		t.Errorf("a released socket still hears the thread: %q", got)
	}

	// A thread that cannot be resolved counts as belonging, so a failure revokes.
	f.hub.applyThreadFocus(c, f.thread)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	f.hub.revokeHeldThread(cancelled, c, f.parent+1000)
	if c.getThreadID() != 0 {
		t.Errorf("an unresolvable thread was kept: slot %d", c.getThreadID())
	}
}

func TestRoleThreadVerdict_InheritsTheParents(t *testing.T) {
	f := newThreadWSFixture(t)
	ctx := context.Background()
	c, _ := f.connect(t, "verdict")
	ch, err := f.database.GetChannel(ctx, f.thread)
	if err != nil || ch == nil || !ch.IsThread() {
		t.Fatalf("GetChannel: %+v, %v", ch, err)
	}
	for _, decided := range []bool{true, false} {
		got, err := f.hub.roleThreadVerdict(ctx, c.userID, ch, map[int64]bool{f.parent: decided})
		if err != nil || got != decided {
			t.Errorf("round verdict %v: got %v, %v", decided, got, err)
		}
	}
	// Parent not in the round: resolved live through the thread's subject.
	got, err := f.hub.roleThreadVerdict(ctx, c.userID, ch, map[int64]bool{})
	if err != nil || !got {
		t.Errorf("live verdict for a reader = %v, %v, want true", got, err)
	}
	// The parent now denies READ: the live verdict follows it.
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		f.parent, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	if got, err := f.hub.roleThreadVerdict(ctx, c.userID, ch, map[int64]bool{}); err != nil || got {
		t.Errorf("live verdict after the parent denied READ = %v, %v, want false", got, err)
	}
}
