package ws_test

// handlers_command_test.go — tests for the chat_command handler and
// plugin EventSink wiring (Phase C Step 9).

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/owncord/server/plugin"
	"github.com/owncord/server/store"
	"github.com/owncord/server/ws"
)

// compile-time check that SetPluginRegistry is exported.
var _ = (*ws.Hub)(nil)

// ─── chat_command dispatch via HandleMessageForTest ───────────────────────────

// TestChatCommand_NoRegistry returns an error when no plugin registry is wired.
func TestChatCommand_NoRegistry_ReturnsError(t *testing.T) {
	hub, database := newTestHub(t)
	_ = database
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	defer hub.Unregister(c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_command",
		"payload": map[string]any{
			"channel_id": int64(1),
			"command":    "/hello",
			"args":       []string{},
		},
	})
	hub.HandleMessageForTest(c, raw)

	select {
	case msg := <-send:
		var env map[string]any
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env["type"] != "error" {
			t.Fatalf("expected type=error, got %v; raw=%s", env["type"], msg)
		}
	default:
		t.Fatal("expected error message to client")
	}
}

// TestChatCommand_UnknownCommand returns an error when the registry has no
// plugin owning the command.
func TestChatCommand_UnknownCommand_ReturnsError(t *testing.T) {
	hub, database := newTestHub(t)
	_ = database
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	defer hub.Unregister(c)

	mem := store.NewMemStore()
	reg, err := plugin.NewRegistry(plugin.Config{Store: mem})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	hub.SetPluginRegistry(reg)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_command",
		"payload": map[string]any{
			"channel_id": int64(1),
			"command":    "/notexist",
			"args":       []string{},
		},
	})
	hub.HandleMessageForTest(c, raw)

	select {
	case msg := <-send:
		var env map[string]any
		_ = json.Unmarshal(msg, &env)
		if env["type"] != "error" {
			t.Fatalf("expected type=error, got %v", env["type"])
		}
	default:
		t.Fatal("expected error message to client")
	}
}

// TestChatCommand_MalformedPayload returns bad-request when payload is not valid JSON.
func TestChatCommand_MalformedPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newTestHub(t)
	_ = database
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	defer hub.Unregister(c)

	raw := []byte(`{"type":"chat_command","payload":"not-an-object"}`)
	hub.HandleMessageForTest(c, raw)

	select {
	case msg := <-send:
		var env map[string]any
		_ = json.Unmarshal(msg, &env)
		if env["type"] != "error" {
			t.Fatalf("expected type=error, got %v", env["type"])
		}
	default:
		t.Fatal("expected error message")
	}
}

// ─── EventSink.Emit ───────────────────────────────────────────────────────────

// TestEventSink_Emit_DeliversToBroadcaster verifies that Emit calls the wired
// broadcaster with the correct channelID and payload.
func TestEventSink_Emit_DeliversToBroadcaster(t *testing.T) {
	sink := plugin.NewEventSink()

	var gotChannelID int64
	var gotPayload []byte
	sink.SetBroadcaster(func(channelID int64, payload []byte) {
		gotChannelID = channelID
		gotPayload = payload
	})

	want := []byte(`{"type":"plugin_event"}`)
	sink.Emit(42, want)

	if gotChannelID != 42 {
		t.Fatalf("expected channelID=42, got %d", gotChannelID)
	}
	if !bytes.Equal(gotPayload, want) {
		t.Fatalf("expected payload=%s, got %s", want, gotPayload)
	}
}

// TestEventSink_Emit_NilBroadcaster_NoOp verifies that Emit is safe when no
// broadcaster has been set.
func TestEventSink_Emit_NilBroadcaster_NoOp(t *testing.T) {
	sink := plugin.NewEventSink()
	sink.Emit(1, []byte(`{"type":"x"}`)) // must not panic
}

// TestEventSink_Emit_NilSink_NoOp verifies Emit is nil-safe.
func TestEventSink_Emit_NilSink_NoOp(t *testing.T) {
	var sink *plugin.EventSink
	sink.Emit(1, []byte(`{}`)) // must not panic
}

// ─── Hub plugin-sink wiring ───────────────────────────────────────────────────

// TestHub_SetPluginEventSink_NoOp verifies that wiring a plugin sink and
// broadcasting through the hub does not panic (default build no-ops Dispatch).
func TestHub_SetPluginEventSink_NoOp(t *testing.T) {
	hub, database := newTestHub(t)
	_ = database
	go hub.Run()
	defer hub.Stop()

	sink := plugin.NewEventSink()
	hub.SetPluginEventSink(sink)

	// Must not panic.
	hub.BroadcastToAll([]byte(`{"type":"test"}`))
}
