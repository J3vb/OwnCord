package ws

import (
	"context"
	"log/slog"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// Register queues a client for registration with the hub. Test-only: it runs
// registerNow without the member lock, which production callers hold.
func (h *Hub) Register(c *Client) {
	h.clientEvents <- clientEvent{c: c, add: true}
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(c *Client) {
	h.clientEvents <- clientEvent{c: c}
}

// registerNow adds c to the hub and subscribes it to its topics.
//
// readableChannelIDs is the set of channels the user holds READ_MESSAGES on, as
// computed by the handshake (serve.go). It gates only the inherited voice-channel
// subscription; nil denies it (fail closed).
//
// A new connection replaces only an existing connection of the same session
// (token hash): this device's reload, reconnect or wake. Other devices stay
// registered, up to maxConnectionsPerUser, past which the oldest connection of
// another session is evicted with SESSION_REPLACED.
//
// Replacing strips the old subscriptions (UnsubscribeAll) and re-subscribes the new
// one (Subscribe) as two separate PubSub-lock acquisitions, not atomically. A
// caller that must not lose a broadcast racing the replacement has to call this
// holding h.seqMu, which deliverBroadcast holds for its whole critical section
// (seq allocation, replay-buffer push, publish); handleReconnect (replay.go) does
// exactly that. txn is the caller's Hub.begin(c.userID) handle; the one exception
// is the test-only Register event path on the hub goroutine, which passes Hub.heldTxn.
func (h *Hub) registerNow(c *Client, readableChannelIDs map[int64]bool, txn *voiceTxn) {
	// Voice channel the replaced connection was in; re-elected after the hub lock is released.
	var replacedVoiceChID int64

	// Assume c holds the full member_timeouts list until told otherwise: a replaying
	// resume keeps its last connection's list (the old *Client is usually gone) and
	// a fresh connect lowers this in commitReadyTimeouts. A wrong true costs one
	// own-only frame on the next role refresh; a wrong false would leave a demoted
	// user the full list.
	c.timeouts.full.Store(true)

	h.mu.Lock()
	// Replace only a connection of the same session (this device's reload, reconnect
	// or wake); another session is a different device. An empty token hash (bare
	// test clients) is one session.
	old := h.sessionClientLocked(c.userID, c.tokenHash)
	var evicted *Client
	if old != nil {
		// The whole voice slot moves in one step (voiceTxn.transfer): a moderator's
		// pending mute/deafen always, the membership only for a network reconnect
		// (lastSeq > 0) whose replaced connection had a completed join (see transfer).
		// Fresh connections do not take the membership: stale voice cleanup is owned by
		// the handshake path in serve.go, which runs before registerNow.
		replacedVoiceChID = txn.transfer(old, c, c.lastSeq > 0)
		if c.lastSeq > 0 {
			// The focused channel must transfer too: the client never re-sends
			// channel_focus on a resume, so the ChannelTopic re-subscribe below would be a
			// no-op and the message stream would die silently. READ-gated; nil denies.
			if oldChID := old.getChannelID(); oldChID != 0 &&
				c.getChannelID() == 0 && readableChannelIDs[oldChID] {
				c.mu.Lock()
				c.channelID = oldChID
				c.mu.Unlock()
			}
		}

		// Kick the stale connection atomically before registering the new one
		// (prevents TOCTOU races on duplicate login). closeSend must precede
		// UnsubscribeAll: Subscribe refuses clients whose send is closed, so in-flight
		// handlers of the old connection cannot re-take a stripped topic.
		// in-flight handlers no window to re-take a stripped topic.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		// Name the reason first: writePumpDrainAndClose delivers queued frames before
		// the close, so the displaced device learns it was replaced and does not
		// reconnect to kick back.
		old.displaced.Store(true)
		old.sendMsg(buildErrorMsg(ErrCodeSessionReplaced, "signed in on another device"))
		old.closeSend()

		h.pubsub.UnsubscribeAll(old)
		h.removeClientLocked(old)
	} else if list := h.clients[c.userID]; len(list) >= maxConnectionsPerUser {
		// Cap: evict the oldest connection (all remaining belong to other sessions)
		// through the SESSION_REPLACED path, as a terminal kick so its call is torn down
		// at once rather than parked for a resume that cannot come. Prefer the oldest
		// that does not hold the account's call (at most one does): the cap must not end
		// a call. If all hold it (impossible with a cap above 1), fall back to the oldest.
		evicted = list[0]
		for _, o := range list {
			if o.voice.channel() == 0 {
				evicted = o
				break
			}
		}
		slog.Warn("hub: evicting oldest connection over the per-user cap",
			"user_id", c.userID, "cap", maxConnectionsPerUser)
		evicted.markTerminalKick()
		evicted.sendMsg(buildErrorMsg(ErrCodeSessionReplaced, "signed in on another device"))
		evicted.closeSend()
		h.pubsub.UnsubscribeAll(evicted)
		h.removeClientLocked(evicted)
	}
	h.addClientLocked(c)
	delete(h.offlineClaimed, c.userID)

	inheritedVoiceChID := txn.inherit(c)

	// Subscribe immediately after UnsubscribeAll(old), nothing in between. This does
	// not make strip+resubscribe atomic: they are separate ps.mu acquisitions and
	// PublishGlobal takes ps.mu alone (never h.mu), so a deliverBroadcast landing
	// between them finds no subscriber. That frame is unrecoverable (its seq is
	// already allocated and pushed, the replay snapshot is older, and the client
	// tracks only max(seq)). Only a caller holding h.seqMu closes the window.
	//
	// The ordering still minimizes the gap for callers that cannot hold seqMu: the
	// fresh-connect path (buildReady rebuilds from the DB) and the clientEvents path
	// (hub goroutine, cannot race deliverBroadcast). The log line and updateKeyHolder
	// (keyHolderMu plus an h.clients scan) therefore run after the subscribes.
	// Subscribing under h.mu is harmless: pubsub has its own lock and never calls back
	// into the hub, so h.mu -> ps.mu adds no ordering risk.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// Subscribe immediately if a channel is already focused (test clients, reconnects)
	// so deliverBroadcast reaches it without waiting for channel_focus.
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// Restore a voice client's subscriptions without a new voice_join (a same-channel
	// rejoin is rejected with ALREADY_JOINED) or channel_focus.
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		// VoiceTopic carries only voice_e2ee_announce relays for a channel already
		// joined through the voice_join gate, so no separate READ gate.
		h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		// Voice membership can outlive READ_MESSAGES (mid-call revocation, closed DM), so
		// it must not by itself grant the message stream: subscribe only when the
		// handshake confirmed READ_MESSAGES.
		if readableChannelIDs[voiceChID] {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
		}
	}
	total := h.connectionCountLocked()
	h.mu.Unlock()

	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", total)

	// A call this session parked and another device then moved away: tell it first,
	// before any other voice frame, so it clears its local call. Only a resume can
	// hold the call locally; a fresh connect just drops the note.
	if ch := h.voiceReg.voiceGrace.takeMoved(c.userID, c.tokenHash); ch != 0 && c.lastSeq > 0 {
		c.sendMsg(buildVoiceDisconnected(ch, voiceMovedReason))
	}

	// A fresh connect drops the replaced connection's voice state without
	// transferring it, so that channel lost a participant and the E2EE key holder may
	// need to move. handleVoiceLeave never runs here (readPump skips it when replaced
	// and it early-returns on cleared state), so re-elect. Must be outside h.mu:
	// updateKeyHolder takes keyHolderMu then h.mu.RLock. The recompute reads live
	// state, so it is idempotent and correct when state was transferred.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}
	// Elections held while the membership was parked could not see it, so a grace
	// inherit re-elects the same way.
	if inheritedVoiceChID != 0 {
		h.updateKeyHolder(inheritedVoiceChID)
	}

	// Re-sync this connection's E2EE peer-key map. voice_e2ee_announce is an
	// unsequenced pub/sub frame (bypassing deliverBroadcast and the replay buffer), so
	// on a network reconnect neither replay tier can redeliver a peer's key or a
	// mid-call rotation announced while this socket was down. voiceJoinComplete's
	// relay runs only on a brand-new join, so without this call the peer-key map
	// would permanently desync from the replayed roster. c.voice.channel() reflects
	// the transfer above; a no-op when c is not in a voice channel.
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		h.sendVoicePeerKeys(c, voiceChID)
		// Same for who-watches-what (voice_watching, also unsequenced). No self re-relay:
		// the resumed client re-sends its own set.
		h.sendVoicePeerWatching(c, voiceChID)
		// Re-relay this client's own stored key onto VoiceTopic. voice_e2ee_offer is a
		// targeted, unsequenced send silently dropped if this socket was down, and has no
		// replay recovery either, so a key rotation during the outage would strand this
		// client on a dead key until the next periodic rotation. The client's
		// duplicate-announce handling re-wraps and re-offers the current room key
		// whenever a peer announces a key it already knows, so re-announcing our
		// unchanged key makes the key holder re-offer.
		if a := c.getE2EEAnnounce(); a.key != "" {
			h.sendToVoiceChannelExcept(voiceChID, c.userID, buildVoiceE2EEAnnounce(c.userID, a))
		}
	}
}

