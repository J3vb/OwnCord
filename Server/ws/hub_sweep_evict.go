package ws

import (
	"context"
	"log/slog"

	"time"
)

// sweepStaleVoiceEvictRevoked is sweepStaleVoiceStates' permission stage: it
// re-runs the voice stay gate (permissions.CanStayInVoice: the join gate
// minus the timeout) for every client currently in voice, evicts the ones it now refuses, and reconciles active
// media source permissions and flags.
func (h *Hub) sweepStaleVoiceEvictRevoked(ctx context.Context) {
	// The whole SFU reconciliation pass shares a budget. An unavailable
	// companion cannot hold the hub loop for one network timeout per user.
	mediaCtx, cancelMedia := context.WithTimeout(ctx, 5*time.Second)
	defer cancelMedia()
	// Revocation must evict a live session, not merely block the next join.
	// Nothing else in ws re-validates voice permissions for a connection that
	// stays open, so a user stripped of CONNECT_VOICE kept their SFU session
	// until they disconnected. Checked once a minute, and only for the handful
	// of clients actually in voice.
	h.mu.RLock()
	inVoice := make([]*Client, 0, len(h.clients))
	for _, c := range h.allClientsLocked() {
		if c.voice.channel() != 0 {
			inVoice = append(inVoice, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range inVoice {
		if ctx.Err() != nil {
			return
		}
		chID := c.voice.channel()
		if chID == 0 {
			continue
		}
		allowed, err := h.voiceStillAllowed(ctx, c.userID, chID)
		if err != nil {
			// A transient read failure (I/O error, lock contention, a
			// maintenance window) is not a revocation — hasChannelAccess and
			// permissions.Checker.HasChannelPerm both collapse any DB error
			// to "denied", which would otherwise evict every in-voice
			// participant on one bad read. Skip this client this tick; the
			// next tick retries. Mirrors sweepRevokedSessions' guard on its
			// own batch lookup below.
			slog.Warn("sweepStaleVoiceStates: permission check failed, skipping this tick",
				"user_id", c.userID, "channel_id", chID, "err", err)
			continue
		}
		if allowed {
			h.clearRevokedVoiceMedia(ctx, c, chID)
			if h.livekit != nil && mediaCtx.Err() == nil {
				curChID, joinToken := c.voice.state()
				if curChID == chID && joinToken != "" {
					if syncErr := h.trySyncVoiceParticipantPermissions(mediaCtx, c.userID, chID, joinToken); syncErr != nil && !liveKitParticipantMissing(syncErr) {
						slog.Warn("voice permission reconciliation deferred", "user_id", c.userID, "channel_id", chID, "err", syncErr)
					}
				}
			}
			continue
		}
		// The permission check is a DB round-trip; a voice_join to a
		// still-permitted channel may have committed while it ran. The
		// eviction is conditional on the client still being in the checked
		// channel — never on whatever channel it is in by now.
		// The tail budget starts once the lock is held, so a wait behind
		// another membership change cannot spend it.
		txn := h.begin(c.userID)
		tailCtx, cancelTail := h.sweepTailCtx(ctx)
		evicted := h.handleVoiceLeaveIfStillIn(tailCtx, txn, c, chID, voiceLeaveReasonRevoked)
		txn.end()
		cancelTail()
		if !evicted {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: evicted participant who may no longer join the channel",
			"user_id", c.userID, "channel_id", chID)
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing permission to join this voice channel"))
	}
}
