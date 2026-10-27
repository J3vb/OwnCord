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
// readableChannelIDs is the set of channels the user holds READ_MESSAGES on,
// as computed by the handshake (serve.go). It gates the inherited voice-channel
// subscription only; a nil set denies it (fail closed).
//
// A new connection replaces only an existing connection of the SAME session
// (token hash): this device's reload, network reconnect or wake. Another
// device's connection is left alone and both stay registered, up to
// maxConnectionsPerUser, past which the oldest connection of another session is
// evicted with SESSION_REPLACED.
//
// Replacing an existing connection strips its subscriptions (UnsubscribeAll)
// and re-subscribes the new one (Subscribe) as two separate PubSub-lock
// acquisitions — back to back, but not atomic. A caller that must not lose a
// broadcast concurrently racing the replacement (i.e. one deliverBroadcast
// could deliver in the gap between those two acquisitions) has to call this
// while holding h.seqMu, the same lock deliverBroadcast holds for its entire
// critical section (seq allocation, replay-buffer push, and publish) — that
// serializes the two entirely, rather than merely narrowing the window. See
// replay.go's handleReconnect, which re-reads the replay tail and calls
// registerNow inside one h.seqMu section for exactly this reason.
// txn is the caller's Hub.begin(c.userID) handle. The one exception is the
// test-only Register event path on the hub goroutine, which passes Hub.heldTxn.
func (h *Hub) registerNow(c *Client, readableChannelIDs map[int64]bool, txn *voiceTxn) {
	// Voice channel the replaced connection was in, if any. Re-elected below,
	// after the hub lock is released.
	var replacedVoiceChID int64

	// Until told otherwise, assume c holds the full member_timeouts list: a
	// replaying resume keeps whatever list its last connection held (its old
	// *Client is usually gone by now), and a fresh connect lowers this in
	// commitReadyTimeouts. A wrong true costs one own-only frame on the next
	// role refresh; a wrong false would leave a demoted user the full list.
	c.timeouts.full.Store(true)

	h.mu.Lock()
	// A new connection replaces only a connection of the SAME session (this
	// device's F5, network reconnect or wake); another session is a different
	// device and is left alone. An empty token hash (bare test clients) is one
	// session, as before.
	old := h.sessionClientLocked(c.userID, c.tokenHash)
	var evicted *Client
	if old != nil {
		// The whole voice slot moves in one step (voiceTxn.transfer): a
		// moderator's pending mute/deafen always (OC-0302), the membership
		// only for a network reconnect (lastSeq > 0) whose replaced
		// connection had a COMPLETED join (OC-0270); see transfer for why an
		// incomplete one is left behind. Fresh connections (lastSeq == 0) do
		// NOT take the membership: stale voice cleanup (DB + broadcast +
		// LiveKit) is owned entirely by the handshake path in serve.go, which
		// runs before registerNow. registerNow only handles in-memory client
		// replacement.
		replacedVoiceChID = txn.transfer(old, c, c.lastSeq > 0)
		if c.lastSeq > 0 {
			// The focused channel must transfer too: the client never
			// re-sends channel_focus on a resume (mountChannel early-returns
			// on the same channel), so without it the ChannelTopic
			// re-subscribe below is a no-op and the message stream dies
			// silently. READ-gated like every ChannelTopic subscription;
			// a nil set denies (fail closed).
			if oldChID := old.getChannelID(); oldChID != 0 &&
				c.getChannelID() == 0 && readableChannelIDs[oldChID] {
				c.mu.Lock()
				c.channelID = oldChID
				c.mu.Unlock()
			}
		}

		// Kick the stale connection atomically before registering
		// the new one — prevents TOCTOU races on duplicate login.
		// closeSend MUST precede UnsubscribeAll: Subscribe refuses clients
		// whose send is closed, so this ordering leaves the old connection's
		// in-flight handlers no window to re-take a stripped topic.
		slog.Warn("hub: kicking stale connection for re-registering user",
			"user_id", c.userID, "last_seq", c.lastSeq)
		// Name the reason first: writePumpDrainAndClose delivers queued
		// frames before the close, so the displaced device learns it was
		// replaced rather than dropped, and does not reconnect to kick back.
		old.displaced.Store(true)
		old.sendMsg(buildErrorMsg(ErrCodeSessionReplaced, "signed in on another device"))
		old.closeSend()

		// Remove the old client from all pub/sub topics before replacing.
		h.pubsub.UnsubscribeAll(old)
		h.removeClientLocked(old)
	} else if list := h.clients[c.userID]; len(list) >= maxConnectionsPerUser {
		// The cap: evict the oldest connection (all remaining ones belong to
		// other sessions) through the same SESSION_REPLACED path. It is a
		// terminal kick so its call is torn down at once rather than parked
		// for a resume that cannot come.
		// The oldest one that does not hold the account's call (at most one
		// does): the cap must not end a call. All-holders cannot happen with
		// a cap above 1, but the oldest is the fallback.
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

	// Subscribe the new client to its default pub/sub topics immediately
	// after UnsubscribeAll(old) above, with nothing in between.
	//
	// This does NOT make strip+resubscribe atomic, and must not be read as
	// doing so: the two are separate ps.mu acquisitions, and PublishGlobal
	// takes ps.mu alone (never h.mu), so a deliverBroadcast landing between
	// them still finds no subscriber for this user. That frame is
	// unrecoverable — its seq was already allocated and pushed to the replay
	// buffer, the resuming client's replay snapshot was taken even earlier,
	// and the client tracks only max(seq), so the next frame silently
	// advances past the hole. Only a caller holding h.seqMu closes that
	// window; see this function's doc comment and replay.go's handleReconnect.
	//
	// What the ordering does buy is the smallest possible gap for the callers
	// that cannot hold seqMu — the fresh-connect path, whose buildReady
	// rebuilds state from the DB afterwards, and the clientEvents path, which
	// runs on the hub goroutine and so cannot race deliverBroadcast at all.
	// The registration log line (a syscall-backed slog call) and
	// updateKeyHolder (keyHolderMu plus a full h.clients scan under
	// h.mu.RLock) both used to sit in that gap; both now run after the
	// subscribes. Keeping the subscribes under h.mu is incidental but free:
	// pubsub uses its own independent lock and never calls back into the hub,
	// so h.mu → ps.mu adds no lock-ordering risk.
	h.pubsub.Subscribe(c, TopicGlobal)
	h.pubsub.Subscribe(c, UserTopic(c.userID))
	// If the client already has a focused channel (e.g. test clients created with
	// NewTestClientWithChannel, or reconnecting clients), subscribe immediately so
	// deliverBroadcast can reach them without waiting for a channel_focus message.
	if chID := c.getChannelID(); chID != 0 {
		h.pubsub.Subscribe(c, ChannelTopic(chID))
	}
	// If the client is already in a voice channel (e.g. reconnect), restore its
	// subscriptions without a new voice_join (a same-channel rejoin is rejected
	// with ALREADY_JOINED) or channel_focus.
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		// VoiceTopic is the only transport for voice_e2ee_announce relays and
		// carries nothing else, for a channel the user already joined via the
		// voice_join gate (permissions.CanJoinVoice) — so no separate READ gate.
		h.pubsub.Subscribe(c, VoiceTopic(voiceChID))
		// Voice membership can outlive READ_MESSAGES (a mid-call revocation,
		// or a closed DM), so it must not by itself grant a channel's message stream: subscribe only when the
		// handshake confirmed READ_MESSAGES on that channel.
		if readableChannelIDs[voiceChID] {
			h.pubsub.Subscribe(c, ChannelTopic(voiceChID))
		}
	}
	total := h.connectionCountLocked()
	h.mu.Unlock()

	slog.Info("hub: client registered", "user_id", c.userID, "total_clients", total)

	// A call this session parked and another device then moved away: tell it
	// first, before any other voice frame, so it clears its local call.
	// Only a resume (lastSeq > 0) can hold the call locally; a fresh connect just
	// drops the note.
	if ch := h.voiceReg.voiceGrace.takeMoved(c.userID, c.tokenHash); ch != 0 && c.lastSeq > 0 {
		c.sendMsg(buildVoiceDisconnected(ch, voiceMovedReason))
	}

	// A fresh connect (lastSeq == 0) drops the replaced connection's voice state
	// without transferring it, so that channel just lost a participant and the
	// E2EE key holder may need to move. handleVoiceLeave never runs on this path
	// — readPump skips it when replaced, and it early-returns on already-cleared
	// state — so re-elect here. Must be outside h.mu: updateKeyHolder takes
	// keyHolderMu and then h.mu.RLock. The recompute reads live client voice
	// state, so it is idempotent and also correct when the state was transferred.
	// It runs after the subscribe block above; updateKeyHolder only reads
	// h.clients' voice state and writes voiceKeyHolders, so it has no
	// ordering dependency on pub/sub subscriptions.
	if replacedVoiceChID != 0 {
		h.updateKeyHolder(replacedVoiceChID)
	}
	// RT-8: elections held while the membership was parked could not see it,
	// so a grace inherit re-elects the same way.
	if inheritedVoiceChID != 0 {
		h.updateKeyHolder(inheritedVoiceChID)
	}

	// Re-sync this connection's local E2EE peer-key map now that it is
	// reachable (OC-0276). voice_e2ee_announce is delivered as an
	// unsequenced pub/sub frame (sendToVoiceChannelExcept, voice_e2ee.go),
	// bypassing deliverBroadcast/h.replayBuf entirely — so on a network
	// reconnect (the transfer above), neither reconnect replay tier can ever
	// redeliver a peer's key, or a mid-call key rotation, that was announced
	// while this socket was down. voiceJoinComplete's relay
	// (voice_join.go) only runs on a brand-new voice_join, never here, so
	// without this call a resumed connection's peer-key map would silently
	// and permanently desync from its (correctly replayed) voice roster.
	// c.voice.channel() reflects the transfer above, so this covers a
	// resumed connection as well as a client pre-set into a voice channel
	// (e.g. NewTestClientWithChannel); it is a no-op whenever c is not
	// currently in a voice channel, which is the common case (fresh login).
	if voiceChID := c.voice.channel(); voiceChID != 0 {
		h.sendVoicePeerKeys(c, voiceChID)
		// Same for who-watches-what (voice_watching, also unsequenced). No
		// self re-relay: the resumed client re-sends its own set.
		h.sendVoicePeerWatching(c, voiceChID)
		// Re-relay THIS client's own stored key back onto VoiceTopic (OC-0316).
		// voice_e2ee_offer (the room-key-bearing message) is a targeted,
		// unsequenced send that is silently dropped if this socket was down
		// when it went out (sendToUserIfInVoiceChannel, voice_e2ee.go) — and
		// unlike voice_e2ee_announce it has no reconnect-replay recovery
		// path either. A key rotation sent during the outage otherwise
		// strands this client on a dead key with no signal and no retry
		// until the key holder's next periodic rotation. The client's
		// duplicate-announce handling already re-wraps and re-offers the
		// CURRENT room key whenever it sees a peer announce a key it
		// already knows, so re-announcing our own (unchanged) key is enough
		// to make the key holder re-offer — no client change needed.
		if a := c.getE2EEAnnounce(); a.key != "" {
			h.sendToVoiceChannelExcept(voiceChID, c.userID, buildVoiceE2EEAnnounce(c.userID, a))
		}
	}
}

