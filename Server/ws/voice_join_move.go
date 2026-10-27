package ws

import (
	"context"
	"log/slog"
	"time"
)

// voiceMovedReason is the voice_disconnected reason the device that lost the
// call is shown.
const voiceMovedReason = "Call moved to another device"

// voiceJoinMoveCall is voiceJoinLeaveCurrent's step for a voice_join from a
// connection that holds no call while another connection of the same user
// does (or that user's call is parked in the reconnect grace window): an
// account has one call, and a join on a second device takes it over. It ends
// the other membership the way an ordinary channel switch does (the
// voice_states row, key-holder re-election, LiveKit removal by the old join
// token, the voice_leave broadcast), after telling the old device with a
// targeted voice_disconnected. That frame is queued BEFORE anything the join
// produces, so the old device clears its local call before it sees a
// voice_state naming its own user.
//
// A move into the channel the old device is in announces no voice_leave: the
// user stays in the room, and a self voice_leave would tear down the new join
// on the connection that sent it.
//
// moved is false when the user has no call elsewhere (the caller continues as
// a plain first join). When moved is true, ok=false means the join must not
// proceed (the error frame has been sent) and the three flag results are the
// moderator mute/deafen to re-apply to the new row. The caller holds txn.
func (h *Hub) voiceJoinMoveCall(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (moved, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool) {
	var from *Client
	for _, o := range h.clientsOf(c.userID) {
		if o != c && o.voice.channel() != 0 {
			from = o
			break
		}
	}
	if from == nil && h.voiceReg.voiceGrace.get(c.userID) == nil {
		return false, false, false, nil, true
	}

	// A moderator-imposed mute/deafen follows the user to the new device, as it
	// follows a channel switch: read it off the row about to be deleted, or off
	// the old connection's stash when the row is already gone.
	prev, prevErr := h.voice.State(fctx, c.userID)
	if commandDeadlineExceeded(fctx, prevErr) {
		voiceJoinFail(fctx, c, reqID, prevErr, ErrCodeInternal, "voice channel switch failed — please try again")
		return true, false, false, nil, false
	}
	if prevErr == nil && prev != nil {
		wasServerMuted, wasServerDeafened, wasServerMutedBy = prev.ServerMuted, prev.ServerDeafened, prev.ServerMutedBy
	}
	if from != nil {
		if sm, sd, sby := h.takeUserModFlags(from); (sm || sd) && !wasServerMuted && !wasServerDeafened {
			wasServerMuted, wasServerDeafened, wasServerMutedBy = sm, sd, sby
		}
		snap := txn.clear(from)
		if snap.chID != 0 {
			slog.Info("voice call moved to another device", "user_id", c.userID,
				"from_channel_id", snap.chID, "to_channel_id", channelID)
			from.sendMsg(buildVoiceDisconnected(snap.chID, voiceMovedReason))
			h.finishVoiceLeaveAnnounce(ctx, txn, from, snap.chID, snap.joinToken, voiceLeaveReasonMoved, snap.chID != channelID)
		}
	} else if e := txn.takeParked(0); e != nil {
		slog.Info("voice parked call moved to another device", "user_id", c.userID,
			"from_channel_id", e.snap.chID, "to_channel_id", channelID)
		// The parking device's socket is gone, so it cannot be told now: leave
		// a note it collects when it next registers (registerNow).
		// Never for the joining connection's own session: re-joining its own
		// parked call is not a move.
		if e.client.tokenHash != c.tokenHash {
			h.voiceReg.voiceGrace.markMoved(c.userID, e.client.tokenHash, e.snap.chID)
		}
		h.finishVoiceLeaveAnnounce(ctx, txn, e.client, e.snap.chID, e.snap.joinToken, voiceLeaveReasonMoved, e.snap.chID != channelID)
	}

	// Same check as a channel switch (BUG-088): the old row must really be gone
	// before the new one is inserted.
	vs, err := h.voice.State(fctx, c.userID)
	if err != nil {
		slog.Warn("handleVoiceJoin: could not verify voice state cleared after move",
			"user_id", c.userID, "err", err)
		voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "voice channel switch failed — please try again")
		return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, false
	}
	if vs != nil {
		slog.Warn("handleVoiceJoin: stale voice state persists after move, aborting join",
			"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
		return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, false
	}
	return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, true
}

// takeUserModFlags takes and clears the pending moderator mute/deafen stash of
// every connection of c's user and returns the one c carries, else the first
// other connection's that holds one. The caller holds the user's membership
// lock, so no stash is set or consumed meanwhile: a moderator move that evicted
// the call from device A leaves its flags on A, and they must follow the user
// to whichever device joins next.
func (h *Hub) takeUserModFlags(c *Client) (serverMuted, serverDeafened bool, serverMutedBy *int64) {
	serverMuted, serverDeafened, serverMutedBy = c.voice.takeModFlags()
	for _, o := range h.clientsOf(c.userID) {
		if o == c {
			continue
		}
		sm, sd, sby := o.voice.takeModFlags()
		if !serverMuted && !serverDeafened && (sm || sd) {
			serverMuted, serverDeafened, serverMutedBy = sm, sd, sby
		}
	}
	return serverMuted, serverDeafened, serverMutedBy
}

// voiceExitWindow is how recent a voice leave must be for SendToVoiceDevice to
// treat its connection as the one a moderator frame belongs to.
const voiceExitWindow = 30 * time.Second

// noteModeratorExit records that a leave through DisconnectFromVoice,
// DisconnectFromVoiceInChannel or EvictForModeratorMove just took userID's call
// off c (these also serve the DM leave, block and group-removal paths, which
// send no moderator frame, so a stamp there is never read), so the moderator frame that follows (SendToVoiceDevice) reaches c and no
// other device. Only moderator paths stamp: a move to another device or an
// ordinary leave must not make a device the target of a later moderator frame.
// c == nil is a parked call being torn down: nobody holds it, so every stamp
// is cleared and the frame goes nowhere (the "reconnecting" answer).
func (h *Hub) noteModeratorExit(userID int64, c *Client) {
	for _, o := range h.clientsOf(userID) {
		if o != c {
			o.voiceExitAt.Store(0)
		}
	}
	if c != nil {
		c.voiceExitAt.Store(time.Now().UnixNano())
	}
}

// SendToVoiceDevice delivers msg to the connection of userID that holds their
// call or just lost it to a moderator (Client.voiceExitAt), and to no other device: a
// voice_moved frame makes its receiver join the destination, which on the
// user's other devices would steal the call. It reports false when no
// connection qualifies (the call was parked, or nothing left it), the signal
// the moderator handlers read as "the user was reconnecting".
func (h *Hub) SendToVoiceDevice(userID int64, msg []byte) bool {
	var target *Client
	var latest int64
	for _, c := range h.clientsOf(userID) {
		if at := c.voiceExitAt.Load(); at > latest {
			target, latest = c, at
		}
	}
	if target != nil && time.Since(time.Unix(0, latest)) > voiceExitWindow {
		target = nil
	}
	if target == nil {
		target = h.voiceClient(userID)
	}
	if target == nil {
		return false
	}
	return target.trySendMsg(msg)
}
