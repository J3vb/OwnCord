package ws_test

// nsfw_readability_agreement_test.go is channel_visibility_agreement_test.go's
// B5-7 sibling: visibility (can the user see the channel at all) is unchanged
// by this step, but READABILITY (can the user see its CONTENT) is a new,
// narrower question the same three sites must still agree on — REST
// (MessageService.ReadableChannelIDs), the ws ready payload (nsfw +
// nsfw_acknowledged together), and reconnect replay filtering
// (computeReadableChannels). A drift here would leak search hits, replay
// content or a stale ready flag from a labelled channel a user has not
// acknowledged.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestChannelReadability_RESTWSReplayAgreement(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, nil)
	svc := service.New(database, limiter)

	plainID, err := database.CreateChannel(context.Background(), "plain", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel plain: %v", err)
	}
	labelledID, err := database.CreateChannel(context.Background(), "labelled", "text", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel labelled: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = 1 WHERE id = ?`, labelledID); err != nil {
		t.Fatalf("label channel: %v", err)
	}

	user := seedVisibilityUser(t, database, "readability-user", 4) // Member
	role, err := database.GetRoleByID(context.Background(), user.RoleID)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	// readableSets resolves all three sites' readable set for the fixed user.
	readableSets := func() (restSet, readySet, replaySet map[int64]bool) {
		// 1) REST: MessageService.ReadableChannelIDs.
		restIDs, err := svc.Messages.ReadableChannelIDs(context.Background(), user.ID)
		if err != nil {
			t.Fatalf("ReadableChannelIDs: %v", err)
		}
		restSet = idSet(restIDs)

		// 2) WS ready payload: readable iff !nsfw || nsfw_acknowledged.
		readyRaw, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
		if err != nil {
			t.Fatalf("BuildReadyWithRoleForTest: %v", err)
		}
		var ready struct {
			Payload struct {
				Channels []struct {
					ID               int64 `json:"id"`
					NSFW             bool  `json:"nsfw"`
					NSFWAcknowledged bool  `json:"nsfw_acknowledged"`
				} `json:"channels"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(readyRaw, &ready); err != nil {
			t.Fatalf("unmarshal ready: %v", err)
		}
		readySet = map[int64]bool{}
		for _, ch := range ready.Payload.Channels {
			if !ch.NSFW || ch.NSFWAcknowledged {
				readySet[ch.ID] = true
			}
		}

		// 3) Reconnect replay: computeAllowedChannels then narrowed by
		// computeReadableChannels.
		allowed, err := hub.ComputeAllowedChannelsForTest(database, user)
		if err != nil {
			t.Fatalf("ComputeAllowedChannelsForTest: %v", err)
		}
		replaySet, err = hub.ComputeReadableChannelsForTest(database, user, allowed)
		if err != nil {
			t.Fatalf("ComputeReadableChannelsForTest: %v", err)
		}
		return restSet, readySet, replaySet
	}

	assertAllAgree := func(want map[int64]bool) {
		t.Helper()
		restSet, readySet, replaySet := readableSets()
		for label, got := range map[string]map[int64]bool{
			"REST ReadableChannelIDs": restSet,
			"WS ready":                readySet,
			"replay computeReadable":  replaySet,
		} {
			if !equalSets(got, want) {
				t.Errorf("%s = %v, want %v", label, sortedKeys(got), sortedKeys(want))
			}
		}
	}

	// Before acknowledging: both channels visible, only the plain one readable.
	assertAllAgree(idSet([]int64{plainID}))

	// After acknowledging: both readable.
	if err := database.AcknowledgeNSFW(context.Background(), user.ID, labelledID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	assertAllAgree(idSet([]int64{plainID, labelledID}))

	// After revoking: back to just the plain one, on the next read (no cache).
	if err := database.RevokeNSFW(context.Background(), user.ID, labelledID); err != nil {
		t.Fatalf("RevokeNSFW: %v", err)
	}
	assertAllAgree(idSet([]int64{plainID}))
}
