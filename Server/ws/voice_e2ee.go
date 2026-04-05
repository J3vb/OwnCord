package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
)

// decodeBase64Loose accepts both padded (StdEncoding) and unpadded (RawStdEncoding)
// standard-alphabet base64. ECDH public keys exported from WebCrypto omit '='
// padding; we accept both forms to avoid breaking existing clients.
// Note: URL-safe base64 (alphabet '-_') is not accepted; clients must use the
// standard alphabet ('+/').
func decodeBase64Loose(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// updateKeyHolder scans connected clients to find the one with the lowest
// userID currently in channelID, and records them as the key holder.
// If no clients remain in the channel the entry is deleted.
// Must NOT be called while h.mu or h.keyHolderMu is held.
// Lock order: keyHolderMu (write) → h.mu (read). Holding keyHolderMu for
// the entire scan+write prevents two concurrent calls from racing and
// overwriting each other with a stale result.
func (h *Hub) updateKeyHolder(channelID int64) {
	h.keyHolderMu.Lock()
	defer h.keyHolderMu.Unlock()

	h.mu.RLock()
	var minUserID int64
	found := false
	for uid, c := range h.clients {
		if c.getVoiceChID() == channelID {
			if !found || uid < minUserID {
				minUserID = uid
				found = true
			}
		}
	}
	h.mu.RUnlock()

	if found {
		h.voiceKeyHolders[channelID] = minUserID
	} else {
		delete(h.voiceKeyHolders, channelID)
	}
}

// isVoiceKeyHolder reports whether userID is the current key holder for channelID.
func (h *Hub) isVoiceKeyHolder(channelID, userID int64) bool {
	h.keyHolderMu.RLock()
	kh, ok := h.voiceKeyHolders[channelID]
	h.keyHolderMu.RUnlock()
	return ok && kh == userID
}

// computeIsKeyHolder determines whether userID will become the key holder when
// joining channelID. Returns true if no connected client in that channel has a
// lower userID. This is used before calling setVoiceState so the result can be
// included in the voice_token message sent to the joiner.
func (h *Hub) computeIsKeyHolder(channelID, userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for uid, c := range h.clients {
		if c.getVoiceChID() == channelID && uid < userID {
			return false
		}
	}
	return true
}

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
	// P-256 uncompressed public key = 65 bytes → 88 base64 chars.
	// Allow up to 128 chars for padding tolerance.
	if len(p.PublicKey) > 128 {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "public_key too large"))
		return
	}
	if _, err := decodeBase64Loose(p.PublicKey); err != nil {
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
	if _, err := decodeBase64Loose(p.EncryptedKey); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "encrypted_key is not valid base64"))
		return
	}
	if _, err := decodeBase64Loose(p.IV); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "iv is not valid base64"))
		return
	}

	// I-1: Only the designated key holder may distribute the room key. This
	// prevents any other participant from performing a key substitution attack.
	if !h.isVoiceKeyHolder(voiceChID, c.userID) {
		c.sendMsg(buildErrorMsg(ErrCodeNotKeyHolder, "only the key holder may send key offers"))
		return
	}

	// Verify the target is in the same voice channel, then relay — all under
	// one h.mu.RLock hold so the check and send are atomic. A concurrent
	// voice_leave cannot remove the target from h.clients between the lookup
	// and the channel comparison, nor between the comparison and the send.
	msg := buildVoiceE2EEOffer(c.userID, p.EncryptedKey, p.IV)
	h.mu.RLock()
	target, ok := h.clients[p.TargetUserID]
	if !ok {
		h.mu.RUnlock()
		c.sendMsg(buildErrorMsg(ErrCodeBadPayload, "target user not connected"))
		return
	}
	if target.getVoiceChID() != voiceChID {
		h.mu.RUnlock()
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "target user not in your voice channel"))
		return
	}
	target.sendMsg(msg)
	h.mu.RUnlock()

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
// I-6 fix: Copy the public key value while h.mu.RLock is still held so the
// client cannot be garbage collected between the lookup and the key read.
func (h *Hub) getClientE2EEPubKey(userID int64) string {
	h.mu.RLock()
	c, ok := h.clients[userID]
	if !ok {
		h.mu.RUnlock()
		return ""
	}
	key := c.getE2EEPubKey()
	h.mu.RUnlock()
	return key
}

// GetClientE2EEPubKeyForTest is an exported wrapper for tests.
func (h *Hub) GetClientE2EEPubKeyForTest(userID int64) string {
	return h.getClientE2EEPubKey(userID)
}
