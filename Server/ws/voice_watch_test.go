package ws

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

func watchCode(t *testing.T, r Result) string {
	t.Helper()
	var ce ClientError
	if !errors.As(r.Error, &ce) {
		t.Fatalf("want a ClientError, got %v", r.Error)
	}
	return ce.Code
}

func runWatch(deps VoiceDeps, uid, chID int64, ids []int64) Result {
	return handleVoiceWatchV2(context.Background(), VoiceWatchCmd{userID: uid, UserIDs: ids},
		ClientInfo{UserID: uid, VoiceChannelID: chID}, deps)
}

func TestVoiceWatchV2_NotInVoice(t *testing.T) {
	if got := watchCode(t, runWatch(VoiceDeps{}, 1, 0, []int64{2})); got != ErrCodeVoiceError {
		t.Errorf("code = %q, want %q", got, ErrCodeVoiceError)
	}
}

func TestVoiceWatchV2_TooManyIDs(t *testing.T) {
	ids := make([]int64, voiceWatchMaxIDs+1)
	for i := range ids {
		ids[i] = int64(i + 2)
	}
	if got := watchCode(t, runWatch(VoiceDeps{}, 1, 5, ids)); got != ErrCodeBadPayload {
		t.Errorf("code = %q, want %q", got, ErrCodeBadPayload)
	}
	if r := runWatch(VoiceDeps{}, 1, 5, ids[:voiceWatchMaxIDs]); r.Error != nil {
		t.Errorf("exactly %d ids must be accepted: %v", voiceWatchMaxIDs, r.Error)
	}
}

func TestVoiceWatchV2_RateLimited(t *testing.T) {
	deps := VoiceDeps{Limiter: auth.NewRateLimiter()}
	for i := range voiceWatchRateLimit {
		if r := runWatch(deps, 1, 5, nil); r.Error != nil {
			t.Fatalf("call %d refused: %v", i, r.Error)
		}
	}
	if got := watchCode(t, runWatch(deps, 1, 5, nil)); got != ErrCodeRateLimited {
		t.Errorf("code = %q, want %q", got, ErrCodeRateLimited)
	}
	if r := runWatch(deps, 2, 5, nil); r.Error != nil {
		t.Errorf("another user shares the budget: %v", r.Error)
	}
}

func TestVoiceWatchV2_NormalisesSet(t *testing.T) {
	r := runWatch(VoiceDeps{}, 3, 9, []int64{8, 3, -1, 0, 5, 8, 2, 5})
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	if len(r.Events) != 0 {
		t.Errorf("handler must not emit events, got %d", len(r.Events))
	}
	want := []int64{2, 5, 8}
	if r.SetVoiceWatching == nil || r.SetVoiceWatching.chID != 9 || !reflect.DeepEqual(r.SetVoiceWatching.ids, want) {
		t.Errorf("SetVoiceWatching = %+v, want ch 9 ids %v", r.SetVoiceWatching, want)
	}
}

func TestVoiceWatchV2_EmptyListIsValid(t *testing.T) {
	r := runWatch(VoiceDeps{}, 1, 4, []int64{})
	if r.Error != nil || r.SetVoiceWatching == nil || len(r.SetVoiceWatching.ids) != 0 {
		t.Errorf("empty list: result %+v", r)
	}
}

func TestBuildVoiceWatching_ShapeNeverNull(t *testing.T) {
	for _, ids := range [][]int64{nil, {}} {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID  int64   `json:"user_id"`
				UserIDs []int64 `json:"user_ids"`
			} `json:"payload"`
		}
		raw := buildVoiceWatching(7, ids)
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		if env.Type != "voice_watching" || env.Payload.UserID != 7 || env.Payload.UserIDs == nil {
			t.Errorf("frame %s", raw)
		}
	}
}

// voiceWatchClient registers a client in voice channel chID, subscribed to the
// voice topic like a real participant.
func voiceWatchClient(h *Hub, uid, chID int64) (*Client, chan []byte) {
	send := make(chan []byte, 32)
	c := NewTestClient(h, uid, send)
	c.sendHigh = send
	c.sendLow = send
	c.voice.voiceChID = chID
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()
	h.pubsub.Subscribe(c, VoiceTopic(chID))
	return c, send
}