// postRegisterSessionRecheck re-validates c's session token right after
// registerNow makes c reachable via h.clients. A session revoked (sign-out
// everywhere, revoke-all, account recovery) while the handshake's earlier DB work
// was in flight is invisible to DisconnectRevokedUser, which inspects h.clients at
// one instant. Without this re-check the handshake would yield a live authorized
// socket on a deleted session until sweepRevokedSessions' next tick (up to 60s)
// or the client's 10th inbound frame (handleMessageSessionRecheck).
//
// Running AFTER registerNow closes the race rather than shrinking it: a revocation
// visible to the read below is handled here, and one that commits later does so
// after registerNow, so its DisconnectRevokedUser finds c in h.clients. The ban is
// re-checked the same way (the earlier check in refreshUserSnapshot precedes
// registerNow). On a live session it also slides the expiry (touchSession).
//
// A verdict other than postRegisterOK means the caller must abort instead of
// sending auth_ok/ready: c has been torn back out of the hub (as in
// unregisterFailedHandshake) so nothing is disclosed. It skips when c has no token
// (never true for a real client) and fails open on a transient DB error, matching
// handleMessageSessionRecheck and sweepRevokedSessions.
func (h *Hub) postRegisterSessionRecheck(ctx context.Context, c *Client) postRegisterVerdict {
	if c.tokenHash == "" {
		return postRegisterOK
	}
	result, err := h.readers.Dispatch.GetSessionWithBanStatus(ctx, c.tokenHash)
	if err != nil {
		slog.Warn("ws post-register session recheck: lookup failed, skipping", "user_id", c.userID, "err", err)
		return postRegisterOK
	}
	if result == nil || auth.IsSessionExpired(result.ExpiresAt) {
		slog.Info("ws post-register session recheck: session revoked during handshake, aborting", "user_id", c.userID)
		c.markTerminalKick()
		h.unregisterFailedHandshake(ctx, c)
		return postRegisterRevoked
	}
	if sessionUserBanned(result.Banned, result.BanExpires) {
		slog.Info("ws post-register session recheck: user banned during handshake, aborting", "user_id", c.userID)
		c.markTerminalKick()
		h.unregisterFailedHandshake(ctx, c)
		return postRegisterBanned
	}
	// The session just proved live on a registered socket: slide its expiry.
	h.touchSession(ctx, c)
	return postRegisterOK
}

