package ws_test

import (
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
