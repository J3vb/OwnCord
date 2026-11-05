package ws_test

// ws_integration_test.go covers ServeWS, authenticateConn, writePump, and
// readPump by spinning up a real httptest server and dialing it with the
// github.com/coder/websocket client.

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/ws"
)

// expectAuthErrorOrClose sends first as the opening frame and accepts either
// an auth_error reply or the server closing the connection.
func (r *wsRig) expectAuthErrorOrClose(t *testing.T, first []byte) {
	t.Helper()
	ctx := testCtx(t, 5*time.Second)
	conn := r.dial(t, ctx)
	writeRawFrame(t, ctx, conn, first)
	_, raw, readErr := conn.Read(ctx)
	if readErr != nil {
		return
	}
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err == nil && msg["type"] != "auth_error" {
		t.Errorf("expected auth_error, got type=%q", msg["type"])
	}
}

// readUntilType reads up to maxFrames frames from conn and reports whether one
// has the given type; read errors end the search.
func readUntilType(ctx context.Context, conn *websocket.Conn, typ string, maxFrames int, perRead time.Duration) bool {
	for range maxFrames {
		readCtx, cancel := context.WithTimeout(ctx, perRead)
		_, raw, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			return false
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) == nil && m["type"] == typ {
			return true
		}
	}
	return false
}

// ─── ServeWS / authenticateConn happy path ────────────────────────────────────

