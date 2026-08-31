package ws

// serve_pumps_reconnect_race_test.go — regression test for OC-0019.
//
// readPump's defer snapshots `replaced := hub.unregisterNow(c)` BEFORE running
// hub.handleVoiceLeave, which can block for seconds (DB delete, audience scan,
// a LiveKit RemoveParticipant HTTP call bounded by lkTimeout=5s). The stale
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
	"testing"
	"time"

	"github.com/coder/websocket"
	lkproto "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// TestReadPump_ReconnectDuringVoiceCleanup_DoesNotMarkUserOffline reproduces
// the finding's repro: a client's socket drops while it holds a voice
// session, its readPump defer starts tearing down (unregisterNow already
// removed it from the hub), and — while handleVoiceLeave is still blocked on
// the LiveKit call — the same user reconnects and takes the hub slot. The
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

	// Fake LiveKit server: holds the RemoveParticipant response until the
	// test releases it, giving full control over handleVoiceLeave's window.
	reachedLiveKit := make(chan struct{})
	proceed := make(chan struct{})
	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(reachedLiveKit)
		<-proceed
		body, _ := proto.Marshal(&lkproto.RemoveParticipantResponse{})
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer lkSrv.Close()

	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "testkeytestkeytest",
		LiveKitAPISecret: "testsecrettestsecrettestsecret",
		LiveKitURL:       "ws://" + lkSrv.Listener.Addr().String(),
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})

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

	// Wait until the defer is blocked inside handleVoiceLeave's LiveKit call —
	// unregisterNow has already run and sampled replaced=false.
	select {
	case <-reachedLiveKit:
	case <-time.After(5 * time.Second):
		t.Fatal("readPump's defer never reached the LiveKit RemoveParticipant call")
	}

	// The user reconnects while the old connection's teardown is still in
	// flight: a fresh client takes the (now-empty) hub slot for the same
	// user, exactly as registerNow does for a real reconnect.
	newClient := NewTestClient(h, uid, make(chan []byte, 8))
	newClient.user = &db.User{ID: uid, Status: "online"}
	h.registerNow(newClient, map[int64]bool{})

	// Let handleVoiceLeave's LiveKit call complete so the old defer resumes.
	close(proceed)

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("readPump did not return after the LiveKit call completed")
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
