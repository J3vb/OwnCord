package ws

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// failOnceStatesVoice fails its first ChannelStates read and serves every later
// one from the wrapped store.
type failOnceStatesVoice struct {
	VoiceStore
	failed atomic.Bool
}

func (f *failOnceStatesVoice) ChannelStates(ctx context.Context, channelID int64) ([]db.VoiceState, error) {
	if f.failed.CompareAndSwap(false, true) {
		return nil, errors.New("states read failed")
	}
	return f.VoiceStore.ChannelStates(ctx, channelID)
}

// A join that is rolled back by its own last step (the roster read failing) must
// put the moderator mute it consumed back on the client, so the retry joins muted.
func TestVoiceJoin_RosterReadFailureKeepsModeratorMuteForRetry(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "stash-user")
	chID := mustCreateVoiceChannel(t, database, "stash-voice")
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: healthyTestLiveKit(t)})
	store := &failOnceStatesVoice{VoiceStore: h.voice}
	h.voice = store

	send := make(chan []byte, 64)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "stash-user"}
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()

	c.voice.stashModFlags(true, false, nil)
	payload, _ := json.Marshal(map[string]any{"channel_id": chID})

	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")
	if !store.failed.Load() {
		t.Fatal("the roster read never failed: the test does not exercise the rollback")
	}
	if len(drainChan(send, 100*time.Millisecond)) == 0 || c.voice.channel() != 0 {
		t.Fatal("the failed join left the client in a call")
	}
	if sm, _ := c.peekPendingModFlagsForHarness(); !sm {
		t.Fatal("the rolled-back join dropped the moderator mute stash")
	}

	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")
	row, err := database.GetVoiceState(context.Background(), uid)
	if err != nil || row == nil {
		t.Fatalf("retried join left no row: %v %v", row, err)
	}
	if !row.ServerMuted {
		t.Fatal("the retried join came back unmuted")
	}
}
