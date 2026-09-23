package ws

// serve_pumps_reconnect_race_test.go — regression test for OC-0019.
//
// readPump's defer snapshots `replaced := hub.unregisterNow(c)` BEFORE running
// hub.handleVoiceLeave, which can block (DB delete with retry, audience scan;
// the LiveKit RemoveParticipant call runs in the background since OC-0453). The stale
// `replaced` boolean is then reused, unchecked, to decide whether to run
// MarkUserDisconnected and broadcast an offline presence. A reconnect that
// registers during that window is invisible to the stale flag: the dead
// socket's teardown marks the *live* session's user offline.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// TestReadPump_ReconnectDuringVoiceCleanup_DoesNotMarkUserOffline reproduces
// the finding's repro: a client's socket drops while it holds a voice
// session, its readPump defer starts tearing down (unregisterNow already
// removed it from the hub), and — while handleVoiceLeave is still blocked on
// its DB delete — the same user reconnects and takes the hub slot. The
// defer must not go on to mark that user offline once it resumes.
func TestReadPump_ReconnectDuringVoiceCleanup_DoesNotMarkUserOffline(t *testing.T) {
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "reconnect-race")
	chID := mustCreateVoiceChannel(t, database, "voice-race")

	ctx := context.Background()
	if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, uid, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	// The voice store holds the voice_states delete until the test releases
	// it, giving full control over handleVoiceLeave's window.
	reachedLeave := make(chan struct{})
	proceed := make(chan struct{})
	voice := &blockingLeaveVoiceStore{
		VoiceService: service.NewVoiceService(database),
		reached:      reachedLeave,
		proceed:      proceed,
	}

	h := newTestHubWith(t, HubOptions{DB: database, Voice: voice})

	c := NewTestClient(h, uid, make(chan []byte, 8))
	c.user = &db.User{ID: uid, Status: "online"}
	c.setVoiceState(chID, "tok-race")
	h.clients[uid] = c

	// Real server-side *websocket.Conn, closed immediately so readPump's
	// first Read fails and its defer runs — mirrors
	// serve_reconnect_double_teardown_test.go's setup.
	connCh := make(chan *websocket.Conn, 1)
	wsSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		_ = conn.CloseNow()
		connCh <- conn
	}))
	defer wsSrv.Close()

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	clientConn, resp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(wsSrv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("dial: %v", dialErr)
	}
	defer func() { _ = clientConn.Close(websocket.StatusNormalClosure, "") }()

	var conn *websocket.Conn
	select {
	case conn = <-connCh:
	case <-time.After(5 * time.Second):
		t.Fatal("server never accepted the connection")
	}

	done := make(chan struct{})
	go func() {
		readPump(context.Background(), conn, h, c)
		close(done)
	}()

	// Wait until the defer is blocked inside handleVoiceLeave's DB delete —
	// unregisterNow has already run and sampled replaced=false.
	select {
	case <-reachedLeave:
	case <-time.After(5 * time.Second):
		t.Fatal("readPump's defer never reached the voice_states delete")
	}

	// The user reconnects while the old connection's teardown is still in
	// flight: a fresh client takes the (now-empty) hub slot for the same
	// user, exactly as registerNow does for a real reconnect.
	newClient := NewTestClient(h, uid, make(chan []byte, 8))
	newClient.user = &db.User{ID: uid, Status: "online"}
	h.registerNow(newClient, map[int64]bool{})

	// Let handleVoiceLeave's DB delete complete so the old defer resumes.
	close(proceed)

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("readPump did not return after the voice_states delete completed")
	}

	if got := h.GetClient(uid); got != newClient {
		t.Fatalf("hub client for user %d = %p after old connection's teardown, want the reconnected client %p", uid, got, newClient)
	}

	var offlineBroadcasts int
	for len(h.broadcast) > 0 {
		bm := <-h.broadcast
		if bytes.Contains(bm.msg, []byte(`"status":"offline"`)) {
			offlineBroadcasts++
		}
	}
	if offlineBroadcasts != 0 {
		t.Errorf("got %d offline presence broadcasts after a reconnect raced the old connection's voice cleanup, want 0 — the live session was stamped offline", offlineBroadcasts)
	}

	user, err := database.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.Status != "online" {
		t.Errorf("user status = %q after the reconnect race, want %q — the dead socket's teardown overwrote the live session's status", user.Status, "online")
	}
}

// blockingLeaveVoiceStore is the real voice service with LeaveIfMatch held
// until proceed closes, signalling reached once it is entered.
type blockingLeaveVoiceStore struct {
	*service.VoiceService
	reached chan struct{}
	proceed chan struct{}
	once    sync.Once
}

func (s *blockingLeaveVoiceStore) LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error) {
	s.once.Do(func() { close(s.reached) })
	<-s.proceed
	return s.VoiceService.LeaveIfMatch(ctx, userID, channelID, joinedAt)
}
