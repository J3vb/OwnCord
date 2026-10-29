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

// Voice E2EE rate limits. Both the announce and offer relays fan out to every
// other voice participant (and an offer can force a key rotation / disconnect
// for peers), so a single user must not be able to spam them. Mirrors the
// named-constant Limiter idiom used by the voice control handlers.
const (
	voiceE2EERateLimit = 5
	voiceE2EEWindow    = time.Second
	// voiceE2EEOfferRateLimit budgets a whole key rotation, which is a burst of
	// one offer per peer fired on join/leave and on the periodic re-key. It is
	// therefore sized well above any realistic voice channel rather than at
	// voiceE2EERateLimit, which suits announces (one frame per rotation).
	voiceE2EEOfferRateLimit = 64
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
// lower userID. This is used before calling setState so the result can be
// included in the voice_token message sent to the joiner.
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

// handleVoiceE2EEAnnounceV2 is the V2 (pure) handler for voice_e2ee_announce.
// It validates the public key and returns a SetE2EEAnnounce mutation plus a
// VoiceE2EEAnnounceEvent for relay to other voice channel participants.
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

	// signature (F3 TOFU) is optional — legacy clients omit it and the
	// receiving client enforces the fail-closed posture. When present it is
	// validated and carried verbatim: the server relays, never verifies.
	sig := announceCmd.Signature
	if sig != "" {
		if len(sig) > 128 {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature too large"}}
		}
		if err := validateBase64Loose(sig); err != nil {
			return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "signature is not valid base64"}}
		}
	}

	// video_decode is optional and never fatal: a malformed list is
	// dropped and the announce (the key) is still accepted.
	// The device key the announce itself names wins: unlike the auth frame it
	// can be sent on the first connection of an app start, when the user id that
	// scopes the key was not yet known. Without one (older client, or an invalid
	// value the parser dropped) the connection's auth-frame key is used.
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

// announceIdentityKey returns the device identity key a voice_e2ee_announce
// payload carried, or "" when it carried none or an invalid one. An invalid key
// is logged and ignored, never an error: it must not cost the announce (the
// ephemeral key), and the connection's auth-frame key is used instead.
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
// maxVideoDecodeEntries entries, each 1..maxVideoDecodeNameLen characters of
// [a-z0-9]. On any violation it returns nil (the whole field is dropped; the
// announce itself is kept). Values are otherwise opaque. The result is a copy
// and never aliases the input.
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

	// Rate limit last, and let no unvalidated client input allocate limiter
	// state. RateLimiter.Allow inserts a live map entry per distinct key, reaped
	// only ~20 minutes later, and the key used to interpolate target_user_id —
	// attacker-controlled JSON — before any check ran. One authenticated socket
	// that was neither in voice nor a key holder could therefore spray unbounded
	// entries into the process-wide limiter until the server ran out of memory.
	//
	// The outer budget is keyed on (sender, voice channel), server-held state
	// only, and sized for a whole rotation. Passing it is now the precondition
	// for creating any per-target entry, so limiter growth is bounded by real,
	// permission-checked voice joins rather than by attacker-chosen integers.
	ratKey := auth.Key(auth.Key("voice_e2ee_offer", info.UserID), voiceChID)
	if d.Limiter != nil && !d.Limiter.Allow(ratKey, voiceE2EEOfferRateLimit, voiceE2EEWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many e2ee offers"}}
	}
	// Inner budget keeps the per-victim cap: an offer can force the target
	// to re-key or disconnect, so repeated offers at one peer stay capped even
	// though a full rotation across many peers passes.
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

// sendToUserIfInVoiceChannel atomically verifies that targetUserID is in the
// given voice channel and sends the message — all under a single h.mu.RLock.
// This prevents TOCTOU races where the target leaves voice between the check
// and the send. Used by VoiceChannelGuardedEvent (voice_e2ee_offer).
func (h *Hub) sendToUserIfInVoiceChannel(voiceChannelID, targetUserID int64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	targets := h.clients[targetUserID]
	if len(targets) == 0 {
		// Undeliverable key offer can leave the peer unable to decrypt — the
		// payload is dropped, but log (IDs only, never the encrypted key) so
		// the failure is diagnosable rather than silent.
		slog.Debug("e2ee: key offer dropped, target not connected",
			"target_user_id", targetUserID, "voice_channel_id", voiceChannelID)
		return
	}
	// The offer is for the device that holds the call; the user's other
	// connections have no slot in it and never see the wrapped key.
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

// sendToVoiceChannelExcept sends a message to all clients in the given voice
// channel except the one identified by excludeUserID.
//
// Delivery goes through the voice pub/sub topic (joined at voice_join,
// dropped at voice_leave/disconnect) rather than scanning every connected
// client under h.mu: publishWithPriority snapshots the subscriber set and
// sends outside the lock, so this costs O(participants) and never nests
// h.mu with each client's own mutex. Key-offer delivery keeps the stricter
// TOCTOU-guarded sendToUserIfInVoiceChannel path.
func (h *Hub) sendToVoiceChannelExcept(channelID int64, excludeUserID int64, msg []byte) {
	h.pubsub.Publish(VoiceTopic(channelID), msg, excludeUserID)
}

// getClientE2EEAnnounce returns the stored announce (ECDH public key, identity
// signature, video decode list) for a connected user; the zero value if none.
func (h *Hub) getClientE2EEAnnounce(userID int64) e2eeAnnounce {
	// The announce lives on the connection that holds the call.
	c := h.voiceClient(userID)
	if c == nil {
		return e2eeAnnounce{}
	}
	return c.getE2EEAnnounce()
}

// GetClientE2EEPubKeyForTest is an exported wrapper for tests.
func (h *Hub) GetClientE2EEPubKeyForTest(userID int64) string {
	return h.getClientE2EEAnnounce(userID).key
}

// voiceChannelPeerUserIDs returns the user IDs of every currently connected
// client in channelID, excluding excludeUserID. Callers must not already
// hold h.mu (this takes h.mu.RLock itself).
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

// sendVoicePeerKeys sends c the current stored ECDH public key (and its F3
// TOFU identity signature) for every other client currently in channelID.
//
// This is the server's only re-sync path for a client's local peer-key map,
// factored out of voiceJoinComplete's per-participant relay loop
// (voice_join.go) so both a brand-new voice_join AND a WS reconnect/resume
// can use it. voice_e2ee_announce itself is delivered as an unsequenced
// pub/sub frame (sendToVoiceChannelExcept -> h.pubsub.Publish, bypassing
// deliverBroadcast entirely) — it never gets a seq, is never pushed to
// h.replayBuf, and is never persisted, so neither reconnect replay tier
// (buffer or DB) can ever redeliver one that was queued for a socket that
// was down when it was sent. Before this existed, a client that blipped and
// resumed permanently lost every peer key (or mid-call key rotation)
// announced while its socket was down — its voice roster (voice_state,
// which IS sequenced and replayed) stayed correct while its E2EE peer-key
// map silently desynced from it. See registerNow
// (hub.go), which calls this for every WS (re)registration that leaves the
// client in a voice channel.
func (h *Hub) sendVoicePeerKeys(c *Client, channelID int64) {
	for _, uid := range h.voiceChannelPeerUserIDs(channelID, c.userID) {
		if a := h.getClientE2EEAnnounce(uid); a.key != "" {
			c.sendMsg(buildVoiceE2EEAnnounce(uid, a))
		}
	}
}
