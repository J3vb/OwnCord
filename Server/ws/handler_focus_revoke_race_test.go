package ws_test

import (
	"context"
	"testing"

	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// TestApplySetChannelID_RevalidatesAfterConcurrentRevoke pins OC-0024: the
// channel_focus applier (Hub.applySetChannelID, run from handleMessage after
// the service-layer READ_MESSAGES check already passed) must not leave a
// socket subscribed to a channel's pub/sub topic once access is gone.
//
// service.HandleChannelFocus's permission check and the applier's Subscribe
// call are separated by two SQLite round trips (GetLatestMessageID,
// UpdateReadState). A revoke (channel_overrides deny + admin's
// RefreshChannelVisibility sweep) that commits inside that window finds the
// client not yet subscribed — Unsubscribe is a no-op and c.channelID doesn't
// match yet — so the sweep does nothing, and the applier's Subscribe lands
// right after with no further sweep ever revisiting it. This test reproduces
// that ordering directly: the deny override is already committed by the time
// the applier runs, exactly as it would be had the revoke landed first.
func TestApplySetChannelID_RevalidatesAfterConcurrentRevoke(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-race-user")
	chOld := seedTestChannel(t, database, "focus-race-old")
	chNew := seedTestChannel(t, database, "focus-race-new")

	// Simulate the admin's revoke having already committed before the
	// applier runs: deny READ_MESSAGES for Member on the channel the focus
	// handler already cleared the user for.
	denyReadOnChannel(t, database, chNew, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chOld, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// This is exactly what handleMessage's applier runs for a channel_focus
	// result carrying SetChannelID: &chNew — the READ check already happened
	// (and passed, before the revoke) inside the handler; only the
	// subscribe-and-focus side effect is left to apply.
	hub.ApplySetChannelIDForTest(c, chNew)

	if hub.SubscribedToChannelTopicForTest(c, chNew) {
		t.Error("client is subscribed to a channel topic it no longer has READ_MESSAGES on")
	}
	if got := ws.ClientChannelIDForTest(c); got != 0 {
		t.Errorf("client channelID = %d, want 0 (focus must not stick to an unreadable channel)", got)
	}
}

// TestApplySetChannelID_AllowedChannel_SubscribesAndFocuses is the control:
// when access is still valid at apply time, the applier must subscribe and
// focus normally (the re-validation must not be a blanket deny).
func TestApplySetChannelID_AllowedChannel_SubscribesAndFocuses(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-ok-user")
	chOld := seedTestChannel(t, database, "focus-ok-old")
	chNew := seedTestChannel(t, database, "focus-ok-new")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chOld, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.ApplySetChannelIDForTest(c, chNew)

	if !hub.SubscribedToChannelTopicForTest(c, chNew) {
		t.Error("client should be subscribed to the newly focused, readable channel")
	}
	if got := ws.ClientChannelIDForTest(c); got != chNew {
		t.Errorf("client channelID = %d, want %d", got, chNew)
	}
}

// TestApplySetChannelID_DMParticipantWithoutRead_KeepsFocus: the admission
// gate (service.HandleChannelFocus) deliberately waives the READ_MESSAGES
// role bit for DM channels — a DM is participant-gated, not role-gated. The
// applier's re-validation must mirror that, or a DM participant whose role
// lacks READ on the channel gets every focus silently unwound and their DM
// message stream never arrives.
func TestApplySetChannelID_DMParticipantWithoutRead_KeepsFocus(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-dm-user")
	other := seedMemberUser(t, database, "focus-dm-other")
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), user.ID, other.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// A deny-READ override on the DM channel: the focus admission gate never
	// consults it for DMs, so the applier's recheck must not either.
	denyReadOnChannel(t, database, dm.ID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.ApplySetChannelIDForTest(c, dm.ID)

	if !hub.SubscribedToChannelTopicForTest(c, dm.ID) {
		t.Error("DM participant must stay subscribed to their own DM regardless of the READ role bit")
	}
	if got := ws.ClientChannelIDForTest(c); got != dm.ID {
		t.Errorf("client channelID = %d, want %d (DM focus must stick)", got, dm.ID)
	}
}

// TestApplySetChannelID_DeletedChannel_Unwinds: a channel deleted between the
// admission gate and the applier mirrors the admission gate's own answer for
// a missing row (NotFound): the subscription is unwound, matching the delete
// sweep the client will also receive.
func TestApplySetChannelID_DeletedChannel_Unwinds(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-del-user")
	ch := seedTestChannel(t, database, "focus-del-chan")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	if err := database.DeleteChannel(context.Background(), ch); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	hub.ApplySetChannelIDForTest(c, ch)

	if hub.SubscribedToChannelTopicForTest(c, ch) {
		t.Error("client must not stay subscribed to a deleted channel's topic")
	}
	if got := ws.ClientChannelIDForTest(c); got != 0 {
		t.Errorf("client channelID = %d, want 0 after focusing a deleted channel", got)
	}
}

// TestApplySetChannelID_TransientLookupError_KeepsFocus: the re-validation
// exists to catch a concrete revoke that landed inside the Subscribe race
// window. On a transient lookup failure there is no positive denial — the
// sweeps stay authoritative — so the freshly admitted focus must be kept:
// unwinding would turn any DB hiccup into a silently dead message stream
// with no error frame sent to the client.
func TestApplySetChannelID_TransientLookupError_KeepsFocus(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-err-user")
	ch := seedTestChannel(t, database, "focus-err-chan")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Closing the DB makes every lookup in the recheck error — the closest
	// deterministic stand-in for a transient failure on those queries.
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	hub.ApplySetChannelIDForTest(c, ch)

	if !hub.SubscribedToChannelTopicForTest(c, ch) {
		t.Error("a transient lookup failure must not unwind a just-admitted focus")
	}
	if got := ws.ClientChannelIDForTest(c); got != ch {
		t.Errorf("client channelID = %d, want %d (focus must survive a transient lookup error)", got, ch)
	}
}
