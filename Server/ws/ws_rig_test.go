package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// wsRig is a running hub behind a real ServeWS test server, so tests exercise
// the genuine upgrade, auth handshake and pump paths.
type wsRig struct {
	hub *ws.Hub
	db  *db.DB
	srv *httptest.Server
	url string
}

func newWSRig(t *testing.T) *wsRig {
	t.Helper()
	return startWSRigFor(t, openServeTestDB(t), auth.NewRateLimiter(), nil, nil)
}

// newWSRigWithStore attaches store as the hub's cold-tier event store before
// the hub starts.
func newWSRigWithStore(t *testing.T, store *db.DB) *wsRig {
	t.Helper()
	return startWSRigFor(t, openServeTestDB(t), auth.NewRateLimiter(), nil, func(h *ws.Hub) { h.SetEventStore(store) })
}

// newWSRigWithServices wires the full service layer so chat handlers work.
func newWSRigWithServices(t *testing.T) *wsRig {
	t.Helper()
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	return startWSRigFor(t, database, limiter, service.New(database, limiter), nil)
}

// startWSRigFor builds the rig; prep runs before the hub starts, for setters
// that are only legal pre-Run.
func startWSRigFor(t *testing.T, database *db.DB, limiter *auth.RateLimiter, svc *service.Services, prep func(*ws.Hub)) *wsRig {
	t.Helper()
	hub := newTestHubDeps(t, database, limiter, svc)
	if prep != nil {
		prep(hub)
	}
	go hub.Run()
	t.Cleanup(hub.Stop)
	srv := httptest.NewServer(ws.ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	return &wsRig{hub: hub, db: database, srv: srv, url: "ws" + strings.TrimPrefix(srv.URL, "http")}
}

// testCtx returns a context cancelled when the test ends.
func testCtx(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

// seedUser creates a user with the given role and a session, returning the
// user ID and its bearer token.
func (r *wsRig) seedUser(t *testing.T, username string, roleID int) (int64, string) {
	t.Helper()
	userID, err := r.db.CreateUser(context.Background(), username, "hash", roleID)
	if err != nil {
		t.Fatalf("CreateUser %s: %v", username, err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken %s: %v", username, err)
	}
	if _, err := r.db.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession %s: %v", username, err)
	}
	return userID, token
}

// dial opens a raw connection that is closed when the test ends.
func (r *wsRig) dial(t *testing.T, ctx context.Context) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.Dial(ctx, r.url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

func writeFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, frame any) {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	writeRawFrame(t, ctx, conn, raw)
}

func writeRawFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, raw []byte) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func authFrame(payload map[string]any) map[string]any {
	return map[string]any{"type": "auth", "payload": payload}
}

// readFrame reads one frame and decodes it into a generic map.
func readFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) map[string]any {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("unmarshal frame %q: %v", raw, err)
	}
	return msg
}

// dialResume authenticates with lastSeq and returns the connection with the
// first frame the server answers with (auth_ok, or ready on a full resync).
func (r *wsRig) dialResume(t *testing.T, ctx context.Context, token string, lastSeq uint64) (*websocket.Conn, map[string]any) {
	t.Helper()
	conn := r.dial(t, ctx)
	writeFrame(t, ctx, conn, authFrame(map[string]any{"token": token, "last_seq": lastSeq}))
	return conn, readFrame(t, ctx, conn)
}

// dialReady authenticates with lastSeq, consumes auth_ok and returns the
// frame that follows it (ready, or the first replayed frame on resume).
func (r *wsRig) dialReady(t *testing.T, ctx context.Context, token string, lastSeq uint64) (*websocket.Conn, map[string]any) {
	t.Helper()
	conn, _ := r.dialResume(t, ctx, token, lastSeq)
	return conn, readFrame(t, ctx, conn)
}

func (r *wsRig) dialAuthed(t *testing.T, ctx context.Context, token string, lastSeq uint64) *websocket.Conn {
	t.Helper()
	conn, _ := r.dialReady(t, ctx, token, lastSeq)
	return conn
}

// waitHubClient waits for the hub's client for userID to satisfy ok.
func (r *wsRig) waitHubClient(t *testing.T, userID int64, msg string, ok func(*ws.Client) bool) *ws.Client {
	t.Helper()
	var got *ws.Client
	waitFor(t, waitTimeout, func() bool {
		got = r.hub.ClientForTest(userID)
		return got != nil && ok(got)
	}, msg)
	return got
}

