package ws

import (
	"context"
	"encoding/base64"
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
	if _, err := base64.StdEncoding.DecodeString(p.PublicKey); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "public_key is not valid base64"))
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
	// Size limits: AES-256-GCM encrypted 32-byte key ≈ 64 base64 chars + 16-byte
	// auth tag. 1024 chars is generous. IV is 12 bytes = 16 base64 chars.
	if len(p.EncryptedKey) > 1024 || len(p.IV) > 128 {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "encrypted_key or iv too large"))
		return
	}
	if _, err := base64.StdEncoding.DecodeString(p.EncryptedKey); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "encrypted_key is not valid base64"))
		return
	}
	if _, err := base64.StdEncoding.DecodeString(p.IV); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "iv is not valid base64"))
		return
	}

	// Verify the target is in the same voice channel — lookup and channel
	// check must be atomic (under the same lock hold) to prevent TOCTOU races
	// where the target leaves between lookup and the channel comparison.
	h.mu.RLock()
	target, ok := h.clients[p.TargetUserID]
	if !ok {
		h.mu.RUnlock()
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "target user not connected"))
		return
	}
	targetChID := target.getVoiceChID()
	h.mu.RUnlock()
	if targetChID != voiceChID {
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
