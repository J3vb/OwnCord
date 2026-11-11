package ws

import (
	"context"
	"log/slog"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// Register queues a client for registration. Test-only: runs registerNow without the member lock
// production callers hold.
func (h *Hub) Register(c *Client) {
	h.clientEvents <- clientEvent{c: c, add: true}
}

// Unregister queues a client for removal from the hub.
func (h *Hub) Unregister(c *Client) {
	h.clientEvents <- clientEvent{c: c}
}

// registerNow adds c to the hub and subscribes it to its topics. readableChannelIDs (from the
// handshake) gates only the inherited voice-channel subscription; nil denies it.
// A new connection replaces only an existing one of the same session (this device's reload,
// reconnect or wake). Other devices stay, up to maxConnectionsPerUser, past which the oldest other
// session is evicted with SESSION_REPLACED.
// Replacing strips the old subscriptions (UnsubscribeAll) and re-subscribes (Subscribe) in two
// separate PubSub-lock acquisitions, not atomically. A caller that must not lose a racing broadcast
// has to hold h.seqMu, which deliverBroadcast holds for its whole critical section; handleReconnect
// does. txn is the caller's Hub.begin handle (the test-only Register path passes Hub.heldTxn).
func (h *Hub) registerNow(c *Client, readableChannelIDs map[int64]bool, txn *voiceTxn) {
	var replacedVoiceChID int64

	// Assume c holds the full member_timeouts list until told otherwise: a replaying resume keeps
	// its last list and a fresh connect lowers it in commitReadyTimeouts. A wrong true costs one
	// own-only frame; a wrong false would leave a demoted user the full list.
	c.timeouts.full.Store(true)

	h.mu.Lock()
	// Replace only a connection of the same session; another session is a different device. An
	// empty token hash (bare test clients) is one session.
	old := h.sessionClientLocked(c.userID, c.tokenHash)
	var evicted *Client
	if old != nil {
		// The whole voice slot moves in one step (voiceTxn.transfer): a moderator's pending
		// mute/deafen always, the membership only for a network reconnect (lastSeq > 0) whose
		// replaced connection had a completed join. Fresh connections do not take it: stale voice
		// cleanup belongs to the handshake in serve.go, before registerNow.
		replacedVoiceChID = txn.transfer(old, c, c.lastSeq > 0)
		if c.lastSeq > 0 {
			// The focused channel must transfer too: a client never re-sends channel_focus on
			// resume, so the re-subscribe below would be a no-op and the stream would die silently.
			// READ-gated; nil denies.
			if oldChID := old.getChannelID(); oldChID != 0 &&
				c.getChannelID() == 0 && readableChannelIDs[oldChID] {
				c.mu.Lock()
				c.channelID = oldChID
				c.mu.Unlock()
			}
		}

		// Kick the stale connection atomically before registering the new one (no TOCTOU on
		// duplicate login). closeSend must precede UnsubscribeAll: Subscribe refuses clients whose
		// send is closed, so in-flight handlers of the old connection cannot re-take a stripped
		// topic.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		// Name the reason first: writePumpDrainAndClose delivers queued frames before the close, so
		// the displaced device learns it was replaced and does not reconnect to kick back.
		old.displaced.Store(true)
		old.sendMsg(buildErrorMsg(ErrCodeSessionReplaced, "signed in on another device"))
		old.closeSend()

		h.pubsub.UnsubscribeAll(old)
		h.removeClientLocked(old)
	} else if list := h.clients[c.userID]; len(list) >= maxConnectionsPerUser {
		// Cap: evict the oldest connection (all belong to other sessions) through SESSION_REPLACED,
		// as a terminal kick so its call ends at once rather than parking. Prefer the oldest not
		// holding the account's call (the cap must not end a call); if all hold it, the oldest.
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

	// Subscribe immediately after UnsubscribeAll(old). This does not make strip+resubscribe atomic:
	// they are separate ps.mu acquisitions and PublishGlobal takes ps.mu alone, so a
	// deliverBroadcast landing between finds no subscriber, and that frame is unrecoverable (seq
	// already allocated, replay snapshot older, client tracks only max(seq)). Only a caller holding
	// h.seqMu closes the window.
	// The order still minimizes the gap for callers that cannot hold seqMu (fresh connect rebuilds
	// from the DB; the clientEvents path runs on the hub goroutine). The log and updateKeyHolder
	// run after the subscribes. Subscribing under h.mu is harmless: pubsub never calls back into
	// the hub, so h.mu -> ps.mu adds no ordering risk.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// Subscribe immediately if a channel is already focused (test clients, reconnects).
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// Restore a voice client's subscriptions without a new voice_join (a same-channel rejoin is
	// rejected with ALREADY_JOINED) or channel_focus.
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		// VoiceTopic carries only voice_e2ee_announce relays for a channel already joined through
		// the voice_join gate, so no READ gate.
		h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		// Voice membership can outlive READ_MESSAGES (mid-call revocation, closed DM), so it must
		// not by itself grant the message stream: subscribe only when the handshake confirmed
		// READ_MESSAGES.
		if readableChannelIDs[voiceChID] {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
		}
	}
	total := h.connectionCountLocked()
	h.mu.Unlock()

	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", total)

	// A call this session parked and another device then moved away: tell it first, before any
	// other voice frame, so it clears its local call. Only a resume can hold the call locally.
	if ch := h.voiceHub.reg.voiceGrace.takeMoved(c.userID, c.tokenHash); ch != 0 && c.lastSeq > 0 {
		c.sendMsg(buildVoiceDisconnected(ch, voiceMovedReason))
	}
	// A moderator moved this session's parked call: carry the mute and deliver voice_moved so the
	// client re-joins the destination.
	h.collectParkedModMove(c)

	// A fresh connect drops the replaced connection's voice state without transferring it, so the
	// E2EE key holder may need to move. handleVoiceLeave never runs here (readPump skips it when
	// replaced), so re-elect, outside h.mu (updateKeyHolder takes keyHolderMu then h.mu.RLock). The
	// recompute reads live state, so it is idempotent.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}
	// Elections held while the membership was parked could not see it, so a grace inherit re-elects
	// too.
	if inheritedVoiceChID != 0 {
		h.updateKeyHolder(inheritedVoiceChID)
	}
	// A membership a resume took over may name a join that never reached the SFU (the client gave
	// up while offline): check it shortly.
	h.noteResumedVoice(c)

	// Re-sync this connection's E2EE peer-key map. voice_e2ee_announce is unsequenced pub/sub, so
	// neither replay tier can redeliver a peer's key or a mid-call rotation announced while this
	// socket was down, and voiceJoinComplete's relay runs only on a brand-new join. No-op when c is
	// not in voice.
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		h.sendVoicePeerKeys(c, voiceChID)
		// Same for who-watches-what (voice_watching, unsequenced). No self re-relay: the resumed
		// client re-sends its own set.
		h.sendVoicePeerWatching(c, voiceChID)
		// Re-relay this client's own stored key onto VoiceTopic. voice_e2ee_offer is targeted and
		// unsequenced, so one dropped while this socket was down has no replay and a rotation
		// during the outage would strand the client on a dead key. A peer announcing an already-
		// known key makes the client re-wrap and re-offer, so re-announcing ours makes the key
		// holder re-offer.
		if a := c.getE2EEAnnounce(); a.key != "" {
			h.sendToVoiceChannelExcept(voiceChID, c.userID, buildVoiceE2EEAnnounce(c.userID, a))
		}
	}
}

