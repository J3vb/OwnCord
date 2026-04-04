package ws

import (
	"context"
	"encoding/json"
	"log/slog"
)

// handleVoiceE2EEAnnounce processes a client's ECDH public key announcement.
// The server stores the key on the Client struct and relays it to all other
// participants in the same voice channel. The server never sees or generates
// the room encryption key — only opaque public keys pass through.
func (h *Hub) handleVoiceE2EEAnnounce(_ context.Context, c *Client, payload json.RawMessage) {
	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "not in a voice channel"))
		return
	}

	var p voiceE2EEAnnounceIn
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "invalid voice_e2ee_announce payload"))
		return
	}
	if p.PublicKey == "" {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "public_key is required"))
		return
	}
	// Sanity check: base64-encoded P-256 public key is ~88 chars (uncompressed)
	// or ~44 chars (compressed). Allow up to 256 chars to be safe.
	if len(p.PublicKey) > 256 {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "public_key too large"))
		return
	}

	// Store the public key on the client for later retrieval by new joiners.
	c.setE2EEPubKey(p.PublicKey)

	// Relay to all other clients in the same voice channel.
	msg := buildVoiceE2EEAnnounce(c.userID, p.PublicKey)
	h.sendToVoiceChannelExcept(voiceChID, c.userID, msg)

	slog.Debug("voice e2ee: announce relayed", "user_id", c.userID, "channel_id", voiceChID)
}

// handleVoiceE2EEOffer relays an encrypted room key from one participant to
// another. The payload is opaque to the server — it contains an AES-GCM
// encrypted room key that only the target can decrypt via ECDH.
func (h *Hub) handleVoiceE2EEOffer(_ context.Context, c *Client, payload json.RawMessage) {
	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "not in a voice channel"))
		return
	}

	var p voiceE2EEOfferIn
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "invalid voice_e2ee_offer payload"))
		return
	}
	if p.TargetUserID <= 0 || p.EncryptedKey == "" || p.IV == "" {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "target_user_id, encrypted_key, and iv are required"))
		return
	}

	// Verify the target is in the same voice channel.
	h.mu.RLock()
	target, ok := h.clients[p.TargetUserID]
	h.mu.RUnlock()
	if !ok {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "target user not connected"))
		return
	}
	if target.getVoiceChID() != voiceChID {
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "target user not in your voice channel"))
		return
	}

	// Relay the encrypted key offer to the target.
	msg := buildVoiceE2EEOffer(c.userID, p.EncryptedKey, p.IV)
	target.sendMsg(msg)

	slog.Debug("voice e2ee: offer relayed",
		"from_user_id", c.userID, "to_user_id", p.TargetUserID, "channel_id", voiceChID)
}

// sendToVoiceChannelExcept sends a message to all clients in the given voice
// channel except the one identified by excludeUserID.
func (h *Hub) sendToVoiceChannelExcept(channelID int64, excludeUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for uid, client := range h.clients {
		if uid == excludeUserID {
			continue
		}
		if client.getVoiceChID() == channelID {
			client.sendMsg(msg)
		}
	}
}

// getClientE2EEPubKey returns the stored ECDH public key for a connected user.
func (h *Hub) getClientE2EEPubKey(userID int64) string {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return ""
	}
	return c.getE2EEPubKey()
}
