package ws

import (
	"context"
	"log/slog"
	"time"
)

const voiceMovedReason = "Call moved to another device"

// voiceJoinMoveCall is voiceJoinLeaveCurrent's step for a voice_join from a connection that
// holds no call while another connection of the same user does (or that call is parked in
// the grace window): an account has one call, and a join on a second device takes it over.
// It ends the other membership as a channel switch does (row, key-holder re-election,
// LiveKit removal by the old join token, voice_leave broadcast), after telling the old
// device with a targeted voice_disconnected, queued BEFORE anything the join produces so
// the old device clears its local call before it sees a voice_state naming its own user. A
// move into the channel the old device is in announces no voice_leave: it would tear down
// the new join on the connection that sent it; that channel is returned as unannounced, so
// the caller can announce the leave if the join then fails (announceUnconfirmedMoveLeave)
// and insert without the capacity check: the user already held that slot. moved is false
// when there is no call elsewhere. When moved is true, ok=false means the join must not
// proceed (error sent) and the flag results are the moderator mute/deafen to re-apply to
// the new row. The caller holds txn.
func (h *Hub) voiceJoinMoveCall(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, reqID string) (moved, wasServerMuted, wasServerDeafened bool, wasServerMutedBy *int64, ok bool, unannounced int64) {
	var from *Client
	for _, o := range h.clientsOf(c.userID) {
		if o != c && o.voice.channel() != 0 {
			from = o
			break
		}
	}
	if from == nil && h.voiceHub.reg.voiceGrace.get(c.userID) == nil {
		return false, false, false, nil, true, 0
	}

	flags, unannounced, left := h.leaveForCallMove(fctx, ctx, txn, c, from, channelID, reqID)
	if !left {
		return true, false, false, nil, false, 0
	}
	wasServerMuted, wasServerDeafened, wasServerMutedBy = flags.muted, flags.deafened, flags.mutedBy

	// Same check as a channel switch: the old row must be gone before the new one is inserted.
	vs, err := h.voice.State(fctx, c.userID)
	if err != nil {
		slog.Warn("handleVoiceJoin: could not verify voice state cleared after move",
			"user_id", c.userID, "err", err)
		voiceJoinFail(fctx, c, reqID, err, ErrCodeInternal, "voice channel switch failed — please try again")
		return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, false, unannounced
	}
	if vs != nil {
		slog.Warn("handleVoiceJoin: stale voice state persists after move, aborting join",
			"user_id", c.userID, "stale_channel", vs.ChannelID, "target_channel", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeInternal, "voice channel switch failed — please try again", reqID))
		return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, false, unannounced
	}
	return true, wasServerMuted, wasServerDeafened, wasServerMutedBy, true, unannounced
}

// leaveForCallMove reads the moderator mute/deafen the old call carries and ends that call
// (from's, or the parked session's when from is nil), both under the moderation lock, as
// leaveForSwitch does. left is false when the read failed: nothing was torn down.
func (h *Hub) leaveForCallMove(fctx, ctx context.Context, txn *voiceTxn, c, from *Client, channelID int64, reqID string) (flags modFlagStash, unannounced int64, left bool) {
	unlockMod := h.voiceHub.mod.Lock(c.userID)
	defer unlockMod()
	// From the row about to be deleted, or the old connection's stash when it is gone.
	prev, prevErr := h.voice.State(fctx, c.userID)
	if prevErr != nil {
		slog.Warn("voice call move: could not read the moderator flags, move refused", "user_id", c.userID, "err", prevErr)
		voiceJoinFail(fctx, c, reqID, prevErr, ErrCodeInternal, "voice channel switch failed — please try again")
		return modFlagStash{}, 0, false
	}
	if prev != nil {
		flags = modFlagStash{muted: prev.ServerMuted, deafened: prev.ServerDeafened, mutedBy: prev.ServerMutedBy}
	}
	if from != nil {
		if sm, sd, sby := h.takeUserModFlags(from); (sm || sd) && !flags.muted && !flags.deafened {
			flags = modFlagStash{muted: sm, deafened: sd, mutedBy: sby}
		}
		snap := txn.clear(from)
		if snap.chID != 0 {
			slog.Info("voice call moved to another device", "user_id", c.userID,
				"from_channel_id", snap.chID, "to_channel_id", channelID)
			from.sendMsg(buildVoiceDisconnected(snap.chID, voiceMovedReason))
			h.finishVoiceLeaveAnnounce(ctx, txn, from, snap.chID, snap.joinToken, voiceLeaveReasonMoved, snap.chID != channelID)
			if snap.chID == channelID {
				unannounced = snap.chID
			}
		}
		return flags, unannounced, true
	}
	e := txn.takeParked(0)
	if e == nil {
		return flags, 0, true
	}
	slog.Info("voice parked call moved to another device", "user_id", c.userID,
		"from_channel_id", e.snap.chID, "to_channel_id", channelID)
	// The parking device's socket is gone, so leave a note it collects at registerNow. Never
	// for the joining connection's own session: re-joining its own parked call is not a move.
	if e.client.tokenHash != c.tokenHash {
		h.voiceHub.reg.voiceGrace.markMoved(c.userID, e.client.tokenHash, e.snap.chID)
	}
	h.finishVoiceLeaveAnnounce(ctx, txn, e.client, e.snap.chID, e.snap.joinToken, voiceLeaveReasonMoved, e.snap.chID != channelID)
	if e.snap.chID == channelID {
		unannounced = e.snap.chID
	}
	return flags, unannounced, true
}

