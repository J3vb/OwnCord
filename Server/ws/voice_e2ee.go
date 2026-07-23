package ws

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"
)

// Voice E2EE rate limits. Both the announce and offer relays fan out to every
// other voice participant (and an offer can force a key rotation / disconnect
// for peers), so a single user must not be able to spam them. Mirrors the
// named-constant Limiter idiom used by the voice control handlers.
const (
	voiceE2EERateLimit = 5
	voiceE2EEWindow    = time.Second
)

// validateBase64Loose checks that s is valid padded (StdEncoding) or unpadded
// (RawStdEncoding) standard-alphabet base64. ECDH public keys exported from
// WebCrypto omit '=' padding; we accept both forms to avoid breaking existing
// clients.
// Note: URL-safe base64 (alphabet '-_') is not accepted; clients must use the
// standard alphabet ('+/').
func validateBase64Loose(s string) error {
	if _, err := base64.StdEncoding.DecodeString(s); err == nil {
		return nil
	}
	_, err := base64.RawStdEncoding.DecodeString(s)
	return err
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

// IsVoiceKeyHolder reports whether userID is the current key holder for channelID.
// Satisfies the KeyHolderChecker interface.
//
// NOTE: When called from a V2 handler (via deps), there is a TOCTOU window
// between this check and the subsequent event delivery in EmitEvents. See the
// comment on handleVoiceE2EEOfferV2 for details.
func (h *Hub) IsVoiceKeyHolder(channelID, userID int64) bool {
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

// handleVoiceE2EEAnnounceV2 is the V2 (pure) handler for voice_e2ee_announce.
// It validates the public key and returns a SetE2EEPubKey mutation plus a
// VoiceE2EEAnnounceEvent for relay to other voice channel participants.
func handleVoiceE2EEAnnounceV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	announceCmd := cmd.(VoiceE2EEAnnounceCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := fmt.Sprintf("voice_e2ee_announce:%d", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceE2EERateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee announcements"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	pubKey := announceCmd.PublicKey()
	if pubKey == "" {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key is required"}}
	}
	if len(pubKey) > 128 {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key too large"}}
	}
	if err := validateBase64Loose(pubKey); err != nil {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key is not valid base64"}}
	}

	// signature (F3 TOFU) is optional — legacy clients omit it and the
	// receiving client enforces the fail-closed posture. When present it is
	// validated and carried verbatim: the server relays, never verifies.
	sig := announceCmd.Signature()
	if sig != "" {
		if len(sig) > 128 {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature too large"}}
		}
		if err := validateBase64Loose(sig); err != nil {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature is not valid base64"}}
		}
	}

	msg := buildVoiceE2EEAnnounce(userID, pubKey, sig)
	result := Result{
		SetE2EEPubKey: &pubKey,
		Events: []Event{VoiceE2EEAnnounceEvent{
			voiceChannelID: voiceChID,
			excludeUserID:  userID,
			payload:        msg,
		}},
	}
	if sig != "" {
		result.SetE2EESignature = &sig
	}
	return result
}

// handleVoiceE2EEOfferV2 is the V2 (pure) handler for voice_e2ee_offer.
// It validates the payload and key holder status, then returns a
// VoiceE2EEOfferGuardedEvent for atomic check-and-send delivery.
//
// KNOWN RACE: There is a window between the IsVoiceKeyHolder check below
// and the sendToUserIfInVoiceChannel delivery in EmitEvents where the key
// holder map can change (e.g. the real key holder leaves voice). This is
// accepted because VoiceChannelGuardedEvent uses atomic check-and-send
// under h.mu.RLock, guaranteeing the target is still in the voice channel
// at delivery time. The worst case is a stale "not key holder" rejection
// that the client retries.
// TODO: consider re-checking key-holder status inside sendToUserIfInVoiceChannel
// under the same h.mu.RLock to close the TOCTOU window completely.
func handleVoiceE2EEOfferV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	offerCmd := cmd.(VoiceE2EEOfferCmd)
	voiceChID := info.VoiceChannelID

	// A legitimate rotation is a burst of one offer per peer (fired on
	// join/leave and the periodic re-key), so the budget must not depend on
	// channel size — keyed per sender alone, the 6th+ peer's offer was
	// silently rate-limited and that peer could never decrypt audio again.
	// Keying per (sender, target) admits any single rotation regardless of
	// participant count while still capping repeated offers at one victim —
	// the abuse this limit exists for, since an offer can force the target to
	// re-key or disconnect. Cross-target spray stays bounded per victim and
	// requires holding key-holder status in that channel.
	ratKey := fmt.Sprintf("voice_e2ee_offer:%d:%d", info.UserID, offerCmd.TargetUserID())
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceE2EERateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee offers"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	targetUserID := offerCmd.TargetUserID()
	encKey := offerCmd.EncryptedKey()
	iv := offerCmd.IV()

	if targetUserID <= 0 || encKey == "" || iv == "" {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "target_user_id, encrypted_key, and iv are required"}}
	}
	if len(encKey) > 1024 || len(iv) > 128 {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "encrypted_key or iv too large"}}
	}
	if err := validateBase64Loose(encKey); err != nil {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "encrypted_key is not valid base64"}}
	}
	if err := validateBase64Loose(iv); err != nil {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "iv is not valid base64"}}
	}

	if d.KeyHolder == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "key holder checker not configured"}}
	}
	if !d.KeyHolder.IsVoiceKeyHolder(voiceChID, info.UserID) {
		return Result{Error: ClientError{Code: ErrCodeNotKeyHolder, Message: "only the key holder may send key offers"}}
	}

	msg := buildVoiceE2EEOffer(info.UserID, encKey, iv)
	return Result{
		Events: []Event{VoiceE2EEOfferGuardedEvent{
			voiceChannelID: voiceChID,
			targetUserID:   targetUserID,
			payload:        msg,
		}},
	}
}

// sendToUserIfInVoiceChannel atomically verifies that targetUserID is in the
// given voice channel and sends the message — all under a single h.mu.RLock.
// This prevents TOCTOU races where the target leaves voice between the check
// and the send. Used by VoiceChannelGuardedEvent (voice_e2ee_offer).
func (h *Hub) sendToUserIfInVoiceChannel(voiceChannelID, targetUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	target, ok := h.clients[targetUserID]
	if !ok {
		return // target not connected — silently drop
	}
	if target.getVoiceChID() != voiceChannelID {
		return // target not in expected voice channel — silently drop
	}
	target.sendMsg(msg)
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

// getClientE2EEPubKey returns the stored ECDH public key and its identity
// signature ("" for legacy announces) for a connected user.
// I-6 fix: Copy the values while h.mu.RLock is still held so the client
// cannot be garbage collected between the lookup and the key read.
func (h *Hub) getClientE2EEPubKey(userID int64) (string, string) {
	h.mu.RLock()
	c, ok := h.clients[userID]
	if !ok {
		h.mu.RUnlock()
		return "", ""
	}
	key, sig := c.getE2EEPubKey()
	h.mu.RUnlock()
	return key, sig
}

// GetClientE2EEPubKeyForTest is an exported wrapper for tests.
func (h *Hub) GetClientE2EEPubKeyForTest(userID int64) string {
	key, _ := h.getClientE2EEPubKey(userID)
	return key
}
