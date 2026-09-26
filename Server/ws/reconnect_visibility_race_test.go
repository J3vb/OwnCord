package ws

// reconnect_visibility_race_test.go — regression test for OC-0206.
//
// handleReconnect reads the visibility watermark exactly once, at the very
// top of the handshake (mustFullResync(lastSeq)), then spends the rest of
// the handshake — computeAllowedChannels, plus on a cold-tier resume several
// more DB round trips — before registerNow finally subscribes the client and
// makes it reachable to RefreshChannelVisibility's / revokeUnreadableChannels's
// h.clients fan-out. A visibility change landing in that window is missed
// twice over: the fan-out can't see a client that isn't registered yet, and
// the earlier watermark check has already passed, so nothing forces the
// connection back onto the full-ready path — it resumes via replay holding
// permissions computed before the change.
//
// The DB round trips inside a real reconnect are too fast to reliably land a
// concurrent goroutine inside that window (see the identical justification
// on refreshChannelVisibilityRaceHook in hub_refresh_visibility_race_test.go),
// so handleReconnectPreRegisterRaceHook pins it deterministically instead.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func TestHandleReconnect_VisibilityChangeDuringHandshake_ForcesFullReady(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "reconnect-visibility-race-user")
	chID := mustCreateVoiceChannel(t, database, "reconnect-visibility-race-channel")
	ch, err := database.GetChannel(ctx, chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)

	// Precondition: the channel starts out READ-visible to this user.
	allowedBefore, err := h.computeAllowedChannels(ctx, database, user)
	if err != nil {
		t.Fatalf("computeAllowedChannels: %v", err)
	}
	if !allowedBefore[chID] {
		t.Fatalf("precondition: channel %d must start out READ-visible", chID)
	}

	// Seed the ring buffer so a buffer-tier replay is available for last_seq=2,
	// and seed h.seq to match its newest entry — bumpVisibilityWatermark reads
	// h.seq (the hub's broadcast counter), not the raw seqs pushed directly
	// into the ring buffer below, so without this the watermark could never
	// move past 0 and mustFullResync would never trip.
	rb := h.ReplayBuffer()
	rb.Push(1, chID, []byte(`{"seq":1,"type":"chat_message"}`))
	rb.Push(2, chID, []byte(`{"seq":2,"type":"chat_message"}`))
	rb.Push(3, chID, []byte(`{"seq":3,"type":"chat_message"}`))
	h.SeedSeq(3)
	const lastSeq = uint64(2)

	if h.mustFullResync(lastSeq) {
		t.Fatalf("precondition: mustFullResync must be false before any visibility change")
	}

	// Deliberately no pre-registered client for uid: this is a genuine
	// reconnect, exactly like the real socket that already dropped and was
	// already removed from h.clients.
	c := NewTestClientWithUser(h, user, 0, make(chan []byte, 8))

	// A real server-side *websocket.Conn so the (buggy) success path's writes
	// (auth_ok + replay) succeed instead of panicking on a nil conn.
	connCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		connCh <- conn
	}))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	clientConn, dialResp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
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
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Fires once, deep inside the handshake — after mustFullResync's initial
	// check and after computeAllowedChannels already snapshotted the
	// still-permissive allowed set. Revoke READ_MESSAGES and run the exact
	// fan-out RefreshChannelVisibility performs for a real admin edit: since c
	// is not registered yet, the targeted channel_delete reaches nobody.
	var hookRan bool
	handleReconnectPreRegisterRaceHook = func() {
		hookRan = true
		if overrideErr := database.UpsertChannelOverride(ctx, chID, harvestVoiceRoleID, 0, permissions.ReadMessages); overrideErr != nil {
			t.Fatalf("UpsertChannelOverride: %v", overrideErr)
		}
		// nolint:contextcheck // RefreshChannelVisibility takes no context by
		// design: it is reached through the admin HubBroadcaster interface,
		// which carries none, so it builds its own internally. contextcheck
		// only flags it here because this closure happens to hold a ctx for
		// the override write above; there is nothing to propagate.
		h.RefreshChannelVisibility(ch)
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	handled, startPumps := h.handleReconnect(ctx, conn, c, lastSeq)

	if !hookRan {
		t.Fatal("handleReconnectPreRegisterRaceHook never fired — test setup is broken, not exercising the race window")
	}

	// A change that happened this deep into the handshake was never delivered
	// to this connection (it wasn't registered yet) and must instead force a
	// fall-through to the full-ready path, not a resume carrying stale
	// permissions.
	if handled {
		t.Errorf("handleReconnect: handled=true after a visibility change landed mid-handshake, want false (fall through to handleFreshConnect)")
	}
	if startPumps {
		t.Errorf("handleReconnect: startPumps=true after a visibility change landed mid-handshake, want false")
	}
	if live := h.GetClient(uid); live != nil {
		t.Errorf("handleReconnect registered the client with permissions computed before the mid-handshake visibility change")
	}

	// Sanity: the watermark itself must reflect the change, or nothing above
	// could ever have caught it.
	if w := h.visibilityChangeSeq.Load(); w == 0 {
		t.Fatalf("test setup: visibilityChangeSeq never moved off 0, the hook's RefreshChannelVisibility call did not bump it")
	}
}