// announceUnconfirmedMoveLeave sends the voice_leave a same-channel move left out, for a
// join that then failed: no membership is left, so every roster drops the user. 0 is a no-op.
func (h *Hub) announceUnconfirmedMoveLeave(ctx context.Context, c *Client, channelID int64) {
	if channelID == 0 {
		return
	}
	h.broadcastVoiceEventWithLeaver(ctx, channelID, buildVoiceLeave(channelID, c.userID), c.userID)
}

// takeUserModFlags takes and clears the moderator mute/deafen stash of every connection of
// c's user and returns the one c carries, else the first other's. The caller holds the
// membership lock, so none is set or consumed meanwhile: a moderator move that evicted the
// call from device A leaves its flags on A, and they must follow the user to whichever
// device joins next. It also ends a moderator move kept for a parked session
// (endParkedModMove): the user is joining now, so a later resume must not pull the call
// away, and the kept flags apply to this join when no connection carries any.
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
	if kept := h.voiceHub.reg.voiceGrace.endParkedModMove(c.userID); !serverMuted && !serverDeafened && (kept.muted || kept.deafened) {
		serverMuted, serverDeafened, serverMutedBy = kept.muted, kept.deafened, kept.mutedBy
	}
	return serverMuted, serverDeafened, serverMutedBy
}

// voiceExitWindow is how recent a voice leave must be for SendToVoiceDevice to treat its connection as the
// moderator frame's target.
const voiceExitWindow = 30 * time.Second

// noteModeratorExit records that a leave through DisconnectFromVoice,
// DisconnectFromVoiceInChannel or EvictForModeratorMove just took userID's call off c, so
// the following moderator frame (SendToVoiceDevice) reaches c and no other device. The DM
// leave, block and group-removal paths also use these functions but send no moderator
// frame, so their stamp is never read. Only moderator paths stamp. c == nil is a parked
// call being torn down: every stamp is cleared and the frame goes nowhere ("reconnecting"),
// unless the move of a parked call keeps it for the resume (noteParkedModMove). Any
// moderator exit supersedes an earlier parked move.
func (h *Hub) noteModeratorExit(userID int64, c *Client) {
	h.voiceHub.reg.voiceGrace.dropParkedModMove(userID)
	for _, o := range h.clientsOf(userID) {
		if o != c {
			o.voiceExitAt.Store(0)
		}
	}
	if c != nil {
		c.voiceExitAt.Store(time.Now().UnixNano())
	}
}

// SendToVoiceDevice delivers msg to the connection of userID that holds their call or just
// lost it to a moderator (Client.voiceExitAt), and no other device: a voice_moved frame
// makes its receiver join the destination, which would steal the call on other devices. A
// moderator move that evicted a parked call keeps msg for that session's resume
// (queueParkedModMoveFrame) and reports true. False when no connection qualifies, which
// moderator handlers read as "the user was reconnecting".
func (h *Hub) SendToVoiceDevice(userID int64, msg []byte) bool {
	if h.voiceHub.reg.voiceGrace.queueParkedModMoveFrame(userID, msg) {
		return true
	}
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
