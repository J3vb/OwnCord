package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
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

func TestRegisterV2AndDispatchV2(t *testing.T) {
	r := NewHandlerRegistry()

	handler := func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		_ = deps.(PingDeps) // verify deps wiring
		return Result{Reply: []byte("pong")}
	}
	r.RegisterV2("ping", handler, PingDeps{})

	cmd := &PingCmd{}
	info := ClientInfo{UserID: 1, Username: "test", ReqID: "r1"}
	result, ok := r.DispatchV2(context.Background(), cmd, info)
	if !ok {
		t.Fatal("DispatchV2 returned false for registered type")
	}
	if string(result.Reply) != "pong" {
		t.Errorf("expected reply %q, got %q", "pong", string(result.Reply))
	}
}

func TestDispatchV2_UnknownType_ReturnsFalse(t *testing.T) {
	r := NewHandlerRegistry()

	cmd := &PingCmd{}
	_, ok := r.DispatchV2(context.Background(), cmd, ClientInfo{})
	if ok {
		t.Fatal("DispatchV2 returned true for unregistered type")
	}
}

func TestDispatchV2_PanicIsRecovered(t *testing.T) {
	r := NewHandlerRegistry()
	r.RegisterV2("ping", func(_ context.Context, _ Command, _ ClientInfo, _ any) Result {
		panic("simulated internal panic")
	}, PingDeps{})

	result, ok := r.DispatchV2(context.Background(), &PingCmd{userID: 1}, ClientInfo{})
	if !ok {
		t.Fatal("DispatchV2 must return ok=true even after a panic (handler was found)")
	}
	ce, isCE := result.Error.(ClientError)
	if !isCE {
		t.Fatalf("expected ClientError after panic recovery, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected ErrCodeInternal, got %q", ce.Code)
	}
}

func TestRegisterV2_ShadowingGuard_Panics(t *testing.T) {
	r := NewHandlerRegistry()
	r.Register("ping", func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {})

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic from shadowing guard, got none")
		}
	}()
	r.RegisterV2("ping", func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		return Result{}
	}, PingDeps{})
}

func TestRegisterV2_DuplicateGuard_Panics(t *testing.T) {
	r := NewHandlerRegistry()
	handler := func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		return Result{}
	}
	r.RegisterV2("ping", handler, PingDeps{})

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic from duplicate guard, got none")
		}
	}()
	r.RegisterV2("ping", handler, PingDeps{})
}

func TestRegisteredV2Types(t *testing.T) {
	r := NewHandlerRegistry()
	handler := func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		return Result{}
	}
	r.RegisterV2("ping", handler, PingDeps{})
	r.RegisterV2("typing_start", handler, PresenceDeps{})

	types := r.RegisteredV2Types()
	sort.Strings(types)
	if len(types) != 2 || types[0] != "ping" || types[1] != "typing_start" {
		t.Errorf("expected [ping typing_start], got %v", types)
	}
}

func TestV1StillWorks_WhenV2HasEntries(t *testing.T) {
	r := NewHandlerRegistry()

	v1Called := false
	r.Register("chat_send", func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {
		v1Called = true
	})

	v2Handler := func(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
		return Result{Reply: []byte("v2")}
	}
	r.RegisterV2("ping", v2Handler, PingDeps{})

	// V1 dispatch still works
	ok := r.Dispatch(context.Background(), "chat_send", nil, nil, "", nil)
	if !ok || !v1Called {
		t.Fatal("V1 dispatch broken when V2 has entries")
	}

	// V2 dispatch for its own type works
	cmd := &PingCmd{}
	result, handled := r.DispatchV2(context.Background(), cmd, ClientInfo{})
	if !handled || string(result.Reply) != "v2" {
		t.Fatal("V2 dispatch broken")
	}

	// V2 dispatch for V1-only type returns false
	chatCmd := &ChatSendCmd{}
	_, handled = r.DispatchV2(context.Background(), chatCmd, ClientInfo{})
	if handled {
		t.Fatal("V2 dispatch returned true for V1-only type")
	}
}

func TestIsRegisteredV1(t *testing.T) {
	r := NewHandlerRegistry()
	r.Register("chat_send", func(ctx context.Context, h *Hub, c *Client, reqID string, payload json.RawMessage) {})

	if !r.IsRegisteredV1("chat_send") {
		t.Fatal("expected true for registered V1 type")
	}
	if r.IsRegisteredV1("nonexistent") {
		t.Fatal("expected false for unregistered type")
	}
}

