package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// envelope builds a raw client-to-server frame of the given type.
func envelope(typ string, payload any) []byte {
	raw, _ := json.Marshal(map[string]any{"type": typ, "payload": payload})
	return raw
}

// mustUnmarshal decodes raw into v, failing the test on malformed JSON.
func mustUnmarshal(t testing.TB, raw []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("unmarshal %T: %v (raw=%s)", v, err, raw)
	}
}

// mustBuildReady builds the ready frame for userID, failing the test on error.
func mustBuildReady(t testing.TB, hub *ws.Hub, database *db.DB, userID int64) []byte {
	t.Helper()
	raw, err := hub.BuildReadyForTest(database, userID)
	if err != nil {
		t.Fatalf("BuildReadyForTest(%d): %v", userID, err)
	}
	return raw
}

// mustBuildReadyWithRole is mustBuildReady with an explicit role snapshot.
func mustBuildReadyWithRole(t testing.TB, hub *ws.Hub, database *db.DB, userID int64, role *db.Role) []byte {
	t.Helper()
	raw, err := hub.BuildReadyWithRoleForTest(database, userID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest(%d): %v", userID, err)
	}
	return raw
}

// containsFrameType reports whether any raw frame has the given type.
func containsFrameType(frames [][]byte, typ string) bool {
	for _, raw := range frames {
		var env map[string]any
		if json.Unmarshal(raw, &env) == nil && env["type"] == typ {
			return true
		}
	}
	return false
}

// joinVoiceAndDrain sends voice_join for chID from c and discards the join
// traffic queued on send. It returns the frame so a test can replay it.
func joinVoiceAndDrain(hub *ws.Hub, c *ws.Client, send <-chan []byte, chID int64) []byte {
	raw := envelope("voice_join", map[string]any{"channel_id": chID})
	hub.HandleMessageForTest(c, raw)
	drainChanTimeout(send, 100*time.Millisecond)
	return raw
}
