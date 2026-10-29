package ws

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// mentionStallStore blocks the mention-count write until released, modelling a
// stalled database write behind the mention worker's lifecycle context.
type mentionStallStore struct {
	service.Store
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *mentionStallStore) IncrementMentionCountsBatch(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) (map[int64]int64, error) {
	s.once.Do(func() { close(s.started) })
	<-s.release
	return s.Store.IncrementMentionCountsBatch(ctx, channelID, entries)
}

// errorCodeOf returns the error code of the first error frame queued on c.
func errorCodeOf(c *Client) (string, bool) {
	for _, f := range drainFrames(c) {
		if f["type"] == "error" {
			p, _ := f["payload"].(map[string]any)
			code, _ := p["code"].(string)
			return code, true
		}
	}
	return "", false
}

// A mark_read behind a stalled mention write must answer REQUEST_TIMEOUT at the
// frame deadline instead of waiting on the lock the worker holds.
func TestHandleMessage_MarkReadTimesOutBehindStalledMentionWorker(t *testing.T) {
	st := &mentionStallStore{started: make(chan struct{}), release: make(chan struct{})}
	f := newActivityFixtureStore(t, func(d *db.DB) service.Store { st.Store = d; return st }, false)
	reader := f.user(t, "reader", permissions.MemberRoleID)

	stop := f.svc.Messages.StartMentionWorker(t.Context())
	var releaseOnce sync.Once
	releaseStall := func() { releaseOnce.Do(func() { close(st.release) }) }
	t.Cleanup(func() { releaseStall(); stop(context.Background()) })

	f.send(t, f.author, f.textID, "@reader ping")
	select {
	case <-st.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the mention worker never began its write")
	}

	SetCommandDeadlineForTest(t, 100*time.Millisecond)
	send := make(chan []byte, 16)
	c := NewTestClient(f.hub, reader.ID, send)
	c.user = reader
	f.hub.clients[reader.ID] = []*Client{c}

	for _, typ := range []string{"mark_read", "mark_unread"} {
		payload := map[string]any{"channel_id": f.textID}
		if typ == "mark_unread" {
			payload["message_id"] = 1
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			f.hub.handleMessage(c, voiceFrame(t, typ, "req-"+typ, payload))
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("%s did not return within 3s of a 100ms deadline: it is waiting on the mention lock", typ)
		}
		code, ok := errorCodeOf(c)
		if !ok || code != ErrCodeRequestTimeout {
			t.Errorf("%s error = %q (present=%v), want %s", typ, code, ok, ErrCodeRequestTimeout)
		}
	}
}

// stallJoinStore blocks selected voice-join database calls until the frame
// deadline ends them.
type stallJoinStore struct {
	VoiceStore
	stallJoin  bool
	commitThen bool // commit the row, then stall the read-back
	// commitThenFail commits the insert, then reports the deadline as the error,
	// as a driver does when its interrupt lands after the commit.
	commitThenFail bool
	// stallNthState stalls the nth State call (1-based) that carries a
	// cancellable context until it ends; 0 stalls none.
	stallNthState int
	stateCalls    *int
}

func (s stallJoinStore) Join(ctx context.Context, userID, channelID int64, maxUsers int) error {
	if s.stallJoin {
		<-ctx.Done()
		return ctx.Err()
	}
	if s.commitThenFail {
		if err := s.VoiceStore.Join(context.WithoutCancel(ctx), userID, channelID, maxUsers); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
	return s.VoiceStore.Join(ctx, userID, channelID, maxUsers)
}

func (s stallJoinStore) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if s.stallNthState > 0 {
		*s.stateCalls++
		if *s.stateCalls == s.stallNthState {
			<-ctx.Done()
			return nil, ctx.Err()
		}
	}
	if s.commitThen && ctx.Done() != nil {
		// Stall only the frame-bound read-back: it ends at the deadline.
		if st, err := s.VoiceStore.State(context.WithoutCancel(ctx), userID); err == nil && st != nil {
			<-ctx.Done()
			return nil, ctx.Err()
		}
	}
	return s.VoiceStore.State(ctx, userID)
}

// stallGetChannel blocks the channel lookup until the frame deadline.
type stallGetChannel struct{ DispatchReader }

