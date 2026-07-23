package ws

// handler_v2_migration_test.go — unit tests for the three handlers ported from
// V1 to V2 in the dispatch-migration finish (audit A-2026-07-09 / backlog 11):
// chat_command, voice_join, voice_leave.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/owncord/server/auth"
)

// ── voice_join V2 ────────────────────────────────────────────────────────────

// The V2 handler is a thin gate: the constructor validates channel_id and the
// handler hands off to the hub's handleVoiceJoin routine via Result.JoinVoice.
func TestHandleVoiceJoinV2_SignalsJoin(t *testing.T) {
	result := handleVoiceJoinV2(context.Background(), VoiceJoinCmd{userID: 1, channelID: 7}, ClientInfo{UserID: 1}, VoiceDeps{})
	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if !result.JoinVoice {
		t.Error("expected JoinVoice=true so the applier runs handleVoiceJoin")
	}
	if result.LeaveVoice {
		t.Error("voice_join must not signal LeaveVoice")
	}
}

// voice_join parse errors are surfaced by the constructor (before dispatch).
func TestVoiceJoinConstructor_Errors(t *testing.T) {
	ctor, ok := getCommandConstructor(MsgTypeVoiceJoin)
	if !ok {
		t.Fatal("no constructor for voice_join")
	}
	for _, raw := range []string{`{"channel_id":"nope"}`, `{"channel_id":0}`, `{"channel_id":-3}`} {
		if _, err := ctor(1, "r", json.RawMessage(raw)); err == nil {
			t.Errorf("expected parse error for %s", raw)
		}
	}
	cmd, err := ctor(1, "r", json.RawMessage(`{"channel_id":42}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd.(VoiceJoinCmd).ChannelID() != 42 {
		t.Errorf("ChannelID() = %d, want 42", cmd.(VoiceJoinCmd).ChannelID())
	}
}

// ── voice_leave V2 ───────────────────────────────────────────────────────────

func TestHandleVoiceLeaveV2_SignalsLeave(t *testing.T) {
	deps := VoiceDeps{Limiter: auth.NewRateLimiter()}
	result := handleVoiceLeaveV2(context.Background(), VoiceLeaveCmd{userID: 1}, ClientInfo{UserID: 1}, deps)
	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if !result.LeaveVoice {
		t.Error("expected LeaveVoice=true so the applier runs handleVoiceLeave")
	}
	if result.JoinVoice {
		t.Error("voice_leave must not signal JoinVoice")
	}
}

// The rate-limit that used to live in the V1 dispatch wrapper now lives in the
// V2 handler; disconnect/switch callers of handleVoiceLeave bypass it entirely.
func TestHandleVoiceLeaveV2_RateLimited(t *testing.T) {
	deps := VoiceDeps{Limiter: auth.NewRateLimiter()}
	cmd := VoiceLeaveCmd{userID: 1}
	info := ClientInfo{UserID: 1}

	// voiceLeaveRateLimit (5) per voiceLeaveWindow (1s) — the 6th is rejected.
	var limited bool
	for i := 0; i < voiceLeaveRateLimit+1; i++ {
		res := handleVoiceLeaveV2(context.Background(), cmd, info, deps)
		if res.Error != nil {
			ce, ok := res.Error.(ClientError)
			if !ok || ce.Code != ErrCodeRateLimited {
				t.Fatalf("expected rate-limit ClientError, got %v", res.Error)
			}
			limited = true
		}
	}
	if !limited {
		t.Error("expected voice_leave to be rate limited after the burst")
	}
}

// ── chat_command V2 ──────────────────────────────────────────────────────────

func TestChatCommandConstructor_Errors(t *testing.T) {
	ctor, ok := getCommandConstructor(MsgTypeChatCommand)
	if !ok {
		t.Fatal("no constructor for chat_command")
	}

	if _, err := ctor(1, "r", json.RawMessage(`"not-an-object"`)); err == nil {
		t.Error("expected error for malformed payload")
	}
	if _, err := ctor(1, "r", json.RawMessage(`{"command":"   "}`)); err == nil {
		t.Error("expected error for empty command")
	}

	tooMany := make([]string, maxCommandArgs+1)
	payload, _ := json.Marshal(map[string]any{"command": "/x", "args": tooMany})
	if _, err := ctor(1, "r", payload); err == nil {
		t.Error("expected error for too many args")
	}

	cmd, err := ctor(1, "req-9", json.RawMessage(`{"channel_id":5,"command":"  /hi  ","args":["a","b"]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	cc := cmd.(ChatCommandCmd)
	if cc.ChannelID() != 5 || cc.Command() != "/hi" || cc.ReqID() != "req-9" || len(cc.Args()) != 2 {
		t.Errorf("unexpected command fields: %+v", cc)
	}
}

func TestHandleChatCommandV2_NoRegistry(t *testing.T) {
	deps := PluginDeps{Registry: nil, MessageSvc: nil}
	cmd := ChatCommandCmd{userID: 1, channelID: 1, command: "/hi"}

	result := handleChatCommandV2(context.Background(), cmd, ClientInfo{UserID: 1}, deps)

	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadRequest {
		t.Errorf("expected BAD_REQUEST, got %q", ce.Code)
	}
	if result.Reply != nil || len(result.Events) != 0 {
		t.Error("no reply or events expected when no registry is wired")
	}
}

// canPluginBroadcast fails closed when the posting-gate service is absent.
func TestCanPluginBroadcast_NilServiceFailsClosed(t *testing.T) {
	gate := canPluginBroadcast(context.Background(), nil, 1, 2)
	if gate == nil {
		t.Fatal("expected a forbidden Result when MessageSvc is nil")
	}
	ce, ok := gate.Error.(ClientError)
	if !ok || ce.Code != ErrCodeForbidden {
		t.Errorf("expected FORBIDDEN ClientError, got %v", gate.Error)
	}
}