// enterVoice records voice membership for the user's connected client in both
// the DB row and the in-memory state, as a completed voice_join would.
func (r *wsRig) enterVoice(t *testing.T, userID, chID int64, c *ws.Client) {
	t.Helper()
	if err := r.db.JoinVoiceChannel(context.Background(), userID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := r.db.GetVoiceState(context.Background(), userID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState after join: state=%v err=%v", vs, err)
	}
	ws.SetClientVoiceStateForTest(c, chID, vs.JoinedAt)
}

// requireVoiceRow asserts the user's DB voice_state row exists in chID.
func (r *wsRig) requireVoiceRow(t *testing.T, userID, chID int64, label string) {
	t.Helper()
	vs, err := r.db.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if vs == nil {
		t.Fatalf("%s: DB voice_state row was deleted, expected it to be preserved", label)
	}
	if vs.ChannelID != chID {
		t.Fatalf("%s: DB voice_state channel_id = %d, want %d", label, vs.ChannelID, chID)
	}
}

// pollStatus polls hub client count and the user's stored status until ok
// accepts them or two seconds pass, returning the last observation.
func (r *wsRig) pollStatus(t *testing.T, userID int64, ok func(clients int, status string) bool) (int, string, bool) {
	t.Helper()
	observe := func() (int, string) {
		user, err := r.db.GetUserByID(context.Background(), userID)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		return r.hub.ClientCount(), user.Status
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if n, status := observe(); ok(n, status) {
			return n, status, true
		}
		time.Sleep(20 * time.Millisecond)
	}
	n, status := observe()
	return n, status, ok(n, status)
}

func (r *wsRig) voiceChannel(t *testing.T, name string) int64 {
	t.Helper()
	chID, err := r.db.CreateChannel(context.Background(), name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel %s: %v", name, err)
	}
	return chID
}

// connectClient registers an in-process test client for user focused on chID
// and returns it with its outbound queue once the hub has processed the
// registration.
func connectClient(t *testing.T, hub *ws.Hub, user *db.User, chID int64, queue int) (*ws.Client, chan []byte) {
	t.Helper()
	send := make(chan []byte, queue)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	return c, send
}

// persistBroadcasts writes global broadcast events from..to into the cold
// store, skipping the listed seqs to simulate rows the persister lost.
func persistBroadcasts(t *testing.T, store *db.DB, from, to int64, skip ...int64) {
	t.Helper()
	for seq := from; seq <= to; seq++ {
		if slices.Contains(skip, seq) {
			continue
		}
		payload := fmt.Appendf(nil, `{"seq":%d,"type":"broadcast"}`, seq)
		if err := store.PersistEvent(context.Background(), seq, "broadcast", 0, payload); err != nil {
			t.Fatalf("PersistEvent seq=%d: %v", seq, err)
		}
	}
}

// fillRingBuffer pushes placeholder global broadcasts from..to and checks the
// buffer's oldest seq is from, so a resume below it must miss the buffer.
func fillRingBuffer(t *testing.T, hub *ws.Hub, from, to uint64) {
	t.Helper()
	rb := hub.ReplayBuffer()
	for seq := from; seq <= to; seq++ {
		rb.Push(seq, 0, []byte(`{"type":"broadcast"}`))
	}
	if oldest := rb.OldestSeq(); oldest != from {
		t.Fatalf("pre-condition: expected oldestSeq=%d, got %d", from, oldest)
	}
}

// requireColdResumeRefused resumes at lastSeq and fails when the server
// accepts the persisted rows as a complete db-tier resume: the first frame
// must not be auth_ok with replay_source "db" (accepted is the failure
// message), and the tier counters must show exactly one full re-sync.
func requireColdResumeRefused(t *testing.T, rig *wsRig, token string, lastSeq uint64, accepted, dbWhy, fullWhy string) {
	t.Helper()
	_, resp := rig.dialResume(t, testCtx(t, 10*time.Second), token, lastSeq)
	if resp["type"] == "auth_ok" {
		if payloadField, _ := resp["payload"].(map[string]any); payloadField["replay_source"] == "db" {
			t.Fatalf("%s: %v", accepted, resp)
		}
	}

	_, dbTier, fullTier := rig.hub.ReconnectTierStats()
	if dbTier != 0 {
		t.Errorf("db tier count = %d, want 0: %s", dbTier, dbWhy)
	}
	if fullTier != 1 {
		t.Errorf("full tier count = %d, want 1: %s", fullTier, fullWhy)
	}
}

// connectSessionClient is connectClient for a client carrying the token hash
// of a freshly created session, so session expiry and revocation checks see
// a real row.
func connectSessionClient(t *testing.T, hub *ws.Hub, database *db.DB, user *db.User, chID int64, queue int) (*ws.Client, chan []byte) {
	t.Helper()
	hash := auth.HashToken(seedSessionToken(t, database, user.ID))
	send := make(chan []byte, queue)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	return c, send
}