func (s stallGetChannel) GetChannel(ctx context.Context, _ int64) (*db.Channel, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// A voice join whose precheck or persist stalls answers REQUEST_TIMEOUT on the
// frame deadline and leaves no voice state behind.
func TestHandleMessage_VoiceJoinTimesOutBeforeCommit(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *Hub)
	}{
		{"precheck channel lookup", func(h *Hub) {
			h.readers.Dispatch = stallGetChannel{DispatchReader: h.readers.Dispatch}
		}},
		{"persist insert", func(h *Hub) { h.voice = stallJoinStore{VoiceStore: h.voice, stallJoin: true} }},
		{"persist insert reported after commit", func(h *Hub) { h.voice = stallJoinStore{VoiceStore: h.voice, commitThenFail: true} }},
		{"persist read-back after commit", func(h *Hub) { h.voice = stallJoinStore{VoiceStore: h.voice, commitThen: true} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _, c, chID := newVoiceTraceHub(t, "dl-join")
			real := h.voice
			tc.setup(h)
			SetCommandDeadlineForTest(t, 100*time.Millisecond)

			done := make(chan struct{})
			go func() {
				defer close(done)
				h.handleMessage(c, voiceFrame(t, "voice_join", "req-join", map[string]any{"channel_id": chID}))
			}()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("voice_join did not return within 3s of a 100ms deadline")
			}

			var code string
			frames := drainFrames(c)
			for _, f := range frames {
				if f["type"] == "error" {
					p, _ := f["payload"].(map[string]any)
					code, _ = p["code"].(string)
				}
				if f["type"] == "voice_token" || f["type"] == "voice_state" {
					raw, _ := json.Marshal(f)
					t.Errorf("join frame %s delivered for a timed-out join", raw)
				}
			}
			if code != ErrCodeRequestTimeout {
				t.Errorf("error code = %q, want %s", code, ErrCodeRequestTimeout)
			}
			if got := c.voice.channel(); got != 0 {
				t.Errorf("client voice channel = %d, want 0", got)
			}
			if st, err := real.State(context.Background(), c.userID); err != nil || st != nil {
				t.Errorf("voice_states row = %+v (err %v), want none", st, err)
			}
		})
	}
}

// A channel switch whose verify read hits the deadline after the old row was
// deleted keeps the moderator mute: the flags read off the old row are stashed
// again, so the user's next join is still server-muted.
func TestHandleMessage_SwitchTimeoutKeepsModeratorMute(t *testing.T) {
	h, database, c, chA := newVoiceTraceHub(t, "dl-switch")
	chB := mustCreateVoiceChannel(t, database, "dl-switch-b")
	joinVoiceForTrace(t, h, c, chA)
	if _, err := database.ExecContext(context.Background(),
		`UPDATE voice_states SET server_muted = 1 WHERE user_id = ?`, c.userID); err != nil {
		t.Fatalf("server mute: %v", err)
	}
	drainFrames(c)

	calls := 0
	// State calls on a switch: 1 is the old row's flags, 2 the verify read.
	h.voice = stallJoinStore{VoiceStore: h.voice, stallNthState: 2, stateCalls: &calls}
	SetCommandDeadlineForTest(t, 100*time.Millisecond)

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.handleMessage(c, voiceFrame(t, "voice_join", "req-switch", map[string]any{"channel_id": chB}))
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("switch did not return within 3s of a 100ms deadline")
	}
	if code, ok := errorCodeOf(c); !ok || code != ErrCodeRequestTimeout {
		t.Errorf("error = %q (present=%v), want %s", code, ok, ErrCodeRequestTimeout)
	}
	if muted, _, _ := c.voice.takeModFlags(); !muted {
		t.Error("the moderator mute was lost on a timed-out switch")
	}
}

// channel_focus behind a stalled database read answers REQUEST_TIMEOUT.
func TestHandleMessage_ChannelFocusTimesOutOnStalledRead(t *testing.T) {
	st := &channelStallStore{}
	f := newActivityFixtureStore(t, func(d *db.DB) service.Store { st.Store = d; return st }, true)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	st.stall.Store(true)
	SetCommandDeadlineForTest(t, 100*time.Millisecond)

	c := NewTestClient(f.hub, reader.ID, make(chan []byte, 16))
	c.user = reader
	f.hub.clients[reader.ID] = []*Client{c}
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.hub.handleMessage(c, voiceFrame(t, "channel_focus", "req-focus", map[string]any{"channel_id": f.textID}))
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("channel_focus did not return within 3s of a 100ms deadline")
	}
	if code, ok := errorCodeOf(c); !ok || code != ErrCodeRequestTimeout {
		t.Errorf("error = %q (present=%v), want %s", code, ok, ErrCodeRequestTimeout)
	}
}

// channelStallStore blocks the channel lookup until the caller's context ends.
type channelStallStore struct {
	service.Store
	stall atomic.Bool
}

func (s *channelStallStore) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if s.stall.Load() {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.Store.GetChannel(ctx, id)
}
