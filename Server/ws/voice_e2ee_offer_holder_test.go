package ws

import (
	"context"
	"testing"
	"time"
)

// An offer that passed the handler's key-holder check is delivered only if the
// sender is still the recorded holder, with a connection in the call, when the
// frame is sent.
func TestVoiceE2EEOffer_DeliveryRechecksKeyHolder(t *testing.T) {
	const voiceCh = 50
	cases := []struct {
		name        string
		between     func(h *Hub)
		wantDeliver bool
	}{
		{name: "holder unchanged", between: func(*Hub) {}, wantDeliver: true},
		{name: "lower uid join completes before delivery", between: func(h *Hub) {
			_ = registerEmitTestVoiceClient(h, 3, 0, voiceCh)
			h.updateKeyHolder(voiceCh)
		}, wantDeliver: false},
		{name: "lower uid join still in flight", between: func(h *Hub) {
			_ = registerEmitTestVoiceClient(h, 3, 0, voiceCh)
		}, wantDeliver: true},
		{name: "sender leaves before delivery", between: func(h *Hub) {
			SetClientVoiceChID(h.clients[5][0], 0)
		}, wantDeliver: false},
		{name: "sender has a second device outside the call", between: func(h *Hub) {
			other := NewTestClientWithChannel(h, 5, 0, make(chan []byte, 8))
			h.clients[5] = append(h.clients[5], other)
		}, wantDeliver: true},
		{name: "higher uid join completes before delivery", between: func(h *Hub) {
			_ = registerEmitTestVoiceClient(h, 9, 0, voiceCh)
			h.updateKeyHolder(voiceCh)
		}, wantDeliver: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newEmitTestHub()
			_ = registerEmitTestVoiceClient(h, 5, 0, voiceCh)
			sendTarget := registerEmitTestVoiceClient(h, 7, 0, voiceCh)
			h.updateKeyHolder(voiceCh)

			cmd := VoiceE2EEOfferCmd{userID: 5, TargetUserID: 7, EncryptedKey: validEncKey, IV: validIV}
			info := ClientInfo{UserID: 5, VoiceChannelID: voiceCh}
			result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, VoiceDeps{KeyHolder: h})
			if result.Error != nil {
				t.Fatalf("offer rejected at the handler: %v", result.Error)
			}

			tc.between(h)
			h.EmitEvents(context.Background(), result.Events)

			got := len(drainChan(sendTarget, 50*time.Millisecond))
			if tc.wantDeliver && got != 1 {
				t.Fatalf("target got %d frames, want the offer", got)
			}
			if !tc.wantDeliver && got != 0 {
				t.Fatalf("target got %d frames, want the offer dropped", got)
			}
		})
	}
}
