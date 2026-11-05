package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
)

// serveRig is a hub over a fully migrated in-memory DB behind a real ServeWS
// server, for handshake tests that need access to hub internals.
type serveRig struct {
	hub *Hub
	db  *db.DB
	srv *httptest.Server
}

func newServeRig(t *testing.T) *serveRig {
	t.Helper()
	return newServeRigOn(t, newTeardownTestDB(t), nil)
}

// newServeRigOn builds the rig on database; prep runs before the hub starts,
// for setters that are only legal pre-Run.
func newServeRigOn(t *testing.T, database *db.DB, prep func(*Hub)) *serveRig {
	t.Helper()
	hub := newTestHub(t, database, nil, nil)
	if prep != nil {
		prep(hub)
	}
	go hub.Run()
	t.Cleanup(hub.Stop)
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	return &serveRig{hub: hub, db: database, srv: srv}
}

// seedOwner creates an Owner-role user with a session.
func (r *serveRig) seedOwner(t *testing.T, username string) (*db.User, string) {
	t.Helper()
	ctx := context.Background()
	userID, err := r.db.CreateUser(ctx, username, "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := r.db.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	return user, seedSessionToken(t, r.db, userID)
}

// dialAuth dials and sends the auth frame; the connection closes with the test.
func (r *serveRig) dialAuth(t *testing.T, ctx context.Context, token string, lastSeq uint64, activeChannelID int64) *websocket.Conn {
	t.Helper()
	conn := dialAndAuth(t, ctx, r.srv.URL, token, lastSeq, activeChannelID)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

// handshake authenticates and consumes the auth_ok and ready frames.
func (r *serveRig) handshake(t *testing.T, ctx context.Context, token string, lastSeq uint64, activeChannelID int64) *websocket.Conn {
	t.Helper()
	conn := r.dialAuth(t, ctx, token, lastSeq, activeChannelID)
	for _, want := range []string{MsgTypeAuthOK, MsgTypeReady} {
		if typ, _ := readFrameType(t, ctx, conn); typ != want {
			t.Fatalf("handshake frame = %q, want %q", typ, want)
		}
	}
	return conn
}

// newestClient returns the hub's newest client for uid, or nil.
func (r *serveRig) newestClient(uid int64) *Client {
	r.hub.mu.Lock()
	defer r.hub.mu.Unlock()
	return r.hub.newestLocked(uid)
}

// waitFocused polls until uid's newest client is focused on chID, returning
// that client and the channel it last held (-1 when none registered).
func (r *serveRig) waitFocused(uid, chID int64) (*Client, int64, bool) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		c := r.newestClient(uid)
		got := int64(-1)
		if c != nil {
			got = c.getChannelID()
		}
		if got == chID {
			return c, got, true
		}
		if time.Now().After(deadline) {
			return c, got, false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// pushReplayWindow fills the replay buffer with seqs 98..100 on chID so a
// resume at last_seq 99 is bracketed and takes the buffer tier.
func pushReplayWindow(hub *Hub, chID int64) {
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
}

// expectFrame reads one frame and fails unless it has the wanted type; note
// says which handshake step the frame stands for.
func expectFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, want, note string) {
	t.Helper()
	if typ, _ := readFrameType(t, ctx, conn); typ != want {
		t.Fatalf("expected %s%s, got %v", want, note, typ)
	}
}

// serverSideConn returns the server end of a real WebSocket pair, for calling
// handshake and pump code directly. When closeFirst is set the server end is
// torn down before it is handed back, so the next write on it fails — "peer
// already gone" without relying on network timing. CloseNow, not Close: the
// unread client end would never answer a close handshake.
func serverSideConn(t *testing.T, closeFirst bool) *websocket.Conn {
	t.Helper()
	connCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		if closeFirst {
			_ = conn.CloseNow()
		}
		connCh <- conn
	}))
	t.Cleanup(srv.Close)

	dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	clientConn, resp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("dial: %v", dialErr)
	}
	t.Cleanup(func() { _ = clientConn.Close(websocket.StatusNormalClosure, "") })

	select {
	case conn := <-connCh:
		t.Cleanup(func() { _ = conn.CloseNow() })
		return conn
	case <-time.After(5 * time.Second):
		t.Fatal("server never accepted the connection")
		return nil
	}
}