// postRegisterSessionRecheck re-validates c's session right after registerNow makes c reachable via
// h.clients. A session revoked while the handshake's earlier DB work was in flight is invisible to
// DisconnectRevokedUser (which inspects h.clients at one instant), so without this the handshake
// would yield an authorized socket on a deleted session until the next sweep (up to 60s).
// Running AFTER registerNow closes the race: a revocation visible to the read is handled here, and
// a later one finds c in h.clients. The ban is re-checked the same way. On a live session it slides
// the expiry (touchSession).
// Any verdict other than postRegisterOK means the caller must abort instead of sending
// auth_ok/ready: c is torn back out of the hub (as in unregisterFailedHandshake), so nothing is
// disclosed. It skips when c has no token and fails open on a transient DB error, like
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
	h.touchSession(ctx, c)
	return postRegisterOK
}

type postRegisterVerdict int

const (
	postRegisterOK postRegisterVerdict = iota
	postRegisterRevoked
	postRegisterBanned
)

// closeAbortedHandshake closes conn after an aborted handshake; a banned user gets the same BANNED
// frame authenticateConn sends, so the client shows the ban instead of retrying.
func closeAbortedHandshake(ctx context.Context, conn *websocket.Conn, v postRegisterVerdict) {
	if v == postRegisterBanned {
		_ = handshakeWrite(ctx, conn, buildErrorMsg(ErrCodeBanned, "you are banned"))
		_ = conn.Close(websocket.StatusPolicyViolation, "banned")
		return
	}
	_ = conn.Close(websocket.StatusPolicyViolation, "session revoked")
}

