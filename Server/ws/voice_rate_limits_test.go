package ws

// voice_rate_limits_test.go — the refusal branch of the voice limiters that
// had no coverage: voice_join's precheck (voice_join.go), the shared
// voice_mute/voice_deafen self-toggle (voice_controls.go) and
// voice_e2ee_announce (voice_e2ee.go). Their siblings (voice_leave,
// camera/screenshare, the e2ee offer budgets, plugin_cmd) are all already
// pinned; these three were the gap.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// decodeErrorFrame extracts the code from a server->client error envelope.
func decodeErrorFrame(t *testing.T, frame []byte) string {
	t.Helper()
	var env struct {
		Type    string `json:"type"`
		Payload struct {
			Code string `json:"code"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(frame, &env); err != nil {
		t.Fatalf("unmarshal frame %s: %v", frame, err)
	}
	if env.Type != MsgTypeError {
		t.Fatalf("expected an error frame, got type %q (%s)", env.Type, frame)
	}
	return env.Payload.Code
}

// voice_join fans a voice_state broadcast out to every connected client, so
// the limiter is consulted first — before the payload is even parsed. A
// payload that could never join therefore still burns a token, and once the
// budget is gone the refusal is RATE_LIMITED rather than the parse error.
func TestVoiceJoinPrecheck_RateLimited(t *testing.T) {
	h := &Hub{limiter: auth.NewRateLimiter()}
	send := make(chan []byte, voiceJoinRateLimit+2)
	c := &Client{userID: 1, send: send, sendHigh: send, sendLow: send}
	payload := json.RawMessage(`{"channel_id":"not-an-int"}`)

	for i := range voiceJoinRateLimit + 1 {
		if _, _, ok := h.voiceJoinPrecheck(context.Background(), c, payload); ok {
			t.Fatalf("call %d: precheck passed on a malformed payload", i)
		}
	}

	if got := len(send); got != voiceJoinRateLimit+1 {
		t.Fatalf("queued %d error frames, want %d", got, voiceJoinRateLimit+1)
	}
	for i := range voiceJoinRateLimit {
		if code := decodeErrorFrame(t, <-send); code != ErrCodeBadRequest {
			t.Errorf("call %d: code = %q, want %q (limit not yet reached)", i, code, ErrCodeBadRequest)
		}
	}
	if code := decodeErrorFrame(t, <-send); code != ErrCodeRateLimited {
		t.Errorf("call past the budget: code = %q, want %q", code, ErrCodeRateLimited)
	}
}

// The V2 voice handlers whose rate-limit refusal was unexercised. Each case
// runs with VoiceChannelID=0 so the calls that pass the limiter stop at the
// next gate (VOICE_ERROR) instead of reaching the DB — which also pins the
// ordering: the limiter runs before the in-voice check.
func TestVoiceHandlersV2_RateLimited(t *testing.T) {
	ctx := context.Background()
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 0}

	tests := []struct {
		name    string
		limit   int
		wantMsg string
		call    func(VoiceDeps) Result
	}{
		{
			name:    "voice_mute",
			limit:   voiceMuteRateLimit,
			wantMsg: "too many mute toggles",
			call: func(d VoiceDeps) Result {
				return handleVoiceMuteV2(ctx, VoiceMuteCmd{userID: 1, muted: true}, info, d)
			},
		},
		{
			name:    "voice_deafen",
			limit:   voiceDeafenRateLimit,
			wantMsg: "too many deafen toggles",
			call: func(d VoiceDeps) Result {
				return handleVoiceDeafenV2(ctx, VoiceDeafenCmd{userID: 1, deafened: true}, info, d)
			},
		},
		{
			name:    "voice_e2ee_announce",
			limit:   voiceE2EERateLimit,
			wantMsg: "too many e2ee announcements",
			call: func(d VoiceDeps) Result {
				return handleVoiceE2EEAnnounceV2(ctx, VoiceE2EEAnnounceCmd{userID: 1, publicKey: validB64Key}, info, d)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			deps := VoiceDeps{Limiter: auth.NewRateLimiter()}

			for i := range tt.limit {
				res := tt.call(deps)
				var ce ClientError
				ok := errors.As(res.Error, &ce)
				if !ok {
					t.Fatalf("call %d: expected ClientError, got %v", i, res.Error)
				}
				if ce.Code != ErrCodeVoiceError {
					t.Fatalf("call %d: code = %q, want %q (limit not yet reached)", i, ce.Code, ErrCodeVoiceError)
				}
			}

			res := tt.call(deps)
			var ce ClientError
			ok := errors.As(res.Error, &ce)
			if !ok {
				t.Fatalf("expected ClientError past the budget, got %v", res.Error)
			}
			if ce.Code != ErrCodeRateLimited {
				t.Errorf("code = %q, want %q", ce.Code, ErrCodeRateLimited)
			}
			if ce.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", ce.Message, tt.wantMsg)
			}
		})
	}
}