// postRegisterSessionRecheck re-validates c's session token immediately
// after registerNow makes c reachable via h.clients, closing OC-0423: a
// session revoked (sign-out-everywhere, POST /users/me/sessions/revoke-all;
// or account recovery, RedeemRecoveryKit) while this handshake's earlier DB
// work was still in flight is invisible to DisconnectRevokedUser: that call
// inspects h.clients at one instant, and a connection is not in h.clients
// until registerNow runs. Without this re-check the handshake sails through
// to a live, fully authorized socket on a session row that no longer exists,
// until sweepRevokedSessions' next tick (up to 60s) or the client's 10th
// inbound frame (handleMessageSessionRecheck, SessionCheckInterval).
//
// Calling this AFTER registerNow is what closes the race rather than merely
// shrinking it: a revocation whose DELETE is visible to the read below is
// acted on right here, and one whose DELETE commits later necessarily does so
// after registerNow already ran, so that revocation's own
// DisconnectRevokedUser call finds c in h.clients and kicks it normally.
// There is no ordering left in which neither catches it.
//
// On a live session it also slides the session's expiry (touchSession).
//
// It returns a verdict other than postRegisterOK when the caller must abort
// the handshake instead of continuing to send auth_ok/ready: c has already
// been torn back out of the hub (mirroring unregisterFailedHandshake's
// post-registerNow teardown) and its session is gone or its user banned, so
// nothing behind it should be disclosed. Skips the
// check when c carries no token (never true for a real client) and fails
// open on a transient DB error — a failed read says nothing about the
// session's validity, matching handleMessageSessionRecheck's identical rule
// (OC-0211) and sweepRevokedSessions' rule for a failed batch lookup.
//
// It re-checks the ban the same way handleMessageSessionRecheck does. The
// earlier ban check in refreshUserSnapshot (OC-0272) runs before registerNow,
// so a ban committing between the two finds no client for DisconnectUser to
// kick; the same before/after-registerNow argument as for the session row
// above makes this read the one that catches it.
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
	// The session just proved live on a registered socket: slide its expiry
	// (DP-05). Both handshake paths come through here.
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