// postRegisterVerdict is postRegisterSessionRecheck's answer: continue the
// handshake, or abort it because the session or the user is no longer valid.
type postRegisterVerdict int

const (
	postRegisterOK postRegisterVerdict = iota
	postRegisterRevoked
	postRegisterBanned
)

// closeAbortedHandshake closes conn after postRegisterSessionRecheck aborted
// the handshake. A banned user gets the same BANNED frame authenticateConn
// sends, so the client shows the ban instead of retrying.
func closeAbortedHandshake(ctx context.Context, conn *websocket.Conn, v postRegisterVerdict) {
	if v == postRegisterBanned {
		_ = handshakeWrite(ctx, conn, buildErrorMsg(ErrCodeBanned, "you are banned"))
		_ = conn.Close(websocket.StatusPolicyViolation, "banned")
		return
	}
	_ = conn.Close(websocket.StatusPolicyViolation, "session revoked")
}

// unregisterNow removes c from the hub. True means c was already replaced by a
// newer connection of its own session (registerNow took its slot and voice
// state), so the teardown must not touch the live connection's call or presence.
// False is a real disconnect, including a kicked or evicted connection: voice
// cleanup runs and shouldMarkOffline decides the offline stamp.
func (h *Hub) unregisterNow(c *Client) bool {
	h.mu.Lock()
	if h.removeClientLocked(c) {
		slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", h.connectionCountLocked())
		h.mu.Unlock()
		h.pubsub.UnsubscribeAll(c)
		return false // not replaced
	}
	h.mu.Unlock()
	// Residual: a non-terminal kick removes c, then a same-session resume registers
	// before c's read loop reaches this teardown. The resume finds no parked entry
	// (inherits nothing) and c, not displaced, is torn down here: its call parks in
	// the grace window and ends when the 15 s window expires.
	return c.displaced.Load()
}

