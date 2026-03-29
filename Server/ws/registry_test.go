package ws

import (
	"context"
	"encoding/json"
	"sort"
	"testing"
)

func TestHandlerRegistry_RegisterAndDispatch(t *testing.T) {
	r := NewHandlerRegistry()

	called := false
	r.Register("test_type", func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
		called = true
		if reqID != "req-1" {
			t.Errorf("expected reqID %q, got %q", "req-1", reqID)
		}
	})

	ok := r.Dispatch(context.Background(), "test_type", nil, nil, "req-1", nil)
	if !ok {
		t.Fatal("Dispatch returned false for registered type")
	}
	if !called {
		t.Fatal("handler was not called")
	}
}

func TestHandlerRegistry_DispatchUnknownType(t *testing.T) {
	r := NewHandlerRegistry()

	ok := r.Dispatch(context.Background(), "nonexistent", nil, nil, "", nil)
	if ok {
		t.Fatal("Dispatch returned true for unregistered type")
	}
}

func TestHandlerRegistry_AllExpectedTypesRegistered(t *testing.T) {
	r := NewHandlerRegistry()
	registerChatHandlers(r)
	registerPresenceHandlers(r)
	registerReactionHandlers(r)
	registerVoiceHandlers(r)
	registerPingHandler(r)

	expected := []string{
		"chat_send",
		"chat_edit",
		"chat_delete",
		"reaction_add",
		"reaction_remove",
		"typing_start",
		"presence_update",
		"channel_focus",
		"voice_join",
		"voice_leave",
		"voice_token_refresh",
		"voice_mute",
		"voice_deafen",
		"voice_camera",
		"voice_screenshare",
		"ping",
	}

	registered := r.RegisteredTypes()
	sort.Strings(registered)
	sort.Strings(expected)

	if len(registered) != len(expected) {
		t.Fatalf("expected %d registered types, got %d\nexpected: %v\ngot:      %v",
			len(expected), len(registered), expected, registered)
	}

	for i, typ := range expected {
		if registered[i] != typ {
			t.Errorf("mismatch at index %d: expected %q, got %q", i, typ, registered[i])
		}
	}
}
