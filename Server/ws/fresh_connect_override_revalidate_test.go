package ws

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// A per-channel override that removes READ_MESSAGES and whose visibility walk
// finishes after handleFreshConnect read the allowed set but before registerNow
// leaves the held-role set unchanged. The post-register re-check must still drop
// the inherited channel topic.
func TestFreshConnectFallback_ChannelOverridePreRegister_RevalidatesTopics(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "override-race-user")
	chID := mustCreateTextChannel(t, database, "override-race-channel")
	token := seedSessionToken(t, database, uid)

	rig := newServeRigOn(t, database, nil)
	hub := rig.hub

	pushReplayWindow(hub, chID)
	hub.SeedSeq(100)

	// Force the full-ready fallback without touching roles or overrides.
	handleReconnectPreRegisterRaceHook = func() {
		hub.bumpVisibilityWatermark()
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	var hookRan bool
	freshConnectPreRegisterRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		if err := database.UpsertChannelOverride(ctx, chID, harvestVoiceRoleID, 0, permissions.ReadMessages); err != nil {
			t.Errorf("UpsertChannelOverride: %v", err)
		}
		ch, err := database.GetChannel(ctx, chID)
		if err != nil {
			t.Errorf("GetChannel: %v", err)
			return
		}
		// The walk runs now, before this socket is registered, so it cannot reach it.
		hub.RefreshChannelVisibility(ch)
	}
	defer func() { freshConnectPreRegisterRaceHook = nil }()

	conn := rig.dialAuth(t, ctx, token, 99, chID)

	expectFrame(t, ctx, conn, MsgTypeAuthOK, "")
	expectFrame(t, ctx, conn, MsgTypeReady, " (forced fallback)")
	if !hookRan {
		t.Fatal("freshConnectPreRegisterRaceHook never fired: not exercising the window")
	}

	waitForRegisteredClient(t, hub, uid)
	assertNotSubscribed(t, hub, uid, chID, "post-register override re-check")
}

// A fallback with nothing changed keeps its inherited channel topic and does
// not run the revocation pass.
func TestFreshConnectFallback_NoChange_KeepsInheritedTopic(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "override-steady-user")
	chID := mustCreateTextChannel(t, database, "override-steady-channel")
	token := seedSessionToken(t, database, uid)

	rig := newServeRigOn(t, database, nil)
	hub := rig.hub

	pushReplayWindow(hub, chID)
	hub.SeedSeq(100)

	handleReconnectPreRegisterRaceHook = func() {
		hub.bumpVisibilityWatermark()
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	conn := rig.dialAuth(t, ctx, token, 99, chID)
	expectFrame(t, ctx, conn, MsgTypeAuthOK, "")
	expectFrame(t, ctx, conn, MsgTypeReady, " (forced fallback)")

	waitForRegisteredClient(t, hub, uid)
	if sub := hub.pubsub.subscriberForTest(ChannelTopic(chID), uid); sub == nil {
		t.Errorf("readable inherited channel %d lost its subscription", chID)
	}
}
