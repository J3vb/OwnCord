package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

// watermarkVoiceBroadcaster wraps mockBroadcaster and additionally implements
// the optional MarkVisibilityChanged and DisconnectFromVoiceInChannel
// capabilities api's DM handlers check for via type assertions
// (dmVisibilityMarker, dmVoiceEvictor).
type watermarkVoiceBroadcaster struct {
	*mockBroadcaster
	markCalls  int
	evictCalls []evictCall
}

type evictCall struct {
	userID    int64
	channelID int64
}

func (b *watermarkVoiceBroadcaster) MarkVisibilityChanged() {
	b.markCalls++
}

func (b *watermarkVoiceBroadcaster) DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64) bool {
	b.evictCalls = append(b.evictCalls, evictCall{userID, channelID})
	return true
}

// A group DM create is an unsequenced, targeted event — a recipient offline
// or dropping the connection right now can never have it replayed by the
// ordinary seq-based resume, so warm reconnects must be forced onto the
// full-ready path instead (v035).
func TestCreateGroupDM_BumpsVisibilityWatermark(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router := buildDMRouter(database, bc)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
		dmCreateToken(t, database, "carol", 4),
	}

	rr := dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("create group dm: %d %s", rr.Code, rr.Body.String())
	}

	if bc.markCalls < 1 {
		t.Fatalf("MarkVisibilityChanged calls = %d, want at least 1", bc.markCalls)
	}
}

// Leaving a group DM must evict the leaver's voice-call connection, scoped to
// that channel — otherwise they keep hearing and speaking to a room they are
// no longer a member of (v031).
func TestLeaveGroupDM_EvictsLeaverFromVoice(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router := buildDMRouter(database, bc)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
		dmCreateToken(t, database, "carol", 4),
	}

	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.evictCalls = nil

	rr := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", group.ChannelID), tokens[1])
	if rr.Code != http.StatusNoContent {
		t.Fatalf("leave: %d %s", rr.Code, rr.Body.String())
	}

	if len(bc.evictCalls) != 1 || bc.evictCalls[0].userID != 2 || bc.evictCalls[0].channelID != group.ChannelID {
		t.Fatalf("DisconnectFromVoiceInChannel calls = %+v, want exactly one for user=2 channel=%d", bc.evictCalls, group.ChannelID)
	}
}

// Closing a 1:1 DM is a hide, not a leave — the closer's DM membership is
// unchanged, so their voice session (if any) must not be touched.
func TestCloseDM_OneToOneDoesNotEvictVoice(t *testing.T) {
	database := newDMTestDB(t)
	bc := &watermarkVoiceBroadcaster{mockBroadcaster: &mockBroadcaster{}}
	router := buildDMRouter(database, bc)
	tokens := []string{
		dmCreateToken(t, database, "alice", 4),
		dmCreateToken(t, database, "bob", 4),
	}
	rr := dmPost(t, router, "/api/v1/dms", tokens[0], map[string]any{"recipient_id": 2})
	var created struct {
		ChannelID int64 `json:"channel_id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	if delRR := dmDelete(t, router, fmt.Sprintf("/api/v1/dms/%d", created.ChannelID), tokens[0]); delRR.Code != http.StatusNoContent {
		t.Fatalf("close: %d", delRR.Code)
	}

	if len(bc.evictCalls) != 0 {
		t.Fatalf("DisconnectFromVoiceInChannel calls = %+v, want none for a 1:1 close", bc.evictCalls)
	}
}
