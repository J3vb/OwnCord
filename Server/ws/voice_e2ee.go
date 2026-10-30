package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// Voice E2EE rate limits. Announce and offer relays fan out to every other voice
// participant (an offer can force a peer's key rotation or disconnect), so one user
// must not be able to spam them.
const (
	voiceE2EERateLimit = 5
	voiceE2EEWindow    = time.Second
	// voiceE2EEOfferRateLimit budgets a whole key rotation, a burst of one offer per
	// peer on join/leave and the periodic re-key, so it is sized well above any
	// realistic voice channel rather than at voiceE2EERateLimit (announces send one
	// frame per rotation).
	voiceE2EEOfferRateLimit = 64
)

// validateBase64Loose accepts padded (StdEncoding) or unpadded (RawStdEncoding)
// standard-alphabet base64: WebCrypto ECDH public keys omit '=' padding. URL-safe
// base64 is not accepted.
func validateBase64Loose(s string) error {
	if _, err := base64.StdEncoding.DecodeString(s); err == nil {
		return nil
	}
	_, err := base64.RawStdEncoding.DecodeString(s)
	return err
}

// updateKeyHolder records the connected client with the lowest userID in channelID
// as key holder, deleting the entry if none remain. Must NOT be called while h.mu
// or h.keyHolderMu is held. Lock order: keyHolderMu (write) then h.mu (read);
// holding keyHolderMu across the scan and write stops two concurrent calls
// overwriting each other with a stale result.
func (h *Hub) updateKeyHolder(channelID int64) {
	h.keyHolderMu.Lock()
	defer h.keyHolderMu.Unlock()

	h.mu.RLock()
	var minUserID int64
	found := false
	for _, c := range h.allClientsLocked() {
		if c.voice.channel() == channelID {
			if !found || c.userID < minUserID {
				minUserID = c.userID
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

// IsVoiceKeyHolder reports whether userID is the current key holder for channelID
// (KeyHolderChecker). From a V2 handler there is a TOCTOU window between this
// check and delivery in EmitEvents; see handleVoiceE2EEOfferV2.
func (h *Hub) IsVoiceKeyHolder(channelID, userID int64) bool {
	h.keyHolderMu.RLock()
	kh, ok := h.voiceKeyHolders[channelID]
	h.keyHolderMu.RUnlock()
	return ok && kh == userID
}

// computeIsKeyHolder reports whether userID will become key holder on joining
// channelID (no connected client there has a lower userID). Used before setState so
// the result can go in the joiner's voice_token.
func (h *Hub) computeIsKeyHolder(channelID, userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.allClientsLocked() {
		if c.voice.channel() == channelID && c.userID < userID {
			return false
		}
	}
	return true
}

// handleVoiceE2EEAnnounceV2 handles voice_e2ee_announce: it validates the public key
// and returns SetE2EEAnnounce plus a VoiceE2EEAnnounceEvent relaying to peers.
func handleVoiceE2EEAnnounceV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	announceCmd := cmd.(VoiceE2EEAnnounceCmd)
	userID := info.UserID
	voiceChID := info.VoiceChannelID

	ratKey := auth.Key("voice_e2ee_announce", userID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceE2EERateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee announcements"}}
	}

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	pubKey := announceCmd.PublicKey
	if pubKey == "" {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key is required"}}
	}
	if len(pubKey) > 128 {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key too large"}}
	}
	if err := validateBase64Loose(pubKey); err != nil {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "public_key is not valid base64"}}
	}

	// The signature is optional (legacy clients omit it; the receiving client enforces
	// the fail-closed posture). When present it is validated and carried verbatim: the
	// server relays, never verifies.
	sig := announceCmd.Signature
	if sig != "" {
		if len(sig) > 128 {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature too large"}}
		}
		if err := validateBase64Loose(sig); err != nil {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature is not valid base64"}}
		}
	}

	// video_decode is optional and never fatal: a malformed list is dropped and the
	// key still accepted. A device key named by the announce itself wins: unlike the
	// auth frame it can be sent on the first connection of an app start, before the
	// user id scoping the key is known. Otherwise the auth-frame key is used.
	identityKey := announceCmd.IdentityKey
	if identityKey == "" {
		identityKey = info.IdentityKey
	}
	announce := e2eeAnnounce{key: pubKey, sig: sig, videoDecode: sanitizeVideoDecode(announceCmd.VideoDecode), identityKey: identityKey}
	msg := buildVoiceE2EEAnnounce(userID, announce)
	return Result{
		SetE2EEAnnounce: &announce,
		Events: []Event{VoiceE2EEAnnounceEvent{
			voiceChannelID: voiceChID,
			excludeUserID:  userID,
			payload:        msg,
		}},
	}
}

// announceIdentityKey returns the device identity key a voice_e2ee_announce carried,
// or "" if none or invalid. An invalid key is logged and ignored, never an error:
// it must not cost the announce, and the auth-frame key is used instead.
func announceIdentityKey(userID int64, raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var key string
	if err := json.Unmarshal(raw, &key); err != nil {
		slog.Info("ws voice_e2ee_announce: identity_public_key ignored, not a string", "user_id", userID)
		return ""
	}
	key = strings.TrimSpace(key)
	if err := service.ValidateIdentityKey(key); err != nil {
		slog.Info("ws voice_e2ee_announce: identity_public_key ignored, invalid", "user_id", userID, "err", err)
		return ""
	}
	return key
}

const (
	maxVideoDecodeEntries = 8
	maxVideoDecodeNameLen = 16
)

// sanitizeVideoDecode validates the announced video decode list: at most
// maxVideoDecodeEntries entries of 1..maxVideoDecodeNameLen characters of
// [a-z0-9]. Any violation returns nil (the field is dropped, the announce kept).
// The result never aliases the input.
func sanitizeVideoDecode(in []string) []string {
	if len(in) == 0 || len(in) > maxVideoDecodeEntries {
		return nil
	}
	out := make([]string, len(in))
	for i, name := range in {
		if name == "" || len(name) > maxVideoDecodeNameLen {
			return nil
		}
		for j := 0; j < len(name); j++ {
			ch := name[j]
			if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') {
				return nil
			}
		}
		out[i] = name
	}
	return out
}

