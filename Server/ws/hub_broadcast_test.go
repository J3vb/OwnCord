package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

// BroadcastUserUpdate, BroadcastDropCount and SetEventPersister had no
// coverage. The first is what propagates a profile or identity-key change to
// every connected client — an identity key that fails to propagate silently
// breaks E2EE key agreement for everyone already online.

// awaitMessage reads one message from ch, failing if none arrives.
func awaitMessage(t *testing.T, ch chan []byte) map[string]any {
	t.Helper()
	select {
	case raw := <-ch:
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("unmarshal %q: %v", raw, err)
		}
		return msg
	case <-time.After(2 * time.Second):
		t.Fatal("no message received")
		return nil
	}
}

func TestHub_BroadcastUserUpdate(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	client := ws.NewTestClient(hub, 1, send)
	hub.RegisterNowForTest(client)

	avatar := "avatar.png"
	identityKey := "pubkey-abc"
	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 42, Username: "renamed", Avatar: &avatar, IdentityPublicKey: &identityKey})

	msg := awaitMessage(t, send)
	if msg["type"] != "user_update" {
		t.Fatalf("type = %v, want user_update", msg["type"])
	}
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload is not an object: %v", msg["payload"])
	}
	if payload["user_id"] != float64(42) {
		t.Errorf("user_id = %v, want 42", payload["user_id"])
	}
	if payload["username"] != "renamed" {
		t.Errorf("username = %v, want renamed", payload["username"])
	}
	if payload["avatar"] != "avatar.png" {
		t.Errorf("avatar = %v, want avatar.png", payload["avatar"])
	}
	// The identity key is the E2EE handshake input; dropping it here would
	// leave peers unable to derive a session with this user.
	if payload["identity_public_key"] != "pubkey-abc" {
		t.Errorf("identity_public_key = %v, want pubkey-abc", payload["identity_public_key"])
	}
}

func TestHub_BroadcastUserUpdate_NilOptionalFields(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, send))

	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 42, Username: "noextras"})

	msg := awaitMessage(t, send)
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload is not an object: %v", msg["payload"])
	}
	if payload["username"] != "noextras" {
		t.Errorf("username = %v, want noextras", payload["username"])
	}
	// A user with no avatar / no published key must serialize as null rather
	// than an empty string, so clients can tell "unset" from "cleared".
	if v, present := payload["avatar"]; present && v != nil {
		t.Errorf("avatar = %v, want null", v)
	}
	if v, present := payload["identity_public_key"]; present && v != nil {
		t.Errorf("identity_public_key = %v, want null", v)
	}
}

func TestHub_BroadcastUserUpdate_ReachesEveryClient(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	a := make(chan []byte, 8)
	b := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, a))
	hub.RegisterNowForTest(ws.NewTestClient(hub, 2, b))

	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 7, Username: "everyone"})

	for i, ch := range []chan []byte{a, b} {
		msg := awaitMessage(t, ch)
		if msg["type"] != "user_update" {
			t.Errorf("client %d got type %v, want user_update", i, msg["type"])
		}
	}
}

func TestHub_BroadcastDropCount(t *testing.T) {
	hub, _ := newTestHub(t)

	// A hub that has broadcast nothing has dropped nothing. The admin
	// diagnostics endpoint reads this counter, so a nonzero baseline would
	// read as backpressure that never happened.
	if got := hub.BroadcastDropCount(); got != 0 {
		t.Errorf("BroadcastDropCount = %d on a fresh hub, want 0", got)
	}

	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, send))
	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 1, Username: "u"})
	awaitMessage(t, send)

	// A single delivered broadcast must not increment the drop counter.
	if got := hub.BroadcastDropCount(); got != 0 {
		t.Errorf("BroadcastDropCount = %d after one delivered broadcast, want 0", got)
	}
}

func TestHub_SetEventPersister(t *testing.T) {
	hub, database := newTestHub(t)

	persister := ws.NewEventPersister(database, 16, 4, 10*time.Millisecond)

	// Setting and clearing must both be safe — SetEventPersister is called at
	// startup and again on shutdown/reconfiguration.
	hub.SetEventPersister(persister)
	hub.SetEventPersister(nil)
	hub.SetEventPersister(persister)
}
