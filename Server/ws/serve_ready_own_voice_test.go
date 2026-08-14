package ws_test

// serve_ready_own_voice_test.go — regression test for finding OC-0028:
// buildReady filters voice_states through visibleSet, which is seeded only
// from READ-visible non-DM channels plus the caller's currently-*open* DM
// channels (dm_open_state). Voice membership needs only CONNECT_VOICE
// (voice_join.go), not READ_MESSAGES nor an open DM row, so a user's own
// live voice room can be absent from visibleSet -- the exact hole
// liveVoiceEventsSince patches on the reconnect-replay tier (serve.go) but
// which buildReady, the full-ready tier, never covered. Concretely: a user
// closes a DM from the sidebar while still in that DM's voice call (CloseDM
// only removes dm_open_state; it does not evict from voice), and a
// subsequent full ready wipes their own voice_state row.

import (
	"context"
	"encoding/json"
	"testing"
)

// TestBuildReady_IncludesOwnVoiceStateAfterDMClosed locks that a user's own
// live voice_state row survives buildReady's visibility filter even after
// they close the DM the call lives in. Before the fix, closing the DM
// dropped the channel from both visibleChannels (DM channels are always
// skipped there) and dmChannels (no longer open), so visibleSet had no entry
// for the channel and the user's own voice_state was silently filtered out
// of their own ready payload.
func TestBuildReady_IncludesOwnVoiceStateAfterDMClosed(t *testing.T) {
	hub, database := newServeHub(t)

	viewer := seedServeUser(t, database, "own-voice-viewer")
	other := seedServeUser(t, database, "own-voice-other")
	viewerRole, err := database.GetRoleByID(context.Background(), viewer.RoleID)
	if err != nil || viewerRole == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	dmChannelID := seedDMChannel(t, database, viewer.ID, other.ID)

	// Viewer joins the DM's voice channel, then closes the DM from the
	// sidebar -- mirroring CloseDM's non-group branch, which only removes
	// the caller's dm_open_state row and performs no voice eviction.
	if err := database.JoinVoiceChannel(context.Background(), viewer.ID, dmChannelID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.CloseDM(context.Background(), viewer.ID, dmChannelID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, viewer.ID, viewerRole)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			VoiceStates []struct {
				ChannelID int64 `json:"channel_id"`
				UserID    int64 `json:"user_id"`
			} `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	found := false
	for _, vs := range env.Payload.VoiceStates {
		if vs.ChannelID == dmChannelID && vs.UserID == viewer.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("ready payload's voice_states is missing the viewer's own live call (channel_id=%d, user_id=%d) after closing the DM; got %+v",
			dmChannelID, viewer.ID, env.Payload.VoiceStates)
	}
}
