package ws

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
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

// stashJoin is one user joining one voice channel on a hub whose first roster
// read fails, so the first join is rolled back by its own last step.
type stashJoin struct {
	h       *Hub
	store   *failOnceStatesVoice
	c       *Client
	send    chan []byte
	uid     int64
	chID    int64
	payload json.RawMessage
	row     func() *db.VoiceState
}

func newStashJoin(t *testing.T) *stashJoin {
	t.Helper()
	database := newHarvestVoiceDB(t)
	f := &stashJoin{send: make(chan []byte, 64)}
	f.uid = seedHarvestVoiceUser(t, database, "stash-user")
	f.chID = mustCreateVoiceChannel(t, database, "stash-voice")
	f.h = newTestHubWith(t, HubOptions{DB: database, LiveKit: healthyTestLiveKit(t)})
	f.store = &failOnceStatesVoice{VoiceStore: f.h.voice}
	f.h.voice = f.store
	f.c = NewTestClient(f.h, f.uid, f.send)
	f.c.user = &db.User{ID: f.uid, Username: "stash-user"}
	f.h.mu.Lock()
	f.h.clients[f.uid] = []*Client{f.c}
	f.h.mu.Unlock()
	payload, _ := json.Marshal(map[string]any{"channel_id": f.chID})
	f.payload = payload
	f.row = func() *db.VoiceState {
		t.Helper()
		row, err := database.GetVoiceState(context.Background(), f.uid)
		if err != nil || row == nil {
			t.Fatalf("no voice row: %v %v", row, err)
		}
		return row
	}
	return f
}

// joinRolledBack runs the join whose roster read fails and checks it left no call.
func (f *stashJoin) joinRolledBack(t *testing.T) {
	t.Helper()
	f.h.handleVoiceJoin(context.Background(), f.c, f.payload, "")
	if !f.store.failed.Load() {
		t.Fatal("the roster read never failed: the test does not exercise the rollback")
	}
	if len(drainChan(f.send, 100*time.Millisecond)) == 0 || f.c.voice.channel() != 0 {
		t.Fatal("the failed join left the client in a call")
	}
}

// moderateBeforeTheLastStep has a moderator mute or unmute the member once,
// after the join's row exists and before its last step fails.
func (f *stashJoin) moderateBeforeTheLastStep(t *testing.T, muted bool) {
	t.Helper()
	var once sync.Once
	voiceJoinPostTokenRaceHook = func(c *Client) {
		once.Do(func() {
			if matched, _, _ := f.h.SetServerMuteLocked(context.Background(), f.uid, f.chID, muted); !matched {
				t.Error("the moderator action found no row to change")
			}
		})
	}
	t.Cleanup(func() { voiceJoinPostTokenRaceHook = nil })
}

// A join that is rolled back by its own last step (the roster read failing) must
// put the moderator mute it consumed back on the client, so the retry joins muted.
func TestVoiceJoin_RosterReadFailureKeepsModeratorMuteForRetry(t *testing.T) {
	f := newStashJoin(t)
	f.c.voice.stashModFlags(true, false, nil)

	f.joinRolledBack(t)
	if sm, _ := f.c.peekPendingModFlagsForHarness(); !sm {
		t.Fatal("the rolled-back join dropped the moderator mute stash")
	}

	f.h.handleVoiceJoin(context.Background(), f.c, f.payload, "")
	if !f.row().ServerMuted {
		t.Fatal("the retried join came back unmuted")
	}
}

// A moderator's change that lands on the join's row before its last step fails
// is what the retry carries, not the flags the join started with.
func TestVoiceJoin_RosterReadFailureCarriesWhatTheRowHeld(t *testing.T) {
	for _, tc := range []struct {
		name            string
		startMuted      bool
		moderatorMutes  bool
		wantRetryMuted  bool
		wrongRetryState string
	}{
		{"an unmute during the join stays an unmute", true, false, false, "the retry brought back a mute the moderator had cleared"},
		{"a mute during the join is carried", false, true, true, "the retry lost a mute the moderator was told is applied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newStashJoin(t)
			if tc.startMuted {
				f.c.voice.stashModFlags(true, false, nil)
			}
			f.moderateBeforeTheLastStep(t, tc.moderatorMutes)

			f.joinRolledBack(t)
			if sm, _ := f.c.peekPendingModFlagsForHarness(); sm != tc.wantRetryMuted {
				t.Fatalf("pending mute after the rollback = %v, want %v", sm, tc.wantRetryMuted)
			}

			f.h.handleVoiceJoin(context.Background(), f.c, f.payload, "")
			if f.row().ServerMuted != tc.wantRetryMuted {
				t.Fatal(tc.wrongRetryState)
			}
		})
	}
}