// handleVoiceE2EEOfferV2 handles voice_e2ee_offer: it validates the payload and key
// holder status, then returns a VoiceE2EEOfferGuardedEvent for atomic
// check-and-send delivery.
//
// Known race: the key holder map can change (the real holder leaves) between the
// IsVoiceKeyHolder check and delivery in EmitEvents. Accepted: the guarded event
// checks under h.mu.RLock that the target is still in the channel at delivery, and
// the worst case is a stale "not key holder" rejection the client retries.
// TODO: re-check key-holder status inside sendToUserIfInVoiceChannel under the
// same lock to close the window.
func handleVoiceE2EEOfferV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	offerCmd := cmd.(VoiceE2EEOfferCmd)
	voiceChID := info.VoiceChannelID

	if voiceChID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}

	targetUserID := offerCmd.TargetUserID
	encKey := offerCmd.EncryptedKey
	iv := offerCmd.IV

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

	// Rate limit last, and let no unvalidated client input allocate limiter state.
	// RateLimiter.Allow inserts a live map entry per distinct key, reaped ~20 minutes
	// later, and the key used to interpolate the attacker-controlled target_user_id
	// before any check; one authenticated socket not in voice or not a key holder could
	// spray unbounded entries until the server ran out of memory. The outer budget is
	// keyed on (sender, voice channel), server-held state only, and sized for a whole
	// rotation; passing it is the precondition for any per-target entry, so growth is
	// bounded by real permission-checked joins.
	ratKey := auth.Key(auth.Key("voice_e2ee_offer", info.UserID), voiceChID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceE2EEOfferRateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee offers"}}
	}
	// The inner budget keeps the per-victim cap: an offer can force the target to
	// re-key or disconnect, so repeated offers at one peer stay capped even though a
	// full rotation across many peers passes.
	targetKey := auth.Key(ratKey, targetUserID)
	if d.Limiter != nil && !d.Limiter.Allow(targetKey, voiceE2EERateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee offers"}}
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

// sendToUserIfInVoiceChannel atomically verifies targetUserID is in the voice
// channel and sends, all under one h.mu.RLock, preventing a TOCTOU where the target
// leaves between check and send. Used by VoiceChannelGuardedEvent (voice_e2ee_offer).
func (h *Hub) sendToUserIfInVoiceChannel(voiceChannelID, targetUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	targets := h.clients[targetUserID]
	if len(targets) == 0 {
		// An undeliverable key offer can leave the peer unable to decrypt. Log (IDs only,
		// never the encrypted key) so the failure is diagnosable.
		slog.Debug("e2ee: key offer dropped, target not connected",
			"target_user_id", targetUserID, "voice_channel_id", voiceChannelID)
		return
	}
	// The offer is for the device holding the call; the user's other connections have
	// no slot in it and never see the wrapped key.
	delivered := false
	for _, target := range targets {
		if target.voice.channel() == voiceChannelID {
			target.sendMsg(msg)
			delivered = true
		}
	}
	if !delivered {
		slog.Debug("e2ee: key offer dropped, target not in expected voice channel",
			"target_user_id", targetUserID, "voice_channel_id", voiceChannelID)
	}
}

// sendToVoiceChannelExcept sends to all clients in the voice channel except
// excludeUserID, through the voice pub/sub topic (joined at voice_join, dropped at
// leave/disconnect) rather than scanning clients under h.mu:
// publishWithPriority snapshots subscribers and sends outside the lock, costing
// O(participants) and never nesting h.mu with a client's mutex. Key-offer delivery
// keeps the stricter sendToUserIfInVoiceChannel path.
func (h *Hub) sendToVoiceChannelExcept(channelID int64, excludeUserID int64, msg []byte) {
	h.pubsub.Publish(VoiceTopic(channelID), msg, excludeUserID)
}

// getClientE2EEAnnounce returns the stored announce for a connected user; zero if none.
func (h *Hub) getClientE2EEAnnounce(userID int64) e2eeAnnounce {
	// The announce lives on the connection holding the call.
	c := h.voiceClient(userID)
	if c == nil {
		return e2eeAnnounce{}
	}
	return c.getE2EEAnnounce()
}

// GetClientE2EEPubKeyForTest is an exported test wrapper.
func (h *Hub) GetClientE2EEPubKeyForTest(userID int64) string {
	return h.getClientE2EEAnnounce(userID).key
}

// voiceChannelPeerUserIDs returns the user IDs of every connected client in
// channelID except excludeUserID. Takes h.mu.RLock itself; callers must not hold h.mu.
func (h *Hub) voiceChannelPeerUserIDs(channelID, excludeUserID int64) []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var ids []int64
	for uid, conns := range h.clients {
		if uid == excludeUserID {
			continue
		}
		for _, c := range conns {
			if c.voice.channel() == channelID {
				ids = append(ids, uid)
				break
			}
		}
	}
	return ids
}

// sendVoicePeerKeys sends c the stored ECDH public key (and identity signature)
// for every other client in channelID. It is the server's only re-sync path for a
// client's peer-key map, shared by a brand-new voice_join and a WS reconnect
// (registerNow). voice_e2ee_announce is an unsequenced pub/sub frame: never given a
// seq, pushed to h.replayBuf or persisted, so neither replay tier can redeliver one
// sent while a socket was down. Without this a resumed client would permanently
// lose every peer key or mid-call rotation announced meanwhile, its E2EE map
// desynced from its (replayed) voice roster.
func (h *Hub) sendVoicePeerKeys(c *Client, channelID int64) {
	for _, uid := range h.voiceChannelPeerUserIDs(channelID, c.userID) {
		if a := h.getClientE2EEAnnounce(uid); a.key != "" {
			c.sendMsg(buildVoiceE2EEAnnounce(uid, a))
		}
	}
}
