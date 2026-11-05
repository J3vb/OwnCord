package ws

// oc_0222_reconnect_status_order_test.go — regression test for OC-0222.
//
// handleReconnect wrote the resume handshake's auth_ok (reconnectWriteReplay,
// which reads c.user.Status) BEFORE calling applyConnectStatus, which is what
// settles c.user.Status via db.ConnectStatus(saved) and persists it. So a
// resumed auth_ok always carried the disconnect-time status rather than the
// status the session is about to come online as.
//
// Concretely: StampConnections rewrites a plain "online" user to
// "offline" on socket loss. On a fast reconnect (still covered by the ring
// buffer, so the buffer-tier replay path is taken) the resumed auth_ok's
// payload.user.status must reflect db.ConnectStatus("offline") == "online" —
// matching what applyConnectStatus is about to write and broadcast — not the
// raw "offline" row value read moments earlier by refreshUserSnapshot.
//
// handleFreshConnect already gets this right: it calls applyConnectStatus
// before building auth_ok (serve.go, handleFreshConnect). This test locks the
// same ordering for the resume path.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestReconnect_AuthOKReflectsSettledStatus_NotDisconnectTimeStatus(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID := mustCreateUser(t, database, "resume-status-user", 1)

	// Establish the user as a plain "online" session, then simulate the
	// socket loss that precedes every reconnect: StampConnections only
	// rewrites a plain "online" row to "offline" (idle/dnd/invisible survive
	// untouched), so this is the ordinary case, not a contrived one.
	if err := database.UpdateUserStatus(ctx, userID, db.StatusOnline); err != nil {
		t.Fatalf("UpdateUserStatus(online): %v", err)
	}
	if err := database.StampConnections(ctx, nil, []int64{userID}); err != nil {
		t.Fatalf("StampConnections: %v", err)
	}
	pre := mustGetUser(t, database, userID)
	if pre.Status != db.StatusOffline {
		t.Fatalf("precondition: expected status=offline after StampConnections, got %q", pre.Status)
	}

	token := seedSessionToken(t, database, userID)

	rig := newServeRigOn(t, database, nil)
	hub := rig.hub

	// Global (channel_id 0) frames bracketing last_seq=99, so the resume takes
	// the buffer tier rather than falling through to a full ready (which also
	// sends auth_ok, but via handleFreshConnect's already-correct ordering —
	// asserting on that path would not exercise the bug).
	rb := hub.ReplayBuffer()
	rb.Push(98, 0, []byte(`{"seq":98,"type":"presence","payload":{}}`))
	rb.Push(99, 0, []byte(`{"seq":99,"type":"presence","payload":{}}`))
	rb.Push(100, 0, []byte(`{"seq":100,"type":"presence","payload":{}}`))

	conn := rig.dialAuth(t, ctx, token, 99, 0)

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
	_, msg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(msg, &parsed); err != nil {
		t.Fatalf("unmarshal handshake response: %v; raw=%s", err, msg)
	}
	if parsed["type"] != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok (buffer-tier resume), got %v; raw=%s", parsed["type"], msg)
	}
	payload, _ := parsed["payload"].(map[string]any)
	if payload["replay_source"] != "buffer" {
		t.Fatalf("expected replay_source=buffer (so this exercises handleReconnect, not the fresh-connect fallback), got %v", payload["replay_source"])
	}
	userField, _ := payload["user"].(map[string]any)
	gotStatus, _ := userField["status"].(string)
	if gotStatus != db.StatusOnline {
		t.Fatalf("resumed auth_ok payload.user.status = %q, want %q (db.ConnectStatus of the pre-reconnect \"offline\" row) — "+
			"the resumed auth_ok must carry the status the session is settling on, not the stale disconnect-time row value",
			gotStatus, db.StatusOnline)
	}

	// The persisted row must agree with what auth_ok claimed — applyConnectStatus
	// must have actually run and been visible before/at the point auth_ok was
	// built, not merely be about to run after the client already parsed the
	// (wrong) value.
	post := mustGetUser(t, database, userID)
	if post.Status != db.StatusOnline {
		t.Fatalf("persisted status after reconnect = %q, want %q", post.Status, db.StatusOnline)
	}
}
