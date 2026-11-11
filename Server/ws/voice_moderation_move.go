package ws

// voice_moderation_move.go: a moderator move evicts and stashes in one membership transaction.

import "context"

// voiceMoveEvictor is the move's single route to the hub: evict the target from the
// authorized channel and stash the moderator flags inside one membership transaction
// (Hub.EvictForModeratorMove), so no channel switch of the target's own can land between
// them. A Mod without it (a test double) falls back to evictForMove's stash-then-disconnect pair.
type voiceMoveEvictor interface {
	EvictForModeratorMove(ctx context.Context, userID, channelID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool
}

// Compile-time check: a silently non-matching assertion would fall back to the unlocked stash this exists to
// avoid.
var _ voiceMoveEvictor = (*Hub)(nil)

// evictForMove evicts targetID from channelID for a moderator move, carrying their flags to
// their own re-join; false when nobody was evicted (no connection here, or the target left
// the checked channel), leaving no stash.
func evictForMove(ctx context.Context, mod VoiceModerator, targetID, channelID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	if m, ok := mod.(voiceMoveEvictor); ok {
		return m.EvictForModeratorMove(ctx, targetID, channelID, serverMuted, serverDeafened, serverMutedBy)
	}
	stashPendingModFlags(mod, targetID, serverMuted, serverDeafened, serverMutedBy)
	if disconnectFromVoiceIn(ctx, mod, targetID, channelID) {
		return true
	}
	clearPendingModFlags(mod, targetID)
	return false
}

// EvictForModeratorMove is DisconnectFromVoiceInChannel for a moderator move: when the
// target is still in channelID it evicts them and stashes the mute/deafen on their
// connection, both under one hold of the member lock. The eviction deletes the row those
// flags live in and the target's re-join (voiceJoinLeaveCurrent) takes them from the stash.
// Stashing before the lock let the target's own switch consume the stash, or the move's
// check fail after it was set; under the lock the stash exists exactly when the eviction
// happened. False, with nothing stashed, when the target has no connection here or left
// channelID. A target parked in the grace window has no live connection, so the move is
// kept for the parking session (parkedModMove): its resume collects the flags and the
// voice_moved frame and re-joins the destination.
func (h *Hub) EvictForModeratorMove(ctx context.Context, userID, channelID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		e := txn.takeParked(channelID)
		if !h.leaveParkedVoice(ctx, txn, e, voiceLeaveReasonModerator) {
			return false
		}
		h.voiceHub.reg.voiceGrace.noteParkedModMove(userID, e.client.tokenHash,
			modFlagStash{muted: serverMuted, deafened: serverDeafened, mutedBy: serverMutedBy})
		return true
	}
	evicted := h.evictAndStash(ctx, txn, c, channelID,
		modFlagStash{muted: serverMuted, deafened: serverDeafened, mutedBy: serverMutedBy},
		voiceLeaveReasonModerator)
	if evicted {
		h.noteModeratorExit(userID, c)
	}
	return evicted
}

type modFlagStash struct {
	muted, deafened bool
	mutedBy         *int64
}

// evictAndStash is shared by the moderator move and the AFK move: when c is still in
// channelID it clears the slot, stashes flags if any, and runs the voice-leave routine with
// reason. The caller holds txn (c's membership lock), so the stash exists exactly when the
// eviction happened. False, nothing stashed, when c left channelID.
func (h *Hub) evictAndStash(ctx context.Context, txn *voiceTxn, c *Client, channelID int64, flags modFlagStash, reason string) bool {
	snap, ok := txn.clearIfChannel(c, channelID)
	if !ok {
		return false
	}
	if flags.muted || flags.deafened {
		txn.stashModFlags(c, flags.muted, flags.deafened, flags.mutedBy)
	}
	h.finishVoiceLeave(ctx, txn, c, channelID, snap.joinToken, reason)
	return true
}
