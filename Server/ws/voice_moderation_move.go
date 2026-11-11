package ws

// voice_moderation_move.go — a moderator move evicts and stashes in
// one membership transaction.

import (
	"context"
	"log/slog"
)

// voiceMoveEvictor is the move's single route to the hub: evict the target
// from the channel the moderator authorized against and stash the moderator
// flags inside one membership transaction (Hub.EvictForModeratorMove), so no
// channel switch of the target's own can land between the stash and the
// eviction. A Mod without it (only ever a hand-built test double) falls back
// to evictForMove's stash-then-disconnect pair.
type voiceMoveEvictor interface {
	EvictForModeratorMove(ctx context.Context, userID, channelID int64) bool
}

// The production moderator must keep satisfying it: a type assertion that
// silently stops matching would fall back to the unlocked stash this
// extension exists to avoid, with nothing failing to say so.
var _ voiceMoveEvictor = (*Hub)(nil)

// evictForMove evicts targetID from channelID for a moderator move, carrying
// the target's moderator flags to their own re-join, and reports false when
// nobody was evicted (no connection on this node, or the target left the
// checked channel). On false no stash is left behind. The flags handed in are
// the ones the moderator's check read; the hub does not use them, it reads the
// row again at the eviction, and only the fallback below stashes them.
func evictForMove(ctx context.Context, mod VoiceModerator, targetID, channelID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	if m, ok := mod.(voiceMoveEvictor); ok {
		return m.EvictForModeratorMove(ctx, targetID, channelID)
	}
	stashPendingModFlags(mod, targetID, serverMuted, serverDeafened, serverMutedBy)
	if disconnectFromVoiceIn(ctx, mod, targetID, channelID) {
		return true
	}
	clearPendingModFlags(mod, targetID)
	return false
}

// EvictForModeratorMove is DisconnectFromVoiceInChannel for a moderator move:
// when the target is still in channelID, it evicts them and stashes the
// moderator-imposed mute/deafen on their connection, both under one hold of
// the member lock. The eviction deletes the row those flags normally live in,
// and the target's own re-join (voiceJoinLeaveCurrent) takes them from the
// stash. Stashing before the lock was a window in which a switch of the
// target's own could consume the stash, or the move's check could fail after
// it had been set. Under the lock the stash exists exactly when the eviction
// happened.
//
// The flags are read from the row here, under the moderation lock every mute
// and unmute writes under, and that lock is held until the row is deleted. A
// mute or unmute by another moderator therefore lands either before the read
// (and is carried) or after the delete (and is told the member has left), never
// in between where it would be lost with the row.
//
// It reports false, with nothing stashed, when the target has no
// connection on this node or has left channelID. A target whose connection is
// parked in the grace window has no live connection to hold the stash, so the
// move is kept for the parking session instead (parkedModMove): its resume
// collects the flags and the voice_moved frame and re-joins the destination.
func (h *Hub) EvictForModeratorMove(ctx context.Context, userID, channelID int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	unlockMod := h.voiceHub.mod.Lock(userID)
	defer unlockMod()
	flags := h.modFlagsInChannel(ctx, userID, channelID)
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		e := txn.takeParked(channelID)
		if !h.leaveParkedVoice(ctx, txn, e, voiceLeaveReasonModerator) {
			return false
		}
		h.voiceHub.reg.voiceGrace.noteParkedModMove(userID, e.client.tokenHash, flags)
		return true
	}
	evicted := h.evictAndStash(ctx, txn, c, channelID, flags, voiceLeaveReasonModerator)
	if evicted {
		h.noteModeratorExit(userID, c)
	}
	return evicted
}

// modFlagsInChannel reads the moderator mute/deafen on userID's row when that
// row is in channelID, and no flags otherwise or when the read fails. The
// caller holds the user's moderation lock, so the answer stays true until it
// releases it.
func (h *Hub) modFlagsInChannel(ctx context.Context, userID, channelID int64) modFlagStash {
	if h.voice == nil {
		return modFlagStash{}
	}
	state, err := h.voice.State(ctx, userID)
	if err != nil {
		slog.Warn("voice move: could not read the moderator flags to carry", "user_id", userID, "channel_id", channelID, "err", err)
		return modFlagStash{}
	}
	if state == nil || state.ChannelID != channelID {
		return modFlagStash{}
	}
	return modFlagStash{muted: state.ServerMuted, deafened: state.ServerDeafened, mutedBy: state.ServerMutedBy}
}

// modFlagStash is the moderator mute/deafen an eviction carries to the
// member's own re-join.
type modFlagStash struct {
	muted, deafened bool
	mutedBy         *int64
}

// evictAndStash is the body shared by the moderator move and the AFK move:
// when c is still in channelID it clears the slot, stashes flags on c if any
// is set and runs the voice-leave routine with reason. The caller holds txn
// (c's membership lock), so the stash exists exactly when the eviction
// happened. It reports false, with nothing stashed, when c has left channelID.
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
