package ws

import (
	"context"
	"errors"
	"sort"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// fullV2Registry registers the same handler set NewHub wires, so the
// migration-completeness tests below exercise the real production surface.
func fullV2Registry() *HandlerRegistry {
	r := NewHandlerRegistry()
	registerPingHandler(r, PingDeps{})
	registerChatHandlers(r, ChatDeps{})
	registerPresenceHandlers(r, PresenceDeps{})
	registerReactionHandlers(r, ReactionDeps{})
	r.RegisterV2(MsgTypeChatCommand, handleChatCommandV2, PluginDeps{})
	registerVoiceControlsV2(r, VoiceDeps{})
	registerCallHandlers(r, CallDeps{})
	return r
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
	var ce ClientError
	isCE := errors.As(result.Error, &ce)
	if !isCE {
		t.Fatalf("expected ClientError after panic recovery, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected ErrCodeInternal, got %q", ce.Code)
	}
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

// TestHandlerRegistry_AllExpectedTypesRegistered pins the full set of
// dispatchable types. After the V1→V2 migration completed, every type — voice
// join/leave and plugin commands included — is a typed V2 handler.
func TestHandlerRegistry_AllExpectedTypesRegistered(t *testing.T) {
	r := fullV2Registry()

	expected := []string{
		"ping",
		"typing_start",
		"presence_update",
		"channel_focus",
		"mark_read",
		"reaction_add",
		"reaction_remove",
		"chat_send",
		"chat_edit",
		"chat_delete",
		"chat_command",
		"voice_join",
		"voice_leave",
		"voice_mute",
		"voice_deafen",
		"voice_camera",
		"voice_screenshare",
		"voice_mod_mute",
		"voice_mod_deafen",
		"voice_mod_move",
		"voice_mod_kick",
		"voice_e2ee_announce",
		"voice_e2ee_offer",
		"voice_token_refresh",
		"call_ring",
		"call_decline",
	}

	registered := r.RegisteredV2Types()
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

// TestMigrationComplete_ConstructorHandlerParity locks the migration shut:
// every command constructor must have a registered V2 handler and vice versa,
// so a V1-style handler (a constructor with no V2 handler, or a handler with no
// strict parser) can never creep back in.
func TestMigrationComplete_ConstructorHandlerParity(t *testing.T) {
	r := fullV2Registry()

	v2 := make(map[string]bool)
	for _, typ := range r.RegisteredV2Types() {
		v2[typ] = true
		if _, ok := getCommandConstructor(typ); !ok {
			t.Errorf("V2 handler %q has no command constructor (strict parser missing)", typ)
		}
	}
	for typ := range commandConstructors {
		if !v2[typ] {
			t.Errorf("command constructor %q has no registered V2 handler", typ)
		}
	}
}

// TestAllV2Types_SmokeDispatch verifies that dispatching a minimal command
// for every V2-registered type does not panic (validates deps wiring). It runs
// the registry NewHub wires over a migrated DB and real services, so any
// panic is a failure: a deps type assertion that no longer matches, or a
// handler dereferencing a dependency the hub leaves nil. Zero-value deps would
// make the handlers nil-dereference instead, and on Windows a recovered nil
// dereference is a hardware exception whose frame can land below a small
// goroutine stack and corrupt the heap (golang/go#81238).
func TestAllV2Types_SmokeDispatch(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	r := newTestHub(t, database, limiter, service.New(database, limiter)).registry

	// Minimal command for each V2 type — just needs Type() and UserID().
	cmds := map[string]Command{
		MsgTypePing:              PingCmd{userID: 1},
		MsgTypeChatSend:          ChatSendCmd{userID: 1, ChannelID: 1},
		MsgTypeChatEdit:          ChatEditCmd{userID: 1, MessageID: 1},
		MsgTypeChatDelete:        ChatDeleteCmd{userID: 1, MessageID: 1},
		MsgTypeChatCommand:       ChatCommandCmd{userID: 1, ChannelID: 1, Command: "/x"},
		MsgTypeTypingStart:       TypingStartCmd{userID: 1, ChannelID: 1},
		MsgTypePresenceUpdate:    PresenceUpdateCmd{userID: 1, Status: "online"},
		MsgTypeChannelFocus:      ChannelFocusCmd{userID: 1, ChannelID: 1},
		MsgTypeMarkRead:          MarkReadCmd{userID: 1, ChannelID: 1},
		MsgTypeReactionAdd:       ReactionAddCmd{userID: 1, MessageID: 1, Emoji: "👍"},
		MsgTypeReactionRemove:    ReactionRemoveCmd{userID: 1, MessageID: 1, Emoji: "👍"},
		MsgTypeVoiceJoin:         VoiceJoinCmd{userID: 1, ChannelID: 1},
		MsgTypeVoiceLeave:        VoiceLeaveCmd{userID: 1},
		MsgTypeVoiceMute:         VoiceMuteCmd{userID: 1},
		MsgTypeVoiceDeafen:       VoiceDeafenCmd{userID: 1},
		MsgTypeVoiceCamera:       VoiceCameraCmd{userID: 1},
		MsgTypeVoiceScreenshare:  VoiceScreenshareCmd{userID: 1},
		MsgTypeVoiceModMute:      VoiceModMuteCmd{userID: 1, ChannelID: 1, TargetID: 2},
		MsgTypeVoiceModDeafen:    VoiceModDeafenCmd{userID: 1, ChannelID: 1, TargetID: 2},
		MsgTypeVoiceModMove:      VoiceModMoveCmd{userID: 1, TargetID: 2, ToChannelID: 2},
		MsgTypeVoiceModKick:      VoiceModKickCmd{userID: 1, TargetID: 2},
		MsgTypeVoiceE2EEAnnounce: VoiceE2EEAnnounceCmd{userID: 1},
		MsgTypeVoiceE2EEOffer:    VoiceE2EEOfferCmd{userID: 1},
		MsgTypeVoiceTokenRefresh: VoiceTokenRefreshCmd{userID: 1},
		MsgTypeCallRing:          CallRingCmd{userID: 1, ChannelID: 1},
		MsgTypeCallDecline:       CallDeclineCmd{userID: 1, ChannelID: 1},
	}

	for _, typ := range r.RegisteredV2Types() {
		cmd, exists := cmds[typ]
		if !exists {
			t.Errorf("no smoke command defined for V2 type %q", typ)
			continue
		}
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					t.Errorf("V2 type %q panicked: %v", typ, rec)
				}
			}()
			// Bypass DispatchV2's own recover so we can inspect the panic value.
			entry := r.handlersV2[typ]
			entry.handler(context.Background(), cmd, ClientInfo{UserID: 1}, entry.deps)
		}()
	}
}
