package ws

import (
	"context"
	"encoding/json"
)

// registerVoiceHandlersV1 registers voice handlers that remain V1 (complex
// state management that hasn't been migrated yet).
func registerVoiceHandlersV1(r *HandlerRegistry) {
	r.Register(MsgTypeVoiceJoin, func(ctx context.Context, h *Hub, c *Client, _ string, payload json.RawMessage) {
		h.handleVoiceJoin(ctx, c, payload)
	})
	r.Register(MsgTypeVoiceLeave, func(ctx context.Context, h *Hub, c *Client, _ string, _ json.RawMessage) {
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
