package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
)

// rosterBroadcaster adds the optional dmVoiceRosterSender capability to the
// recording double: for each participant of the call it logs one voice_state
// event addressed to the user, in the same ordered log as the opens and rows.
type rosterBroadcaster struct {
	*recordingBroadcaster
	participants map[int64][]int64 // channel -> users in the call
}

func (b *rosterBroadcaster) SendDMVoiceRoster(_ context.Context, userID, channelID int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, p := range b.participants[channelID] {
		if p == userID {
			continue
		}
		b.events = append(b.events, recordedEvent{
			kind: "voice_state", user: userID,
			payload: map[string]any{"channel_id": float64(channelID), "user_id": float64(p)},
		})
	}
}

func newRosterMembersFixture(t *testing.T, inCall ...int64) (*membersFixture, *recordingBroadcaster) {
	t.Helper()
	database := newDMTestDB(t)
	rec := &recordingBroadcaster{}
	bc := &rosterBroadcaster{recordingBroadcaster: rec, participants: map[int64][]int64{}}
	router := buildLimitedDMRouter(database, bc, nil)
	tokens := make([]string, 0, 5)
	for _, name := range []string{"alice", "bob", "carol", "dave", "erin"} {
		tokens = append(tokens, dmCreateToken(t, database, name, 4))
	}
	group := decodeDMInfo(t, dmPost(t, router, "/api/v1/dms/group", tokens[0], map[string]any{
		"recipient_ids": []int64{2, 3},
	}))
	bc.participants[group.ChannelID] = inCall
	rec.reset()
	return &membersFixture{database: database, router: router, bc: rec, tokens: tokens, group: group.ChannelID}, rec
}

func TestAddMembers_AddedUserGetsVoiceRosterAfterOpen(t *testing.T) {
	f, rec := newRosterMembersFixture(t, 1, 3) // alice and carol are in the call
	if rr := f.add(t, 1, 4); rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}
	kinds := rec.kinds()
	openAt := slices.Index(kinds, "open:4")
	first := slices.Index(kinds, "voice_state:4")
	if openAt < 0 || first < 0 || first < openAt {
		t.Fatalf("dave's voice_state must follow his dm_channel_open: %v", kinds)
	}
	var states []int64
	for _, e := range rec.events {
		if e.kind == "voice_state" {
			if e.user != 4 {
				t.Errorf("voice_state sent to user %d, want only the added user 4", e.user)
			}
			states = append(states, int64(e.payload["user_id"].(float64)))
		}
	}
	if !slices.Equal(states, []int64{1, 3}) {
		t.Errorf("roster participants = %v, want [1 3]", states)
	}
}

func TestAddMembers_NoVoiceRosterWhenNobodyInCall(t *testing.T) {
	f, rec := newRosterMembersFixture(t)
	if rr := f.add(t, 1, 4); rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}
	if slices.Contains(rec.kinds(), "voice_state:4") {
		t.Errorf("no voice_state expected for an idle group: %v", rec.kinds())
	}
}

func TestAddMembers_BroadcasterWithoutRosterCapabilityStillAdds(t *testing.T) {
	f := newMembersFixture(t) // plain recordingBroadcaster: no SendDMVoiceRoster
	if rr := f.add(t, 1, 4); rr.Code != http.StatusOK {
		t.Fatalf("add: %d %s", rr.Code, rr.Body.String())
	}
}