// TestServeWS_InvalidUpgrade verifies that a plain HTTP GET (non-WS) returns
// a non-101 status without panicking.
func TestServeWS_InvalidUpgrade_ReturnsError(t *testing.T) {
	rig := newWSRig(t)

	// Plain GET without WebSocket upgrade headers should fail gracefully.
	resp, err := http.Get(rig.srv.URL)
	if err != nil {
		t.Fatalf("http.Get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// github.com/coder/websocket returns 400 or 426 when upgrade is absent.
	if resp.StatusCode == 200 {
		t.Errorf("expected non-200 for plain HTTP, got %d", resp.StatusCode)
	}
}

// ─── authenticateConn — error paths ──────────────────────────────────────────

// TestAuthenticateConn_NoAuthMessage verifies that a connection that closes
// immediately (without sending auth) causes the server to close it gracefully.
func TestAuthenticateConn_NoAuthMessage_ServerClosesConn(t *testing.T) {
	rig := newWSRig(t)
	conn := rig.dial(t, testCtx(t, 5*time.Second))

	// Close without sending auth — the server's authDeadline (10s) will fire,
	// but closing immediately should cause a read error on the server side.
	_ = conn.Close(websocket.StatusNormalClosure, "no auth")

	// Absence assertion: give the server a bounded window in which a buggy
	// registration would land before checking nothing appeared.
	time.Sleep(50 * time.Millisecond)

	// Hub should have no clients registered.
	if rig.hub.ClientCount() != 0 {
		t.Errorf("ClientCount = %d after unauthenticated connection, want 0", rig.hub.ClientCount())
	}
}

// TestAuthenticateConn_InvalidJSON verifies that sending invalid JSON as the
// first message causes the server to send an auth_error and close.
func TestAuthenticateConn_InvalidJSON_ReceivesAuthError(t *testing.T) {
	newWSRig(t).expectAuthErrorOrClose(t, []byte("NOT JSON"))
}

// TestAuthenticateConn_WrongMessageType verifies that sending a non-auth
// first message causes the server to send an auth_error.
func TestAuthenticateConn_WrongMessageType_ReceivesAuthError(t *testing.T) {
	raw := mustMarshal(t, map[string]any{
		"type":    "chat_send",
		"payload": map[string]string{"content": "hello"},
	})
	newWSRig(t).expectAuthErrorOrClose(t, raw)
}

// TestAuthenticateConn_MissingToken verifies that an auth message without
// a token field receives an auth_error.
func TestAuthenticateConn_MissingToken_ReceivesAuthError(t *testing.T) {
	raw := mustMarshal(t, authFrame(map[string]any{})) // no token field
	newWSRig(t).expectAuthErrorOrClose(t, raw)
}

// TestAuthenticateConn_InvalidToken verifies that an auth message with a
// non-existent token receives an auth_error.
func TestAuthenticateConn_InvalidToken_ReceivesAuthError(t *testing.T) {
	raw := mustMarshal(t, authFrame(map[string]any{"token": "totally-invalid-token-xyz"}))
	newWSRig(t).expectAuthErrorOrClose(t, raw)
}

// TestAuthenticateConn_SessionLookupDBError_NotTerminal verifies OC-0196: a
// transient DB error while looking up the session (GetSessionByTokenHash
// returning a genuine error rather than sql.ErrNoRows) must NOT be reported
// as the terminal auth_error frame. The client treats auth_error as
// non-recoverable — it stops reconnecting and clears the user's stored
// credentials (see Client/src/lib/ws.ts and dispatcher.ts) — so
// collapsing "DB unreachable" into "bad token" force-logs-out every client
// that reconnects during a sub-second SQLite hiccup even though its session
// row is perfectly valid. A DB error must surface as a non-terminal error
// frame instead, so the client's normal backoff/reconnect logic retries.
func TestAuthenticateConn_SessionLookupDBError_NotTerminal(t *testing.T) {
	rig := newWSRig(t)
	_, token := rig.seedUser(t, "db-hiccup-user", 1)

	ctx := testCtx(t, 5*time.Second)
	conn := rig.dial(t, ctx)

	// Simulate a transient DB outage AFTER the session/token above were
	// written successfully: close the database so the next query
	// (GetSessionByTokenHash, made when the auth frame below is processed)
	// returns a genuine driver error instead of (nil, nil). The session row
	// itself remains logically valid — this models momentary SQLite reader
	// contention (WAL checkpoint, backup, busy_timeout), not a bad token.
	if err := rig.db.Close(); err != nil {
		t.Fatalf("database.Close: %v", err)
	}

	writeFrame(t, ctx, conn, authFrame(map[string]any{"token": token}))
	msg := readFrame(t, ctx, conn)
	if msg["type"] == ws.MsgTypeAuthError {
		t.Errorf("got terminal %q frame for a transient DB error — the client "+
			"treats this as non-recoverable and clears stored credentials; a DB "+
			"hiccup must surface as a retryable error instead", ws.MsgTypeAuthError)
	}
	if msg["type"] != ws.MsgTypeError {
		t.Errorf("response type = %q, want %q (non-terminal error frame)", msg["type"], ws.MsgTypeError)
	}
}

// TestServeWS_ValidAuth_FullHandshake verifies the complete happy path:
// valid token → auth_ok + ready received, client counted in hub.
func TestServeWS_ValidAuth_FullHandshake(t *testing.T) {
	rig := newWSRig(t)
	_, token := rig.seedUser(t, "ws-handshake-user", 1)

	ctx := testCtx(t, 10*time.Second)
	conn := rig.dial(t, ctx)
	writeFrame(t, ctx, conn, authFrame(map[string]any{"token": token}))

	if got := readFrame(t, ctx, conn)["type"]; got != "auth_ok" {
		t.Errorf("first response type = %q, want auth_ok", got)
	}
	if got := readFrame(t, ctx, conn)["type"]; got != "ready" {
		t.Errorf("second response type = %q, want ready", got)
	}

	// Registration happens before the ready frame is written (serve.go), so
	// having read ready implies the client is registered.
	if rig.hub.ClientCount() != 1 {
		t.Errorf("ClientCount = %d after successful auth, want 1", rig.hub.ClientCount())
	}
}

// TestServeWS_ImmediateDisconnect_DoesNotLeaveGhostClient verifies that a
// client that drops immediately after sending auth does not remain registered
// or stuck online.
func TestServeWS_ImmediateDisconnect_DoesNotLeaveGhostClient(t *testing.T) {
	rig := newWSRig(t)
	userID, token := rig.seedUser(t, "abruptclose", 4)

	ctx := testCtx(t, 5*time.Second)
	conn := rig.dial(t, ctx)
	writeFrame(t, ctx, conn, authFrame(map[string]any{"token": token}))
	_ = conn.CloseNow()

	n, status, ok := rig.pollStatus(t, userID, func(n int, status string) bool {
		return n == 0 && status == "offline"
	})
	if !ok {
		t.Fatalf("immediate disconnect left stale state: client_count=%d user_status=%q", n, status)
	}
}

// TestServeWS_DuplicateLogin_KeepsUserOnline verifies that replacing an
// existing connection does not broadcast or persist a false offline state for
// the still-connected replacement session.
func TestServeWS_DuplicateLogin_KeepsUserOnline(t *testing.T) {
	rig := newWSRig(t)
	userID, token := rig.seedUser(t, "ws-reconnect-user", 1)

	ctx := testCtx(t, 10*time.Second)
	rig.dialAuthed(t, ctx, token, 0)
	rig.dialAuthed(t, ctx, token, 0)

	n, status, ok := rig.pollStatus(t, userID, func(n int, status string) bool {
		return n == 1 && status == "online"
	})
	if !ok {
		t.Fatalf("duplicate login left wrong state: client_count=%d user_status=%q", n, status)
	}
}

// TestServeWS_Reconnect_PreservesVoiceState verifies that replacing a
// connection via network reconnect (last_seq > 0) preserves voice state:
// no voice_leave broadcast, voiceChID transferred, DB row intact.
func TestServeWS_Reconnect_PreservesVoiceState(t *testing.T) {
	rig := newWSRig(t)
	userID, token := rig.seedUser(t, "ws-voice-reconnect", 1)
	chID := rig.voiceChannel(t, "voice-reconnect")
	ctx := testCtx(t, 10*time.Second)

	rig.dialAuthed(t, ctx, token, 0)
	originalClient := rig.waitHubClient(t, userID, "first client to be registered", func(*ws.Client) bool { return true })

	// Simulate voice join AFTER conn1 is established — both in-memory and DB.
	// (Setting it before conn1 would cause serve.go's fresh-connect cleanup
	// to delete the DB row during conn1's handshake.)
	rig.enterVoice(t, userID, chID, originalClient)

	// Second connection: reconnect (lastSeq > oldestSeq) — voice state should transfer.
	// Use lastSeq=2 because conn1's join produces at least 2 broadcasts
	// (member_join seq=1, presence seq=2), and afterSeq must be > oldestSeq
	// for EventsSince to return a replay instead of nil (BUG-085).
	conn2 := rig.dialAuthed(t, ctx, token, 2)

	replacementClient := rig.waitHubClient(t, userID, "replacement client with transferred voice state", func(c *ws.Client) bool {
		return ws.GetClientVoiceChIDForTest(c) == chID
	})
	if got := ws.GetClientVoiceChIDForTest(replacementClient); got != chID {
		t.Fatalf("replacement client voiceChID = %d, want %d", got, chID)
	}
	rig.requireVoiceRow(t, userID, chID, "reconnect")

	// Assert: no voice_leave broadcast
	readDeadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(readDeadline) {
		readCtx, readCancel := context.WithTimeout(ctx, 100*time.Millisecond)
		_, raw, readErr := conn2.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		if msg["type"] == "voice_leave" {
			t.Fatalf("reconnect must not broadcast voice_leave: %s", string(raw))
		}
	}
}

// TestServeWS_ReplayFallback_PreservesVoiceState verifies the replay-FAILURE
// path: a reconnect whose last_seq the ring buffer cannot serve (seq far ahead,
// e.g. after a server restart reset the counter) falls back to
// handleFreshConnect with lastSeq > 0 preserved. registerNow then transfers the
// old connection's live voice state into the new client, so the fresh-connect
// stale-voice cleanup must NOT delete the DB row (or remove the LiveKit
// participant, whose removal token is the very JoinedAt being transferred) —
// otherwise the user is "in voice" on the hub only: voice_join bounces off
// ALREADY_JOINED and sweepStaleVoiceStates never heals memory-without-row.
func TestServeWS_ReplayFallback_PreservesVoiceState(t *testing.T) {
	rig := newWSRig(t)
	userID, token := rig.seedUser(t, "ws-voice-fallback", 1)
	chID := rig.voiceChannel(t, "voice-fallback")
	ctx := testCtx(t, 10*time.Second)

	// First connection: fresh, then put the user in voice (DB + in-memory).
	rig.dialAuthed(t, ctx, token, 0)
	originalClient := rig.waitHubClient(t, userID, "first client to be registered", func(*ws.Client) bool { return true })
	rig.enterVoice(t, userID, chID, originalClient)

	// Second connection: last_seq far ahead of anything the buffer holds —
	// replay fails, handleFreshConnect runs with lastSeq > 0, and registerNow
	// transfers the old connection's voice state.
	rig.dialAuthed(t, ctx, token, 999)

	replacementClient := rig.waitHubClient(t, userID, "replacement client to be registered", func(c *ws.Client) bool {
		return c != originalClient
	})

	// The transferred in-memory state and the DB row must stay consistent:
	// either both present (transfer honored) or both gone — never memory-only.
	if got := ws.GetClientVoiceChIDForTest(replacementClient); got != chID {
		t.Fatalf("replacement client voiceChID = %d, want %d", got, chID)
	}
	rig.requireVoiceRow(t, userID, chID, "replay fallback")
}

// TestServeWS_Reconnect_AuthorizedVoiceClientKeepsChannelStream verifies the
// authorized half of the voice-subscription gate end to end: the reconnect
// handshake passes the user's READ_MESSAGES set to registerNow, so a user who
// may read the channel they are in voice on keeps live message delivery without
// re-sending channel_focus (the desktop client does not re-send it on auth_ok).
func TestServeWS_Reconnect_AuthorizedVoiceClientKeepsChannelStream(t *testing.T) {
	rig := newWSRig(t)
	// roleID 1 = Owner: holds READ_MESSAGES on every channel.
	userID, token := rig.seedUser(t, "ws-voice-read-allowed", 1)
	chID, err := rig.db.CreateChannel(context.Background(), "voice-read-allowed", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	ctx := testCtx(t, 10*time.Second)

	rig.dialAuthed(t, ctx, token, 0)
	originalClient := rig.waitHubClient(t, userID, "first client to be registered", func(*ws.Client) bool { return true })

	// Join voice on the channel AFTER conn1 is established (see the
	// PreservesVoiceState test: setting it earlier is cleaned up on connect).
	rig.enterVoice(t, userID, chID, originalClient)

	// Reconnect (lastSeq > 0) — voice state transfers to the replacement client,
	// which has no focused channel of its own.
	conn2 := rig.dialAuthed(t, ctx, token, 2)

	rig.waitHubClient(t, userID, "replacement client with transferred voice state", func(c *ws.Client) bool {
		return ws.GetClientVoiceChIDForTest(c) == chID
	})
	// The topic subscription lands just after the client enters the hub map.
	waitFor(t, waitTimeout, func() bool {
		return slices.Contains(rig.hub.PubSubForTest().TopicsForUser(userID), ws.ChannelTopic(chID))
	}, "reconnected client to be resubscribed to the voice channel topic")

	rig.hub.BroadcastToChannel(chID, []byte(`{"type":"chat_message","payload":{"content":"still-visible"}}`))

	readDeadline := time.Now().Add(3 * time.Second)
	for {
		if time.Now().After(readDeadline) {
			t.Fatal("authorized voice client stopped receiving the channel message stream after reconnect")
		}
		if readUntilType(ctx, conn2, "chat_message", 1, 500*time.Millisecond) {
			return
		}
	}
}

// TestServeWS_FreshReconnect_CleansStaleVoiceState verifies that when a user
// presses F5 (fresh connection, lastSeq = 0) while in voice, the server:
//  1. cleans the DB voice_state row before building ready
//  2. does NOT include the user in ready.payload.voice_states
//  3. sets replacement client voiceChID = 0
//  4. broadcasts exactly one voice_leave visible to an observer client
func TestServeWS_FreshReconnect_CleansStaleVoiceState(t *testing.T) {
	rig := newWSRig(t)
	// The voice user who F5-reloads, and an observer.
	userID, token := rig.seedUser(t, "ws-voice-f5", 1)
	_, obsToken := rig.seedUser(t, "ws-observer", 1)
	chID := rig.voiceChannel(t, "voice-test")
	ctx := testCtx(t, 10*time.Second)

	// First connection: user joins voice
	rig.dialAuthed(t, ctx, token, 0)
	originalClient := rig.waitHubClient(t, userID, "first client to be registered", func(*ws.Client) bool { return true })
	rig.enterVoice(t, userID, chID, originalClient)

	// Connect the observer (will receive broadcasts).
	// Do NOT drain the observer — github.com/coder/websocket closes the conn
	// when a Read context expires. Instead, collect all messages below
	// and filter for voice_leave in the assertion.
	obsConn := rig.dialAuthed(t, ctx, obsToken, 0)

	// F5 reload: fresh connection (lastSeq = 0)
	_, readyMsg := rig.dialReady(t, ctx, token, 0)

	// The replacement registers before its ready frame is written; wait for
	// the hub's client map to show the swap. Broadcast propagation is covered
	// by the observer read loop's own timeout below.
	replacementClient := rig.waitHubClient(t, userID, "replacement client to take over in the hub", func(c *ws.Client) bool {
		return c != originalClient
	})

	// Assert 1: replacement client voiceChID == 0
	if got := ws.GetClientVoiceChIDForTest(replacementClient); got != 0 {
		t.Fatalf("fresh reconnect: replacement client voiceChID = %d, want 0", got)
	}

	// Assert 2: DB voice row is gone
	vs, vsErr := rig.db.GetVoiceState(context.Background(), userID)
	if vsErr != nil {
		t.Fatalf("GetVoiceState: %v", vsErr)
	}
	if vs != nil {
		t.Fatalf("fresh reconnect: stale voice state still in DB: channel_id=%d", vs.ChannelID)
	}

	// Assert 3: ready.payload.voice_states does not include the reconnecting user
	payload, _ := readyMsg["payload"].(map[string]any)
	voiceStates, _ := payload["voice_states"].([]any)
	for _, vsRaw := range voiceStates {
		vsMap, _ := vsRaw.(map[string]any)
		vsUserID, _ := vsMap["user_id"].(float64)
		if int64(vsUserID) == userID {
			t.Fatalf("ready payload must not include stale voice state for user %d: %+v", userID, vsMap)
		}
	}

	// Assert 4: observer saw exactly one voice_leave for our user+channel.
	// Read all pending messages — the observer may have received
	// member_join/presence/voice_leave since connecting.
	voiceLeaveCount := 0
	for {
		readCtx, readCancel := context.WithTimeout(ctx, 500*time.Millisecond)
		_, raw, readErr := obsConn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		if msgType == "voice_leave" {
			msgPayload, _ := msg["payload"].(map[string]any)
			msgUserID, _ := msgPayload["user_id"].(float64)
			msgChID, _ := msgPayload["channel_id"].(float64)
			if int64(msgUserID) == userID && int64(msgChID) == chID {
				voiceLeaveCount++
			}
		}
	}
	if voiceLeaveCount == 0 {
		t.Fatal("fresh reconnect: observer never received voice_leave for the ghost user")
	}
	if voiceLeaveCount > 1 {
		t.Fatalf("fresh reconnect: observer received %d voice_leave messages, want exactly 1", voiceLeaveCount)
	}
}

// TestServeWS_writePump_MessageDelivered verifies that messages queued on the
// hub are written through writePump to the connected client.
func TestServeWS_writePump_MessageDelivered(t *testing.T) {
	rig := newWSRig(t)
	_, token := rig.seedUser(t, "ws-pump-user", 1)
	ctx := testCtx(t, 10*time.Second)
	conn := rig.dialAuthed(t, ctx, token, 0)

	// Having read ready implies registration completed (serve.go registers
	// before writing ready) — broadcast immediately.
	rig.hub.BroadcastServerRestart("test", 0)

	// The client may receive member_join or presence first; read until
	// server_restart is found.
	if !readUntilType(ctx, conn, "server_restart", 6, 2*time.Second) {
		t.Error("did not receive server_restart broadcast via writePump")
	}
}

// TestIntegration_MessageRoundTrip verifies that two clients can exchange messages
// through the real WebSocket upgrade path: Client A sends chat_send, Client B
// receives chat_message via the hub broadcast.
func TestIntegration_MessageRoundTrip(t *testing.T) {
	rig := newWSRigWithServices(t)
	_, tokenA := rig.seedUser(t, "roundtrip-a", 1)
	userIDB, tokenB := rig.seedUser(t, "roundtrip-b", 1)
	chID, err := rig.db.CreateChannel(context.Background(), "integration-chat", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	ctx := testCtx(t, 10*time.Second)
	// Both clients have read their ready frames, so both are registered
	// (serve.go registers before writing ready).
	connA := rig.dialAuthed(t, ctx, tokenA, 0)
	connB := rig.dialAuthed(t, ctx, tokenB, 0)

	// Client B focuses on the channel so it receives channel-scoped broadcasts.
	writeFrame(t, ctx, connB, map[string]any{
		"type":    "channel_focus",
		"payload": map[string]any{"channel_id": chID},
	})
	waitFor(t, waitTimeout, func() bool {
		return slices.Contains(rig.hub.PubSubForTest().TopicsForUser(userIDB), ws.ChannelTopic(chID))
	}, "clientB channel_focus subscription to land")

	// Client A sends a chat message.
	writeFrame(t, ctx, connA, map[string]any{
		"type": "chat_send",
		"id":   "req-1",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from A",
		},
	})

	// Client B should receive a chat_message broadcast.
	// Drain a few messages (member_join, presence, etc.) until we find chat_message.
	found := false
	for i := 0; i < 15 && !found; i++ {
		env := readFrame(t, ctx, connB)
		if env["type"] != "chat_message" {
			continue
		}
		payload, _ := env["payload"].(map[string]any)
		if payload == nil {
			t.Fatal("chat_message has nil payload")
		}
		if payload["content"] != "hello from A" {
			t.Errorf("content = %q, want 'hello from A'", payload["content"])
		}
		user, _ := payload["user"].(map[string]any)
		if user == nil {
			t.Fatal("chat_message missing user")
		}
		if user["username"] != "roundtrip-a" {
			t.Errorf("username = %q, want 'roundtrip-a'", user["username"])
		}
		found = true
	}
	if !found {
		t.Error("clientB never received chat_message from clientA")
	}
}

// TestIntegration_SequenceNumbers verifies that broadcast messages delivered via
// the real WebSocket path carry a monotonically increasing `seq` field.
func TestIntegration_SequenceNumbers(t *testing.T) {
	rig := newWSRig(t)
	_, token := rig.seedUser(t, "seq-user", 1)
	ctx := testCtx(t, 10*time.Second)
	conn := rig.dialAuthed(t, ctx, token, 0)

	// Trigger two broadcasts.
	rig.hub.BroadcastServerRestart("test-seq-1", 10)
	rig.hub.BroadcastServerRestart("test-seq-2", 20)

	// Collect broadcast messages — they must carry monotonically increasing seq.
	var seqs []float64
	readCtx, readCancel := context.WithTimeout(ctx, 3*time.Second)
	defer readCancel()
	for range 10 {
		_, raw, readErr := conn.Read(readCtx)
		if readErr != nil {
			break
		}
		var env map[string]any
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		// Broadcasts go through deliverBroadcast which stamps seq.
		if seq, ok := env["seq"].(float64); ok {
			seqs = append(seqs, seq)
		}
		// Stop once we've collected at least 2 seq-bearing messages.
		if len(seqs) >= 2 {
			break
		}
	}

	if len(seqs) < 2 {
		t.Fatalf("expected at least 2 messages with seq field, got %d", len(seqs))
	}
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Errorf("seq not monotonically increasing: seq[%d]=%.0f seq[%d]=%.0f", i-1, seqs[i-1], i, seqs[i])
		}
	}
}

// TestServeWS_BannedUser_ReceivesError verifies that a banned user cannot connect.
func TestServeWS_BannedUser_ReceivesError(t *testing.T) {
	rig := newWSRig(t)
	userID, token := rig.seedUser(t, "ws-banned-user", 1)
	// Ban the user permanently.
	if err := rig.db.BanUser(context.Background(), userID, "test ban", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	ctx := testCtx(t, 5*time.Second)
	conn := rig.dial(t, ctx)
	writeFrame(t, ctx, conn, authFrame(map[string]any{"token": token}))

	_, respRaw, readErr := conn.Read(ctx)
	if readErr != nil {
		return // server closed connection — acceptable
	}
	var msg map[string]any
	if err := json.Unmarshal(respRaw, &msg); err == nil {
		msgType, _ := msg["type"].(string)
		if msgType == "auth_ok" {
			t.Error("banned user should not receive auth_ok")
		}
	}
}