// unregisterNow removes c from the hub. It returns true when c was already
// replaced by a newer connection of its own session (registerNow took its slot
// and its voice state): that teardown must not touch the live connection's
// call or the user's presence. It returns false for a real disconnect,
// including a connection that was kicked or evicted (the kick paths already
// removed it from the registry): the voice cleanup runs and the offline
// decision is left to shouldMarkOffline, which asks whether any connection of
// the user remains.
func (h *Hub) unregisterNow(c *Client) bool {
	h.mu.Lock()
	if h.removeClientLocked(c) {
		slog.Info("hub: client unregistered", "user_id", c.userID, "total_clients", h.connectionCountLocked())
		h.mu.Unlock()
		h.pubsub.UnsubscribeAll(c)
		return false // not replaced
	}
	h.mu.Unlock()
	// Residual: a non-terminal kick removes c, a same-session resume then
	// registers before c's read loop reaches this teardown. The resume finds no
	// parked entry yet (so it inherits nothing) and c, not being displaced, is
	// torn down here: its call parks in the grace window and, since nobody
	// inherits it, ends when the 15 s window expires.
	return c.displaced.Load()
}

// shouldMarkOffline reports whether a disconnect teardown should run
// StampDisconnect and broadcast an offline presence for c's user.
//
// `replaced` (unregisterNow's return, sampled once at the start of teardown)
// is necessary but not sufficient: both readPump's defer and
// unregisterFailedHandshake sample it BEFORE handleVoiceLeave, which can
// block (DB delete, audience scan). A reconnect landing during that window
// registers a new client for the same user and is invisible to the stale
// boolean, so the dead connection's teardown would otherwise mark the live
// session offline (OC-0019). Re-checking h.clients at decision time closes
// that gap: any entry present once c has been removed is necessarily a newer
// connection — unregisterNow only ever deletes c's own slot, never someone
// else's.
func (h *Hub) shouldMarkOffline(c *Client, replaced bool) bool {
	if replaced {
		return false
	}
	// Decide and claim under one h.mu hold: two last connections tearing down
	// together (each already removed, each seeing none left) would otherwise
	// both stamp and broadcast offline. registerNow clears the claim, so a
	// reconnect after the offline broadcast can go offline again.
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

// DisconnectUser forcibly disconnects every connection of userID (all their
// devices). No-op if the user is not currently connected. Like DisconnectRevokedUser it
// misses a handshake that has not reached registerNow yet;
// postRegisterSessionRecheck's ban check closes that window.
func (h *Hub) DisconnectUser(userID int64) {
	conns := h.clientsOf(userID)
	if len(conns) > 0 {
		slog.Info("hub: disconnecting user", "user_id", userID, "connections", len(conns))
	}
	for _, c := range conns {
		c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
		h.kickClientTerminal(c)
	}
	// A call a dropped device parked in the grace window has no connection to
	// kick, and survives while another device is connected; it ends with the ban.
	h.leaveParkedVoiceLocked(userID, voiceLeaveReasonDisconnect)
}

// DisconnectRevokedUser drops every live connection of a user whose sessions
// were just revoked (sign-out-everywhere, B4-7): the socket authenticated on
// a session that no longer exists, and the revoked-session sweep would only
// notice on its next tick. No frame precedes the close — the same treatment
// the sweep gives a revoked session — so the client's reconnect meets the
// 401 that tells it to sign in again. No-op if the user is not connected.
//
// This inspects h.clients at one instant, so a revocation landing while a
// connection's handshake is still in flight finds nothing to kick here. That
// window is closed on the other side instead, by postRegisterSessionRecheck
// (hub_registry.go) — see its doc for why the pair leaves no gap (OC-0423).
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

// onClientEvent applies a queued Register or Unregister on the dispatch
// goroutine.
func (h *Hub) onClientEvent(ev clientEvent) {
	if !ev.add {
		h.unregisterNow(ev.c)
		return
	}
	// No handshake permission set on this path (and no DB call on the hub
	// goroutine, ARCH-019) — nil denies the inherited voice-channel
	// subscription. A wake refusal cannot occur here: the handshake paths
	// refuse before queueing a Register event, and the event path never
	// carries wakeReconnect.
	// The dispatch goroutine never takes the voice member lock (voice_registry.go),
	// so it passes a lock-free handle; nothing else runs a voice path for a
	// client that is only now registering.
	h.registerNow(ev.c, nil, h.heldTxn(ev.c.userID))
}
