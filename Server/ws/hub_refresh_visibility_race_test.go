package ws

// hub_refresh_visibility_race_test.go — regression test for OC-0205.
//
// RefreshChannelVisibility snapshots h.clients once, then for every entry
// resolves the user's CURRENT visibility via one or two DB round trips
// (h.db.GetUserByID + h.db.GetRoleByID in the bare-hub branch exercised
// here, or a PermissionService lookup otherwise) before acting on the
// snapshotted *Client pointer with sendMsg / Unsubscribe / a channelID
// clear. A reconnect landing during those per-client lookups replaces the
// snapshotted client with a new connection under the same user ID —
// h.clients[userID] now points at the new client, and PubSub.Unsubscribe's
// identity guard silently no-ops when asked to strip a topic from a client
// that is no longer the current holder. Acting on the stale pointer
// therefore reaches a dead socket and leaves the live replacement with
// whatever subscription/channelID it already had, exactly inverted from
// what the fan-out just decided.
//
// The DB round trips are too fast to land a real reconnect goroutine inside
// reliably, so refreshChannelVisibilityRaceHook (test-only, nil in
// production) fires at exactly that point, mirroring the established
// voiceJoinPostTokenRaceHook / cleanupVoiceRaceClearHook pattern used to pin
// the analogous races elsewhere in this package.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestRefreshChannelVisibility_ReconnectDuringFanOutActsOnLiveClient(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "refresh-race-user")
	chID := mustCreateVoiceChannel(t, database, "refresh-race-channel")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}

	// Bare hub (svc=nil): h.perms is nil, so RefreshChannelVisibility takes the
	// GetUserByID+GetRoleByID branch this test targets.
	h := newTestHub(t, database, auth.NewRateLimiter(), nil)

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	sendA := make(chan []byte, 8)
	a := NewTestClientWithUser(h, user, chID, sendA)
	h.RegisterNowForTest(a)
	if !h.SubscribedToChannelTopicForTest(a, chID) {
		t.Fatal("setup: original client not subscribed to its focused channel")
	}

	// Revoke READ_MESSAGES for the harvest-voice role on this channel — this is
	// the channel_overrides change that makes RefreshChannelVisibility decide
	// the fan-out target must lose the channel.
	if err := database.UpsertChannelOverride(ctx, chID, harvestVoiceRoleID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	sendB := make(chan []byte, 8)
	var hookRan bool
	refreshChannelVisibilityRaceHook = func(userID int64) {
		if userID != uid {
			return
		}
		hookRan = true
		// Simulate a reconnect landing exactly between the permission lookup
		// above and the send/unsubscribe below: a fresh connection replaces
		// the original in h.clients under the same user ID, exactly as
		// registerNow does for a real reconnect.
		b := NewTestClientWithUser(h, user, chID, sendB)
		h.RegisterNowForTest(b)
	}
	defer func() { refreshChannelVisibilityRaceHook = nil }()

	h.RefreshChannelVisibility(ch)

	if !hookRan {
		t.Fatal("refreshChannelVisibilityRaceHook never fired — test setup is broken, not exercising the race window")
	}

	// The live replacement, not the stale snapshot pointer, must receive the
	// channel_delete.
	select {
	case raw := <-sendB:
		var env struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("unmarshal message to replacement client: %v", err)
		}
		if env.Type != "channel_delete" {
			t.Errorf("replacement client got type %q, want channel_delete", env.Type)
		}
	case <-time.After(time.Second):
		t.Error("replacement client received nothing — RefreshChannelVisibility acted on the stale, replaced connection instead")
	}

	// Look up the live client via the hub rather than the hook's closure
	// variable, so the assertion reflects what RefreshChannelVisibility
	// actually left behind.
	live := h.GetClient(uid)
	if live == nil {
		t.Fatal("no client registered for user after RefreshChannelVisibility")
	}
	if h.SubscribedToChannelTopicForTest(live, chID) {
		t.Error("replacement client is still subscribed to the channel topic RefreshChannelVisibility decided it must lose")
	}
	if got := live.getChannelID(); got != 0 {
		t.Errorf("replacement client channelID = %d, want 0 (focus must clear on the live client, not a dead one)", got)
	}
}
