package ws_test

// serve_ready_dm_voice_test.go — regression test for finding v016: buildReady
// filtered voice_states through visibleSet, which is built only from
// permissions.Checker.VisibleChannelIDs — a predicate that deliberately skips
// every DM channel (DM visibility is membership-based, not role-based). That
// meant a DM voice call could never appear in a full ready payload, so a
// mid-call full re-sync (e.g. after a brief WS drop that fails replay) wiped
// the client's DM voice roster even though the call was still live.

import (
	"context"
	"encoding/json"
	"testing"
)

// TestBuildReady_IncludesDMVoiceStates locks that a voice_state for an open DM
// channel survives buildReady's visibility filter. Before the fix, visibleSet
// was seeded only from visibleChannels (server channels gated on
// READ_MESSAGES), so this DM's voice state was silently dropped.
func TestBuildReady_IncludesDMVoiceStates(t *testing.T) {
	hub, database := newServeHub(t)

	viewer := seedServeUser(t, database, "dm-voice-viewer")
	other := seedServeUser(t, database, "dm-voice-other")
	viewerRole, err := database.GetRoleByID(context.Background(), viewer.RoleID)
	if err != nil || viewerRole == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}

	dmChannelID := seedDMChannel(t, database, viewer.ID, other.ID)

	// The other participant joins the DM's voice channel.
	if err := database.JoinVoiceChannel(context.Background(), other.ID, dmChannelID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
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
		if vs.ChannelID == dmChannelID && vs.UserID == other.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("ready payload's voice_states is missing the DM call (channel_id=%d, user_id=%d); got %+v",
			dmChannelID, other.ID, env.Payload.VoiceStates)
	}
}