func watchFrames(t *testing.T, ch chan []byte) []struct {
	UserID  int64
	UserIDs []int64
} {
	t.Helper()
	var out []struct {
		UserID  int64
		UserIDs []int64
	}
	for _, m := range drainChan(ch, 100*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				UserID  int64   `json:"user_id"`
				UserIDs []int64 `json:"user_ids"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil || env.Type != MsgTypeVoiceWatching {
			continue
		}
		out = append(out, struct {
			UserID  int64
			UserIDs []int64
		}{env.Payload.UserID, env.Payload.UserIDs})
	}
	return out
}

func applyWatch(h *Hub, c *Client, chID int64, ids []int64) {
	h.handleMessageApply(context.Background(), context.Background(), c, envelope{Type: MsgTypeVoiceWatch}, "",
		Result{SetVoiceWatching: &voiceWatchSet{chID: chID, ids: ids}}, time.Now())
}

func TestVoiceWatch_RelaysToChannelExceptSender(t *testing.T) {
	h := newEmitTestHub()
	a, aSend := voiceWatchClient(h, 1, 50)
	_, bSend := voiceWatchClient(h, 2, 50)
	_, otherSend := voiceWatchClient(h, 3, 60)

	applyWatch(h, a, 50, []int64{2, 3})

	if got := a.voice.watchingCopy(); !reflect.DeepEqual(got, []int64{2, 3}) {
		t.Errorf("stored = %v", got)
	}
	frames := watchFrames(t, bSend)
	if len(frames) != 1 || frames[0].UserID != 1 || !reflect.DeepEqual(frames[0].UserIDs, []int64{2, 3}) {
		t.Errorf("peer frames = %+v", frames)
	}
	if f := watchFrames(t, aSend); len(f) != 0 {
		t.Errorf("sender got its own frame: %+v", f)
	}
	if f := watchFrames(t, otherSend); len(f) != 0 {
		t.Errorf("other channel got a frame: %+v", f)
	}
}

func TestVoiceWatch_StaleChannelNotStoredOrRelayed(t *testing.T) {
	h := newEmitTestHub()
	a, _ := voiceWatchClient(h, 1, 50)
	_, oldSend := voiceWatchClient(h, 2, 50)
	_, newSend := voiceWatchClient(h, 3, 60)

	// The handler decided against channel 50, then the slot moved to 60.
	a.voice.setState(60, "tok")
	applyWatch(h, a, 50, []int64{2})

	if got := a.voice.watchingCopy(); len(got) != 0 {
		t.Errorf("stale frame stored: %v", got)
	}
	if f := watchFrames(t, oldSend); len(f) != 0 {
		t.Errorf("old channel got a frame: %+v", f)
	}
	if f := watchFrames(t, newSend); len(f) != 0 {
		t.Errorf("new channel got a frame: %+v", f)
	}
}

func TestSendVoicePeerWatching_OnlyNonEmptyPeers(t *testing.T) {
	h := newEmitTestHub()
	joiner, jSend := voiceWatchClient(h, 1, 50)
	p2, _ := voiceWatchClient(h, 2, 50)
	voiceWatchClient(h, 3, 50) // watches nothing
	p4, _ := voiceWatchClient(h, 4, 60)
	p2.voice.setWatchingIfChannel(50, []int64{1, 3})
	p4.voice.setWatchingIfChannel(60, []int64{1})
	joiner.voice.setWatchingIfChannel(50, []int64{2})

	h.sendVoicePeerWatching(joiner, 50)

	frames := watchFrames(t, jSend)
	if len(frames) != 1 || frames[0].UserID != 2 || !reflect.DeepEqual(frames[0].UserIDs, []int64{1, 3}) {
		t.Errorf("frames = %+v", frames)
	}
}

func TestVoiceJoin_SendsPeerWatching(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "join-watch")
	chID := mustCreateVoiceChannel(t, database, "voice-join-watch")
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: healthyTestLiveKit(t)})

	peer, _ := voiceWatchClient(h, uid+1000, chID)
	peer.voice.setWatchingIfChannel(chID, []int64{uid, 77})

	send := make(chan []byte, 32)
	c := NewTestClient(h, uid, send)
	c.user = &db.User{ID: uid, Username: "join-watch"}
	h.mu.Lock()
	h.clients[uid] = []*Client{c}
	h.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{"channel_id": chID})
	h.handleVoiceJoin(context.Background(), c, json.RawMessage(payload), "")

	frames := watchFrames(t, send)
	if len(frames) != 1 || frames[0].UserID != uid+1000 || !reflect.DeepEqual(frames[0].UserIDs, []int64{uid, 77}) {
		t.Errorf("joiner frames = %+v", frames)
	}
}

func TestResume_KeepsWatchingAndResendsPeers(t *testing.T) {
	database := newTeardownTestDB(t)
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	const chanID = int64(500)

	peerSend := make(chan []byte, 8)
	peer := &Client{userID: 1, send: peerSend, sendHigh: peerSend, sendLow: peerSend}
	peer.voice.voiceChID = chanID
	peer.voice.watching = []int64{2, 9}
	hub.mu.Lock()
	hub.clients[1] = []*Client{peer}
	hub.mu.Unlock()
	hub.pubsub.Subscribe(peer, VoiceTopic(chanID))

	oldSend := make(chan []byte, 8)
	old := &Client{userID: 2, send: oldSend, sendHigh: oldSend, sendLow: oldSend}
	old.voice.voiceChID = chanID
	old.voice.voiceJoinToken = "tok"
	old.voice.voiceJoinCompleted = true
	old.voice.watching = []int64{1}
	hub.mu.Lock()
	hub.clients[2] = []*Client{old}
	hub.mu.Unlock()

	newSend := make(chan []byte, 8)
	newC := &Client{userID: 2, send: newSend, sendHigh: newSend, sendLow: newSend, lastSeq: 1}
	hub.registerNowTest(newC, nil)

	if got := newC.voice.watchingCopy(); !reflect.DeepEqual(got, []int64{1}) {
		t.Errorf("resumed slot watching = %v, want [1]", got)
	}
	if got := old.voice.watchingCopy(); len(got) != 0 {
		t.Errorf("old slot kept %v", got)
	}
	frames := watchFrames(t, newSend)
	if len(frames) != 1 || frames[0].UserID != 1 || !reflect.DeepEqual(frames[0].UserIDs, []int64{2, 9}) {
		t.Errorf("resumed client frames = %+v", frames)
	}
	if f := watchFrames(t, peerSend); len(f) != 0 {
		t.Errorf("resume must not re-relay the resumed client's own set: %+v", f)
	}
}

func TestLeave_ClearsWatching(t *testing.T) {
	var s voiceSlot
	s.setState(5, "tok")
	s.setWatchingIfChannel(5, []int64{2})
	if snap := s.clearSnap(); !reflect.DeepEqual(snap.watching, []int64{2}) {
		t.Errorf("snapshot lost the set: %v", snap.watching)
	}
	if got := s.watchingCopy(); len(got) != 0 {
		t.Errorf("leave kept %v", got)
	}
	if s.setWatchingIfChannel(5, []int64{2}) {
		t.Error("stored while not in a channel")
	}
	if s.setWatchingIfChannel(0, []int64{2}) {
		t.Error("stored for channel 0")
	}
}

func TestSetState_ClearsWatching(t *testing.T) {
	var s voiceSlot
	s.setState(5, "tok")
	s.setWatchingIfChannel(5, []int64{2})
	s.setState(5, "tok2")
	if got := s.watchingCopy(); len(got) != 0 {
		t.Errorf("new join instance kept %v", got)
	}
}

func TestWatchingIfChannel_OnlyForCurrentChannel(t *testing.T) {
	var s voiceSlot
	s.setState(7, "tok")
	if !s.setWatchingIfChannel(7, []int64{3}) {
		t.Fatal("store refused for the current channel")
	}
	if got := s.watchingIfChannel(7); !reflect.DeepEqual(got, []int64{3}) {
		t.Fatalf("watchingIfChannel(7) = %v, want [3]", got)
	}
	if got := s.watchingIfChannel(8); got != nil {
		t.Fatalf("watchingIfChannel(8) = %v, want nil", got)
	}
}