// shouldMarkOffline reports whether a disconnect teardown should StampDisconnect
// and broadcast offline for c's user.
//
// replaced (unregisterNow's return, sampled at the start of teardown) is
// necessary but not sufficient: it is sampled before handleVoiceLeave, which can
// block, and a reconnect landing meanwhile is invisible to it, so the dead
// connection would mark the live session offline. Re-checking h.clients at
// decision time closes that gap: any entry left once c is removed is a newer
// connection, since unregisterNow only deletes c's own slot.
func (h *Hub) shouldMarkOffline(c *Client, replaced bool) bool {
	if replaced {
		return false
	}
	// Decide and claim under one h.mu hold: two last connections tearing down together
	// would otherwise both stamp and broadcast offline. registerNow clears the claim so
	// a reconnect after the offline broadcast can go offline again.
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients[c.userID]) > 0 {
		return false
	}
	if _, claimed := h.offlineClaimed[c.userID]; claimed {
		return false
	}
	if h.offlineClaimed == nil {
		h.offlineClaimed = map[int64]struct{}{}
	}
	h.offlineClaimed[c.userID] = struct{}{}
	return true
}

// clientEvent is a register (add=true) or unregister (add=false) request.
// Both kinds share one channel so per-connection ordering is preserved.
type clientEvent struct {
	c   *Client
	add bool
}

// DisconnectUser forcibly disconnects every connection of userID. No-op if not
// connected. Like DisconnectRevokedUser it misses a handshake that has not reached
// registerNow; postRegisterSessionRecheck's ban check closes that window.
func (h *Hub) DisconnectUser(userID int64) {
	conns := h.clientsOf(userID)
	if len(conns) > 0 {
		slog.Info("hub: disconnecting user", "user_id", userID, "connections", len(conns))
	}
	for _, c := range conns {
		c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
		h.kickClientTerminal(c)
	}
	// A call a dropped device parked in the grace window has no connection to kick
	// and survives while another device is connected; it ends with the ban.
	h.leaveParkedVoiceLocked(userID, voiceLeaveReasonDisconnect)
}

// DisconnectRevokedUser drops every live connection of a user whose sessions were
// just revoked (sign-out-everywhere). No frame precedes the close, as in the
// revoked-session sweep, so the client's reconnect meets the 401 telling it to
// sign in again. No-op if not connected. It inspects h.clients at one instant, so
// a handshake still in flight is closed on the other side by
// postRegisterSessionRecheck.
func (h *Hub) DisconnectRevokedUser(userID int64) {
	conns := h.clientsOf(userID)
	if len(conns) > 0 {
		slog.Info("hub: disconnecting user after sign-out-everywhere", "user_id", userID, "connections", len(conns))
	}
	for _, c := range conns {
		h.kickClientTerminal(c)
	}
	// Every session is revoked, so a call parked by a dropped device ends too.
	h.leaveParkedVoiceLocked(userID, voiceLeaveReasonDisconnect)
}

// onClientEvent applies a queued Register or Unregister on the dispatch goroutine.
func (h *Hub) onClientEvent(ev clientEvent) {
	if !ev.add {
		h.unregisterNow(ev.c)
		return
	}
	// No handshake permission set here (and no DB call on the hub goroutine), so nil
	// denies the inherited voice-channel subscription. The dispatch goroutine never
	// takes the voice member lock (voice_registry.go), so it passes a lock-free
	// handle; nothing else runs a voice path for a client that is only now registering.
	h.registerNow(ev.c, nil, h.heldTxn(ev.c.userID))
}