func TestHandlerRegistry_AllExpectedTypesRegistered(t *testing.T) {
	r := NewHandlerRegistry()
	registerVoiceHandlersV1(r)
	registerPingHandler(r, PingDeps{})
	registerChatHandlers(r, ChatDeps{})
	registerPresenceHandlers(r, PresenceDeps{})
	registerReactionHandlers(r, ReactionDeps{})
	registerVoiceControlsV2(r, VoiceDeps{})

	// V1-only types (permanent — complex state/mutex requirements).
	expectedV1 := []string{
		"voice_join",
		"voice_leave",
	}

	// V2-migrated types.
	expectedV2 := []string{
		"ping",
		"typing_start",
		"presence_update",
		"channel_focus",
		"reaction_add",
		"reaction_remove",
		"chat_send",
		"chat_edit",
		"chat_delete",
		"voice_mute",
		"voice_deafen",
		"voice_camera",
		"voice_screenshare",
		"voice_e2ee_announce",
		"voice_e2ee_offer",
		"voice_token_refresh",
	}

	registeredV1 := r.RegisteredTypes()
	sort.Strings(registeredV1)
	sort.Strings(expectedV1)

	if len(registeredV1) != len(expectedV1) {
		t.Fatalf("V1: expected %d registered types, got %d\nexpected: %v\ngot:      %v",
			len(expectedV1), len(registeredV1), expectedV1, registeredV1)
	}
	for i, typ := range expectedV1 {
		if registeredV1[i] != typ {
			t.Errorf("V1 mismatch at index %d: expected %q, got %q", i, typ, registeredV1[i])
		}
	}

	registeredV2 := r.RegisteredV2Types()
	sort.Strings(registeredV2)
	sort.Strings(expectedV2)

	if len(registeredV2) != len(expectedV2) {
		t.Fatalf("V2: expected %d registered types, got %d\nexpected: %v\ngot:      %v",
			len(expectedV2), len(registeredV2), expectedV2, registeredV2)
	}
	for i, typ := range expectedV2 {
		if registeredV2[i] != typ {
			t.Errorf("V2 mismatch at index %d: expected %q, got %q", i, typ, registeredV2[i])
		}
	}
}

// TestAllV2Types_SmokeDispatch verifies that dispatching a minimal command
// for every V2-registered type does not panic (validates deps wiring).
func TestAllV2Types_SmokeDispatch(t *testing.T) {
	r := NewHandlerRegistry()
	registerPingHandler(r, PingDeps{})
	registerChatHandlers(r, ChatDeps{})
	registerPresenceHandlers(r, PresenceDeps{})
	registerReactionHandlers(r, ReactionDeps{})
	registerVoiceControlsV2(r, VoiceDeps{})

	// Minimal command for each V2 type — just needs Type() and UserID().
	cmds := map[string]Command{
		MsgTypePing:              PingCmd{userID: 1},
		MsgTypeChatSend:          ChatSendCmd{userID: 1, channelID: 1},
		MsgTypeChatEdit:          ChatEditCmd{userID: 1, messageID: 1},
		MsgTypeChatDelete:        ChatDeleteCmd{userID: 1, messageID: 1},
		MsgTypeTypingStart:       TypingStartCmd{userID: 1, channelID: 1},
		MsgTypePresenceUpdate:    PresenceUpdateCmd{userID: 1, status: "online"},
		MsgTypeChannelFocus:      ChannelFocusCmd{userID: 1, channelID: 1},
		MsgTypeReactionAdd:       ReactionAddCmd{userID: 1, messageID: 1, emoji: "👍"},
		MsgTypeReactionRemove:    ReactionRemoveCmd{userID: 1, messageID: 1, emoji: "👍"},
		MsgTypeVoiceMute:         VoiceMuteCmd{userID: 1},
		MsgTypeVoiceDeafen:       VoiceDeafenCmd{userID: 1},
		MsgTypeVoiceCamera:       VoiceCameraCmd{userID: 1},
		MsgTypeVoiceScreenshare:  VoiceScreenshareCmd{userID: 1},
		MsgTypeVoiceE2EEAnnounce: VoiceE2EEAnnounceCmd{userID: 1},
		MsgTypeVoiceE2EEOffer:    VoiceE2EEOfferCmd{userID: 1},
		MsgTypeVoiceTokenRefresh: VoiceTokenRefreshCmd{userID: 1},
	}

	for _, typ := range r.RegisteredV2Types() {
		cmd, exists := cmds[typ]
		if !exists {
			t.Errorf("no smoke command defined for V2 type %q", typ)
			continue
		}
		// We only care that the deps type assertion succeeds (no "interface
		// conversion" panic). Nil-pointer panics from zero-value DB/Limiter
		// fields are expected and harmless for this smoke test.
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					msg := fmt.Sprintf("%v", rec)
					if strings.Contains(msg, "interface conversion") {
						t.Errorf("V2 type %q: deps type assertion failed: %v", typ, rec)
					}
					// nil-pointer panics are expected with zero-value deps
				}
			}()
			// Bypass DispatchV2's own recover so we can inspect the panic value.
			entry := r.handlersV2[typ]
			entry.handler(context.Background(), cmd, ClientInfo{UserID: 1}, entry.deps)
		}()
	}
}
