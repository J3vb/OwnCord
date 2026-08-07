package ws

// serve_failed_handshake_teardown_test.go — regression tests for the two
// defects in unregisterFailedHandshake (serve.go).
//
// v039: the failure path mirrored only the presence half of readPump's defer,
// so a connection that inherited a transferred voice session left the
// voice_states row, the LiveKit participant and the E2EE key-holder entry
// standing until the next 60s sweep — and sweepStaleVoiceStates never
// re-elects the key holder, so rekey offers from the real lowest-uid
// participant were rejected with NOT_KEY_HOLDER in the meantime.
//
// v064: the offline presence broadcast shipped c.user.CustomStatus, a snapshot
// frozen at authentication (client.go assigns c.user exactly once), so a status
// the user changed or cleared mid-session was resurrected on every viewer.

import (
	"bytes"
	"context"
	"testing"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// newTeardownTestDB opens an in-memory database with the full migration set.
func newTeardownTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// TestFailedHandshake_TearsDownTransferredVoiceSession locks the voice half of
// the disconnect teardown on the handshake-failure path.
//
// Reachability, per the finding: on the replay-failure fallback the handshake
// deliberately keeps the voice_states row (handleFreshConnect) and registerNow
// transfers the live voice session onto the new client. If the auth_ok or ready
// write on that new socket then fails, no readPump ever starts, so
// unregisterFailedHandshake is the only teardown that can run.
func TestFailedHandshake_TearsDownTransferredVoiceSession(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "voice-handshake-fail", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	vcID, err := database.CreateChannel(ctx, "vc-teardown", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, userID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(ctx, userID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	// Run is deliberately not started so h.broadcast can be inspected directly.
	h := NewHub(database, auth.NewRateLimiter(), nil)

	// Old connection A holds the slot and the voice session; B replaces it on
	// the replay-failure fallback (lastSeq > 0), inheriting the session.
	oldClient := NewTestClient(h, userID, make(chan []byte, 64))
	oldClient.user = &db.User{ID: userID, Status: "online"}
	oldClient.setVoiceState(vcID, vs.JoinedAt)
	h.clients[userID] = oldClient
	h.updateKeyHolder(vcID)

	newClient := NewTestClient(h, userID, make(chan []byte, 64))
	newClient.user = &db.User{ID: userID, Status: "online"}
	newClient.lastSeq = 1
	h.registerNow(newClient, map[int64]bool{vcID: true})
	if replaced := h.unregisterNow(oldClient); !replaced {
		t.Fatal("precondition: old client's defer must see itself replaced")
	}
	if got := newClient.getVoiceChID(); got != vcID {
		t.Fatalf("precondition: registerNow must transfer the voice session, got voice_ch_id=%d", got)
	}
	if !h.IsVoiceKeyHolder(vcID, userID) {
		t.Fatal("precondition: the transferred session must hold the E2EE key")
	}

	// B's auth_ok/ready write fails; the handshake failure path runs.
	h.unregisterFailedHandshake(ctx, newClient)

	if after, err := database.GetVoiceState(ctx, userID); err != nil {
		t.Fatalf("GetVoiceState after teardown: %v", err)
	} else if after != nil {
		t.Errorf("voice_states row survived a failed handshake with no replacement connection: %+v", after)
	}
	if h.IsVoiceKeyHolder(vcID, userID) {
		t.Error("voiceKeyHolders still names the departed connection — the real lowest-uid participant's rekey offers stay rejected")
	}

	// The voice_leave broadcast must go out too, or every other client keeps
	// rendering a tile for a participant that is gone.
	sawVoiceLeave := false
	for len(h.broadcast) > 0 {
		bm := <-h.broadcast
		if bytes.Contains(bm.msg, []byte(`"type":"`+MsgTypeVoiceLeaveBC+`"`)) {
			sawVoiceLeave = true
		}
	}
	if !sawVoiceLeave {
		t.Error("no voice_leave broadcast queued after the failed handshake teardown")
	}
}

// TestFailedHandshake_OfflineBroadcastDropsStaleCustomStatus locks that the
// offline presence broadcast carries a null custom status rather than the
// auth-time snapshot on c.user, matching presentableMembers' rule that a member
// with no live connection shows no custom status.
func TestFailedHandshake_OfflineBroadcastDropsStaleCustomStatus(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "stale-custom-status", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)

	stale := "On vacation"
	c := NewTestClient(h, userID, make(chan []byte, 8))
	c.user = &db.User{ID: userID, Status: "online", CustomStatus: &stale}
	h.registerNow(c, nil)

	h.unregisterFailedHandshake(ctx, c)

	var presence []byte
	for len(h.broadcast) > 0 {
		bm := <-h.broadcast
		if bytes.Contains(bm.msg, []byte(`"type":"`+MsgTypePresence+`"`)) {
			presence = bm.msg
		}
	}
	if presence == nil {
		t.Fatal("no presence broadcast queued after the failed handshake teardown")
	}
	if bytes.Contains(presence, []byte(stale)) {
		t.Errorf("offline broadcast resurrected the auth-time custom status: %s", presence)
	}
	if !bytes.Contains(presence, []byte(`"custom_status":null`)) {
		t.Errorf("offline broadcast must clear custom_status explicitly (it is never omitempty): %s", presence)
	}
}
