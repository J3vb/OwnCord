package ws

// ready_admission_test.go — P5-S04. A restart herd used to run every fresh
// connect's ready build at once, so 2,000 sockets thrashed the reader pool
// (41,915 s of reader waits in the 2,000/10 s herd). Fresh connects now take
// a permit from a bounded gate before the handshake's reads, wait for one up
// to readyAdmissionWait, and are refused with SERVER_BUSY and a retry hint
// past it.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// inFlightReady counts concurrent ready builds through the one per-user read
// every build makes (the member list read is shared and cached).
type inFlightReady struct {
	ReadySnapshotReader
	now, peak, done atomic.Int64
}

func (r *inFlightReady) GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]db.ChannelUnread, error) {
	n := r.now.Add(1)
	for p := r.peak.Load(); n > p && !r.peak.CompareAndSwap(p, n); p = r.peak.Load() {
	}
	time.Sleep(time.Millisecond) // long enough that unbounded builds overlap
	defer func() { r.now.Add(-1); r.done.Add(1) }()
	return r.ReadySnapshotReader.GetChannelUnreadCounts(ctx, userID)
}

func seedSessions(t *testing.T, database *db.DB, n int) []string {
	t.Helper()
	ctx := context.Background()
	tokens := make([]string, n)
	for i := range tokens {
		id, err := database.CreateUser(ctx, fmt.Sprintf("herd-%04d", i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		if tokens[i], err = auth.GenerateToken(); err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(ctx, id, auth.HashToken(tokens[i]), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	return tokens
}

// dialFresh authenticates a fresh connect and returns the type of the first
// frame after auth_ok (ready on success), plus that frame. dialSlots, when
// non-nil, bounds the WebSocket dials in flight (not the sessions): 1,000
// simultaneous dials overflow the listen backlog on Windows, which then
// refuses connections.
func dialFresh(ctx context.Context, url, token string, dialSlots chan struct{}) (string, []byte, *websocket.Conn, error) {
	if dialSlots != nil {
		dialSlots <- struct{}{}
	}
	conn, resp, err := websocket.Dial(ctx, url, nil)
	if dialSlots != nil {
		<-dialSlots
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return "", nil, nil, err
	}
	conn.SetReadLimit(-1)
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": token}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		return "", nil, conn, err
	}
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return "", nil, conn, err
		}
		var f struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(msg, &f)
		if f.Type != MsgTypeAuthOK {
			return f.Type, msg, conn, nil
		}
	}
}

func TestReadyAdmission_1000FreshConnects_BoundedBuilds(t *testing.T) {
	if testing.Short() {
		t.Skip("herd simulation")
	}
	database := newTeardownTestDB(t)
	h := newTestHub(t, database, nil, nil)
	reader := &inFlightReady{ReadySnapshotReader: h.readers.Ready}
	h.readers.Ready = reader
	const k = 4
	h.readyGate = make(chan struct{}, k)
	setReadyAdmissionWait(t, time.Minute) // this test is about the bound, not the deadline
	go h.Run()
	t.Cleanup(h.Stop)

	const n = 1000
	tokens := seedSessions(t, database, n)
	srv := httptest.NewServer(ServeWS(h, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, n)
	dialSlots := make(chan struct{}, 50)
	for _, tok := range tokens {
		wg.Go(func() {
			typ, _, conn, err := dialFresh(ctx, url, tok, dialSlots)
			if conn != nil {
				defer func() { _ = conn.CloseNow() }()
			}
			if err == nil && typ != MsgTypeReady {
				err = fmt.Errorf("first frame after auth_ok = %q, want ready", typ)
			}
			if err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("fresh connect: %v", err)
	}
	if got := reader.done.Load(); got != n {
		t.Fatalf("ready builds completed = %d, want %d", got, n)
	}
	if peak := reader.peak.Load(); peak > k {
		t.Fatalf("peak concurrent ready builds = %d, want <= %d", peak, k)
	}
}

func TestReadyAdmission_RefusesPastDeadlineWithRetryHint(t *testing.T) {
	database := newTeardownTestDB(t)
	h := newTestHub(t, database, nil, nil)
	h.readyGate = make(chan struct{}, 1)
	h.readyGate <- struct{}{} // every permit held
	setReadyAdmissionWait(t, 50*time.Millisecond)
	go h.Run()
	t.Cleanup(h.Stop)

	tokens := seedSessions(t, database, 1)
	srv := httptest.NewServer(ServeWS(h, []string{"*"}, 0))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	typ, frame, conn, err := dialFresh(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), tokens[0], nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	if typ != MsgTypeError {
		t.Fatalf("first frame = %q, want error", typ)
	}
	var f struct {
		Payload struct {
			Code         string `json:"code"`
			RetryAfterMS int64  `json:"retry_after_ms"`
		} `json:"payload"`
	}
	_ = json.Unmarshal(frame, &f)
	if f.Payload.Code != ErrCodeServerBusy {
		t.Fatalf("code = %q, want %q", f.Payload.Code, ErrCodeServerBusy)
	}
	if f.Payload.RetryAfterMS < readyRetryAfter.Milliseconds()/2 || f.Payload.RetryAfterMS > readyRetryAfter.Milliseconds() {
		t.Fatalf("retry_after_ms = %d, want in [%d, %d]", f.Payload.RetryAfterMS,
			readyRetryAfter.Milliseconds()/2, readyRetryAfter.Milliseconds())
	}
	_, _, err = conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != websocket.StatusTryAgainLater {
		t.Fatalf("close status = %v (err %v), want %v", got, err, websocket.StatusTryAgainLater)
	}
	if got := h.ClientCount(); got != 0 {
		t.Fatalf("refused connect left %d registered clients, want 0", got)
	}
}

func TestServerRestart_SpreadScalesWithConnectedCount(t *testing.T) {
	database := newTeardownTestDB(t)
	h := newTestHub(t, database, nil, nil)
	go h.Run()
	t.Cleanup(h.Stop)
	ctx := context.Background()

	clients := make([]*Client, 0, 3)
	for i := range 3 {
		id, err := database.CreateUser(ctx, fmt.Sprintf("r-%d", i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		u, _ := database.GetUserByID(ctx, id)
		c := herdClient(ctx, h, u)
		h.registerNow(c, nil)
		clients = append(clients, c)
	}
	h.BroadcastServerRestart(RestartReasonUpdate, 5)
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	var got *serverRestartPayload
	for _, raw := range drain(clients[0].send) {
		var f struct {
			Type    string               `json:"type"`
			Payload serverRestartPayload `json:"payload"`
		}
		if json.Unmarshal(raw, &f) == nil && f.Type == MsgTypeServerRestart {
			got = &f.Payload
		}
	}
	if got == nil {
		t.Fatal("no server_restart frame")
	}
	if got.DelaySeconds != 5 || got.ReconnectSpreadMS != 30 {
		t.Fatalf("payload = %+v, want delay_seconds 5, reconnect_spread_ms 30 (3 clients x 10 ms)", *got)
	}
	if s := restartSpreadMS(100_000); s != 30_000 {
		t.Fatalf("restartSpreadMS(100000) = %d, want the 30 s cap", s)
	}
}

func setReadyAdmissionWait(t *testing.T, d time.Duration) {
	t.Helper()
	prev := readyAdmissionWait
	readyAdmissionWait = d
	t.Cleanup(func() { readyAdmissionWait = prev })
}