// unregisterNow removes c. True means c was already replaced by a newer connection of its own
// session, so teardown must not touch the live connection's call or presence. False is a real
// disconnect (including a kicked or evicted connection): voice cleanup runs and shouldMarkOffline
// decides the offline stamp.
func (h *Hub) unregisterNow(c *Client) bool {
	h.mu.Lock()
	if h.removeClientLocked(c) {
		slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", h.connectionCountLocked())
		h.mu.Unlock()
		// Close before stripping, as kickClient and registerNow's replace do:
		// Subscribe refuses a closed client, so a handler still running for c (a
		// deferred channel_focus) cannot re-take a topic nothing would strip again.
		c.closeSend()
		h.pubsub.UnsubscribeAll(c)
		return false // not replaced
	}
	h.mu.Unlock()
	// Residual: a non-terminal kick removes c, then a same-session resume registers before c's read
	// loop reaches teardown. The resume inherits nothing and c, not displaced, is torn down here:
	// its call parks in the grace window and ends when it expires.
	return c.displaced.Load()
}

// shouldMarkOffline reports whether a disconnect should StampDisconnect and broadcast offline for
// c's user. replaced (sampled at the start of teardown) is necessary but not sufficient:
// handleVoiceLeave can block and a reconnect landing meanwhile is invisible to it. Re-checking
// h.clients at decision time closes that: any entry left once c is removed is a newer connection.
func (h *Hub) shouldMarkOffline(c *Client, replaced bool) bool {
	if replaced {
		return false
	}
	// Decide and claim under one h.mu hold: two last connections tearing down together would
	// otherwise both stamp and broadcast offline. registerNow clears the claim so a later reconnect
	// can go offline again.
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

type clientEvent struct {
	c   *Client
	add bool
}

// DisconnectUser forcibly disconnects every connection of userID. Like DisconnectRevokedUser it
// misses a handshake that has not reached registerNow; postRegisterSessionRecheck's ban check
// closes that window.
func (h *Hub) DisconnectUser(userID int64) {
	conns := h.clientsOf(userID)
	if len(conns) > 0 {
		slog.Info("hub: disconnecting user", "user_id", userID, "connections", len(conns))
	}
	for _, c := range conns {
		c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
		h.kickClientTerminal(c)
	}
	// A call a dropped device parked in the grace window has no connection to kick and survives
	// while another device is connected; it ends with the ban.
	h.leaveParkedVoiceLocked(userID, voiceLeaveReasonDisconnect)
}

// DisconnectRevokedUser drops every connection of a user whose sessions were just revoked. No frame
// precedes the close, as in the revoked-session sweep, so the client's reconnect meets the 401
// telling it to sign in again. A handshake still in flight is caught by postRegisterSessionRecheck.
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

func (h *Hub) onClientEvent(ev clientEvent) {
	if !ev.add {
		h.unregisterNow(ev.c)
		return
	}
	// No handshake permission set here (and no DB call on the hub goroutine), so nil denies the
	// inherited voice-channel subscription. The dispatch goroutine never takes the voice member
	// lock, so it passes a lock-free handle.
	h.registerNow(ev.c, nil, h.heldTxn(ev.c.userID))
}
