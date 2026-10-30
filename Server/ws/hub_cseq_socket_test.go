package ws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// switchableGetChannelReader fails GetChannel while fail is set.
type switchableGetChannelReader struct {
	VisibilityReader
	fail atomic.Bool
}

func (r *switchableGetChannelReader) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if r.fail.Load() {
		return nil, errors.New("simulated transient lookup failure")
	}
	return r.VisibilityReader.GetChannel(ctx, id)
}

type cseqSocketFixture struct {
	hub    *Hub
	reader *switchableGetChannelReader
	userID int64
	chID   int64
	other  int64
	token  string
	srvURL string
}

func newCseqSocketFixture(t *testing.T) *cseqSocketFixture {
	t.Helper()
	database := newTeardownTestDB(t)
	ctx := context.Background()
	userID, err := database.CreateUser(ctx, "cseq-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "cseq-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	other, err := database.CreateChannel(ctx, "cseq-other", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	reader := &switchableGetChannelReader{VisibilityReader: database}
	hub := newTestHubWith(t, HubOptions{
		DB:      database,
		Limiter: auth.NewRateLimiter(),
		Readers: HubReaders{Visibility: reader, Ready: database, Members: database, Dispatch: database},
	})
	go hub.Run()
	t.Cleanup(hub.Stop)
	waitUntilRunning(t, hub)
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	return &cseqSocketFixture{hub: hub, reader: reader, userID: userID, chID: chID, other: other, token: token, srvURL: srv.URL}
}

func (f *cseqSocketFixture) pushReplay(seqs ...uint64) {
	rb := f.hub.ReplayBuffer()
	rb.Push(96, f.chID, []byte(`{"seq":96,"type":"chat_message","payload":{"channel_id":`+itoaTest(f.chID)+`,"content":"old"}}`))
	for _, s := range seqs {
		n := itoaTest(int64(s))
		rb.Push(s, f.chID, []byte(`{"seq":`+n+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(f.chID)+`,"content":"replay-`+n+`"}}`))
	}
}

func (f *cseqSocketFixture) dial(t *testing.T, lastSeq uint64) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.srvURL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": f.token, "last_seq": lastSeq}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	return conn
}

// wireReader reads conn on its own goroutine: an expired Read context closes
// a coder/websocket connection, so idle detection happens on the channel.
type wireReader struct{ frames chan []byte }

func startWireReader(t *testing.T, conn *websocket.Conn) *wireReader {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	r := &wireReader{frames: make(chan []byte, 256)}
	go func() {
		defer close(r.frames)
		for {
			_, msg, err := conn.Read(ctx)
			if err != nil {
				return
			}
			r.frames <- msg
		}
	}()
	return r
}

// readCseqs collects frames until the socket is idle and returns the cseq of
// every sequenced frame, failing on one that has seq but no cseq.
func (r *wireReader) readCseqs(t *testing.T) []uint64 {
	t.Helper()
	var out []uint64
	for {
		var msg []byte
		select {
		case m, ok := <-r.frames:
			if !ok {
				return out
			}
			msg = m
		case <-time.After(500 * time.Millisecond):
			return out
		}
		var env struct {
			Seq  *uint64 `json:"seq"`
			Cseq *uint64 `json:"cseq"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("frame is not JSON: %v: %s", err, msg)
		}
		switch {
		case env.Seq == nil && env.Cseq != nil:
			t.Fatalf("an unsequenced frame carries cseq: %s", msg)
		case env.Seq != nil && env.Cseq == nil:
			t.Fatalf("a sequenced frame carries no cseq: %s", msg)
		case env.Seq != nil:
			out = append(out, *env.Cseq)
		}
	}
}

func assertContiguousFrom(t *testing.T, got []uint64, first uint64) {
	t.Helper()
	for i, v := range got {
		if v != first+uint64(i) {
			t.Fatalf("cseq on the wire = %v, want a contiguous run from %d", got, first)
		}
	}
}

// Replay frames and the live frames after them are numbered on one run from
// 1, across the handshake-to-writePump handover, and a frame for a channel the
// connection is not subscribed to uses no number.
func TestCseqSocket_ReplayThenLiveContiguous(t *testing.T) {
	t.Parallel()
	f := newCseqSocketFixture(t)
	f.pushReplay(98, 99, 100)
	r := startWireReader(t, f.dial(t, 97))
	replay := r.readCseqs(t)
	if len(replay) < 3 {
		t.Fatalf("replay wrote %d sequenced frames, want at least the 3 replayed", len(replay))
	}
	f.hub.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	f.hub.BroadcastToChannel(f.other, []byte(`{"type":"chat_deleted","payload":{"id":1,"channel_id":`+itoaTest(f.other)+`}}`))
	f.hub.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	live := r.readCseqs(t)
	if len(live) != 2 {
		t.Fatalf("live frames on the wire = %d, want the 2 global ones", len(live))
	}
	assertContiguousFrom(t, append(replay, live...), 1)
}

// A new socket counts from 1 again.
func TestCseqSocket_RestartsPerSocket(t *testing.T) {
	t.Parallel()
	f := newCseqSocketFixture(t)
	first := f.dial(t, 0)
	r1 := startWireReader(t, first)
	_ = r1.readCseqs(t)
	f.hub.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	if got := r1.readCseqs(t); len(got) == 0 {
		t.Fatal("first socket received no sequenced frame")
	}
	_ = first.Close(websocket.StatusNormalClosure, "")

	r2 := startWireReader(t, f.dial(t, 0))
	got := r2.readCseqs(t)
	f.hub.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	got = append(got, r2.readCseqs(t)...)
	if len(got) == 0 {
		t.Fatal("second socket received no sequenced frame")
	}
	assertContiguousFrom(t, got, 1)
}

// A replayed frame withheld because its content gate could not be read is a
// loss: the wire skips one cseq and the user's next resume takes full ready.
func TestCseqSocket_ReplayGateFailureSkipsOne(t *testing.T) {
	f := newCseqSocketFixture(t)
	f.pushReplay(98, 99, 100)
	t.Cleanup(func() { reconnectFrameReadableRaceHook = nil })
	checks := 0
	reconnectFrameReadableRaceHook = func(uid, cid int64) {
		if uid != f.userID || cid != f.chID {
			return
		}
		checks++
		f.reader.fail.Store(checks == 2)
	}
	got := startWireReader(t, f.dial(t, 97)).readCseqs(t)
	if checks != 3 {
		t.Fatalf("gate checks = %d, want 3", checks)
	}
	gaps := 0
	for i := 1; i < len(got); i++ {
		switch got[i] - got[i-1] {
		case 1:
		case 2:
			gaps++
		default:
			t.Fatalf("cseq on the wire = %v, want steps of 1 with one skip", got)
		}
	}
	if gaps != 1 || got[0] != 1 {
		t.Fatalf("cseq on the wire = %v, want a run from 1 with exactly one skip", got)
	}
	if !f.hub.presenceResyncPending(f.userID, auth.HashToken(f.token)) {
		t.Fatal("the withheld frame did not mark the user's next resume for the full ready")
	}
}
