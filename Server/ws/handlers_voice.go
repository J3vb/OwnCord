package ws

import (
	"context"
	"encoding/json"
	"fmt"
)

// registerVoiceHandlersV1 registers voice handlers that remain V1 (complex
// state management that hasn't been migrated yet).
func registerVoiceHandlersV1(r *HandlerRegistry) {
	r.Register(MsgTypeVoiceJoin, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceJoin(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceLeave, func(ctx context.Context, h *Hub, c *Client, _ string, _ json.RawMessage) {
		// Rate limit only the explicit client-initiated voice_leave message.
		// handleVoiceLeave is also invoked internally for disconnect and
		// channel-switch cleanup (serve.go, voice_join.go); those paths must
		// never be throttled or they would leak ghost voice states, so the
		// limit lives here in the dispatch wrapper rather than inside the shared
		// handleVoiceLeave routine. Mirrors the voice control Limiter idiom.
		ratKey := fmt.Sprintf("voice_leave:%d", c.userID)
		if h.limiter != nil && !h.limiter.Allow(ratKey, voiceLeaveRateLimit, voiceLeaveWindow) {
			c.sendMsg(buildErrorMsg(ErrCodeRateLimited, "too many voice leave attempts"))
			return
		}
		h.handleVoiceLeave(ctx, c)
	})
}

// registerVoiceControlsV2 registers V2 handlers for voice control toggles
// and other migrated voice handlers.
func registerVoiceControlsV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceMute, handleVoiceMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceDeafen, handleVoiceDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceCamera, handleVoiceCameraV2, deps)
	r.RegisterV2(MsgTypeVoiceScreenshare, handleVoiceScreenshareV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEAnnounce, handleVoiceE2EEAnnounceV2, deps)
	r.RegisterV2(MsgTypeVoiceE2EEOffer, handleVoiceE2EEOfferV2, deps)
	r.RegisterV2(MsgTypeVoiceTokenRefresh, handleVoiceTokenRefreshV2, deps)
}
