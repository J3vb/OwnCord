package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

type broadcastMsg struct {
	channelID int64 // 0 = send to all connected clients
	msg       []byte
	// recipients, when non-nil, replaces topic fan-out with direct delivery
	// (voice_state/voice_leave: global in scope but must not disclose a channel the
	// recipient cannot READ). Resolved off the hub goroutine so deliverBroadcast
	// stays free of permission queries.
	recipients []int64
	// audienceMark, when non-zero, is audienceMark() read before recipients was
	// resolved, so delivery also reaches a connection that resumed since
	// (sendToLateResumes).
	audienceMark uint64
	// excludeUserID, when non-zero, is omitted from a global broadcast (the public
	// half of an invisible user's presence). The owner's view is a separate
	// synchronous send that the async broadcast could otherwise overwrite.
	excludeUserID int64
	// senderID is the user whose request produced this channel frame; the topic
	// limiter counts it against that sender alone.
	senderID int64
	// barrier, when non-nil, makes this entry a dispatch barrier: dispatch closes it
	// and sequences nothing, so a waiter knows every earlier (FIFO, gate-parked
	// included) broadcast has been sequenced and persisted (awaitDispatch).
	barrier chan struct{}
	// enqueuedAt stamps the enqueue site for enqueue-to-fanout latency; zero on test messages.
	enqueuedAt time.Time
	// nsfwChannelID marks a content-bearing channel event whose NSFW gate is resolved
	// at dispatch, not enqueue (hub_content_gate.go). A list precomputed at enqueue is
	// unsound: a later revocation is invisible to it, and a frame enqueued while
	// unlabelled would reach every subscriber and plugin if labelled before dispatch.
	nsfwChannelID int64
	// laneChannelID, on a global frame, names the channel whose parked content it
	// must not overtake (BroadcastChannelDelete); ordering only.
	laneChannelID int64
	// presence, droppable and presenceSnapshot carry presence_batch and its drop policy (hub_presence.go).
	presence         map[int64]pendingPresence
	droppable        bool
	presenceSnapshot bool
	// members are the entries msg was built from (member_update[_batch]), so an
	// erased member costs only its own entry.
	members []memberUpdatePayload
}

// BroadcastToChannel enqueues msg for clients subscribed to channelID (0 = every
// client). Non-blocking: a full channel drops it with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	h.enqueue(broadcastMsg{channelID: channelID, msg: msg}, "message")
}

// BroadcastToAll enqueues msg for every connected client, non-blocking.
func (h *Hub) BroadcastToAll(msg []byte) {
	h.enqueue(broadcastMsg{channelID: 0, msg: msg}, "global message")
}

// BroadcastToAllExcept is BroadcastToAll minus excludeUserID. It shares the
// h.broadcast queue and seqMu-serialized deliverBroadcast, which keeps two
// broadcasts about one user in order; direct pub/sub would reorder.
func (h *Hub) BroadcastToAllExcept(excludeUserID int64, msg []byte) {
	h.enqueue(broadcastMsg{channelID: 0, excludeUserID: excludeUserID, msg: msg}, "global message")
}

// broadcastChannelScoped enqueues msg for the clients whose role may READ channelID,
// tagged with it so replay filters too (EventsSinceFiltered replays channelID 0
// unconditionally). kind only labels the drop warning.
func (h *Hub) broadcastChannelScoped(ctx context.Context, channelID int64, msg []byte, kind string) {
	mark := h.audienceMark()
	h.broadcastChannelScopedTo(channelID, msg, h.channelReadAudience(ctx, channelID), mark, kind)
}

// broadcastChannelScopedTo takes a pre-resolved audience so callers fanning out
// several messages for one channel resolve it once; recipients is only read after
// enqueue. mark is audienceMark() read before recipients was resolved.
func (h *Hub) broadcastChannelScopedTo(channelID int64, msg []byte, recipients []int64, mark uint64, kind string) {
	h.enqueue(broadcastMsg{
		channelID:    channelID,
		msg:          msg,
		recipients:   recipients,
		audienceMark: mark,
	}, kind)
}

// BroadcastChannelCreate sends channel_create only to clients whose role may READ
// ch (a global send would leak a channel that overrides hide), each with its own
// channelAffordances verdicts. The sends bypass sequenced replay, so
// begin/endTargetedFanout force a reconnect during or across them onto a full
// ready. The audience resolves against Background: the admin HubBroadcaster
// interface carries no context and the fan-out must complete.
func (h *Hub) BroadcastChannelCreate(ch *db.Channel) {
	h.beginTargetedFanout()
	defer h.endTargetedFanout()
	ctx := context.Background()
	private := h.channelIsPrivate(ctx, ch.ID, ch.Type)
	for _, uid := range h.channelReadAudience(ctx, ch.ID) {
		fireBroadcastChannelCreateRaceHook(uid)
		var frame []byte
		for _, live := range h.clientsOf(uid) {
			if !live.sendsChannel(ch.Type) {
				continue
			}
			if frame == nil {
				frame = buildChannelCreateFor(ch, private, h.refreshChannelVisibilityAffordances(ctx, ch, uid))
			}
			live.sendMsg(frame)
		}
	}
}

// BroadcastChannelUpdate sends channel_update to clients whose role may READ ch, as
// one shared sequenced frame.
func (h *Hub) BroadcastChannelUpdate(ch *db.Channel) {
	ctx := context.Background()
	h.broadcastChannelScoped(ctx, ch.ID, buildChannelUpdate(ch, h.channelIsPrivate(ctx, ch.ID, ch.Type)), "channel_update")
}

// BroadcastChannelDelete sends channel_delete to all clients, deliberately
// unfiltered: the channel row and its overrides are gone, so a permission check
// would use base role perms and could drop the delete for users who saw it via a
// positive override, stranding it in their sidebar. laneChannelID keeps it behind
// the channel's gated content so no client sees a message for a removed channel.
func (h *Hub) BroadcastChannelDelete(channelID int64) {
	h.forgetChannelAudience(channelID)
	h.enqueue(broadcastMsg{msg: buildChannelDelete(channelID), laneChannelID: channelID}, "global message")
}

// refreshChannelVisibilityRaceHook runs per connected user after
// RefreshChannelVisibility resolves visibility, before re-resolving the live
// client. Test-only: races a reconnect into that narrow window.
var refreshChannelVisibilityRaceHook func(userID int64)

// deliverGatedBeforeSeqMuHook runs in deliverGated after the pre-seqMu work, before
// the lock. Test-only; nil in production.
var deliverGatedBeforeSeqMuHook func()

// refsBeforeLock parses a frame that is final before seqMu for tombstoned ids, so
// the lock holds set lookups only. A presence or member window is built under the
// lock and keeps the in-lock parse (nil here).
func (h *Hub) refsBeforeLock(bm broadcastMsg) *preParsedRefs {
	var preRefs *preParsedRefs
	if bm.presence == nil && bm.members == nil {
		preRefs = h.parseRefsBeforeLock(bm.msg)
	}
	if deliverGatedBeforeSeqMuHook != nil {
		deliverGatedBeforeSeqMuHook()
	}
	return preRefs
}

// BroadcastRolesUpdate sends the full role list to every client, unfiltered
// (already in every ready).
func (h *Hub) BroadcastRolesUpdate(roles []*db.Role) {
	h.BroadcastToAll(buildRolesUpdate(roles))
}

// BroadcastEmojiUpdate sends the full emoji set to every client, unfiltered
// (server-wide, clients may already GET it).
func (h *Hub) BroadcastEmojiUpdate(list []*db.Emoji) {
	h.BroadcastToAll(buildEmojiUpdate(list))
}

// BroadcastChatBulkDeleted sends one chat_bulk_deleted with every purged id to
// channelID's subscribers, sequenced so it replays like chat_deleted.
func (h *Hub) BroadcastChatBulkDeleted(channelID int64, messageIDs []int64) {
	h.BroadcastToChannel(channelID, buildChatBulkDeleted(channelID, messageIDs))
	h.noteIfThread(channelID)
}

// BroadcastMemberBan sends member_ban to all clients and disconnects the banned user.
func (h *Hub) BroadcastMemberBan(userID int64) {
	h.BroadcastToAll(buildMemberBan(userID))
	h.DisconnectUser(userID)
}

// BroadcastMemberUnban mirrors BroadcastMemberBan: member_ban hard-deletes the row
// on every client, so an unban re-adds it with the member_join a fresh connect
// would send. Satisfies admin's memberUnbanBroadcaster (hub_wiring_test.go).
func (h *Hub) BroadcastMemberUnban(userID int64) {
	ctx := context.Background()
	user, err := h.readers.Members.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		slog.Error("hub: BroadcastMemberUnban GetUserByID failed", "user_id", userID, "err", err)
		return
	}
	roleName := ""
	var roleIDs []int64
	if role, err := h.readers.Members.GetMemberRoles(ctx, userID); err == nil && role != nil {
		roleName, roleIDs = role.Top.Name, role.IDs
	}
	// A lapsed temporary ban lets the user reconnect while users.banned is still 1, so
	// they may be online now. Report the live status, never the row (it can lag the
	// batched connect stamp).
	if live := h.LiveStatus(userID); live != "" {
		user.Status = live
	} else {
		user.Status = db.StatusOffline
	}
	h.BroadcastToAll(buildMemberJoin(user, roleName, roleIDs))
}

// BroadcastUserUpdate sends user_update to all clients when a user changes their profile.
func (h *Hub) BroadcastUserUpdate(u UserUpdate) {
	h.BroadcastToAll(buildUserUpdate(u))
}

// BroadcastMemberUpdate sends member_update to all clients and re-evaluates the
// user's live channel subscriptions.
func (h *Hub) BroadcastMemberUpdate(userID int64, roleName string) {
	h.BroadcastToAll(buildMemberUpdate(userID, roleName, nil))
	h.revokeUnreadableChannels(userID)
}

// revokeUnreadableChannels drops channel-topic subscriptions the user's new role
// may no longer READ (READ_MESSAGES is checked once, at channel_focus, so a demoted
// user would keep receiving traffic). Per client it mirrors
// RefreshChannelVisibility: targeted unsequenced channel_delete + Unsubscribe, then
// a visibilityChangeSeq bump. Only topics the socket holds are examined: a blanket
// sweep would disclose the channel-ID list to a demoted user.
//
// revokeUnreadableChannelsPreActRaceHook runs per revoked topic before the
// live-client re-resolve; test-only, pins the replaced-mid-loop hazard.
var revokeUnreadableChannelsPreActRaceHook func(userID int64)

// SendToUser delivers msg to every live connection of userID; true if at least one
// queued it.
func (h *Hub) SendToUser(userID int64, msg []byte) bool {
	queued := false
	for _, c := range h.clientsOf(userID) {
		if c.trySendMsg(msg) {
			queued = true
		}
	}
	return queued
}

// SendToUserHigh sends a high-priority message to every connection of userID.
// Returns false when the user has none.
func (h *Hub) SendToUserHigh(userID int64, msg []byte) bool {
	conns := h.clientsOf(userID)
	for _, c := range conns {
		c.sendHighMsg(msg)
	}
	return len(conns) > 0
}

// SendToUserLow sends low priority to every connection of userID; unlike
// SendToUserHigh an overflow is dropped, not a disconnect.
func (h *Hub) SendToUserLow(userID int64, msg []byte) bool {
	conns := h.clientsOf(userID)
	for _, c := range conns {
		c.sendLowMsg(msg)
	}
	return len(conns) > 0
}

// sendSequencedToUsers stamps msg with a monotonic seq, stores it in the replay
// buffer under channelID and sends it to userIDs on the normal queue.
// Sequenced frames must share one per-client FIFO: writePump drains sendHigh first,
// so a seq-stamped frame on high would overtake lower-seq frames in send. The client
// acks max(seq) and replay is strictly seq > last_seq, so a disconnect then would
// lose the overtaken events. High is for unsequenced targeted messages only.
// mark is audienceMark() read before userIDs was resolved, or zero when userIDs
// does not depend on who is connected.
func (h *Hub) sendSequencedToUsers(channelID int64, userIDs []int64, mark uint64, msg []byte) {
	// The replay copy's JSON work happens before the lock.
	rs := newReplaySplice(msg)
	contentBearing := contentBearingKinds[extractEventType(msg)]
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)

	if h.dropsForTombstones(msg) {
		return
	}
	seq := h.nextSeq()
	wrapped := wrapWithSeq(msg, seq)
	stored := storedCopy(rs, msg, wrapped, seq)
	h.replayBuf.pushEntry(seq, channelID, contentBearing, stored)
	h.persistEvent(seq, channelID, stored)

	for _, userID := range userIDs {
		h.SendToUser(userID, wrapped)
	}
	h.sendToLateResumes(mark, channelID, userIDs, wrapped)
}

// deliverGated stamps bm.msg with a monotonic seq, stores it in the replay buffer
// and sends it via pub/sub. g is the NSFW gate resolved off the dispatch goroutine;
// the zero gateResult is unfiltered.
func (h *Hub) deliverGated(bm broadcastMsg, g gateResult) {
	contentFilter, labelled, gateUnconfirmed := g.allow, g.labelled, g.unconfirmed

	// The replay copy's JSON work happens before seqMu. A presence window builds its
	// frame under the lock and has nothing to precompute.
	var rs *replaySplice
	contentBearing := false
	if bm.presence == nil {
		rs = newReplaySplice(bm.msg)
		contentBearing = contentBearingKinds[extractEventType(bm.msg)]
	}

	// The limiter key depends on bm alone, so it is built before the lock.
	limiterKey := topicLimiterKey(bm)

	preRefs := h.refsBeforeLock(bm)

	// The debug log is emitted after seqMu is released so a slow sink never extends
	// the critical section that serializes every broadcast.
	seq, delivered, channelSend, pluginMsg := func() (seq uint64, delivered int, channelSend bool, pluginMsg []byte) {
		h.seqMu.Lock()
		start := time.Now()
		defer h.seqMu.Unlock()
		defer h.observeSeqMuHold(start)
		defer h.applyQueueContentDrops()

		// Consult the topic limiter before a seq is allocated: a shed frame holding a seq
		// would sit in the replay buffer as a number no client saw live, and since clients
		// ack only max(seq) it could never be requested back. allowTopicFrame owns the
		// shed handling (count, watermark, loss mark).
		if !h.allowTopicFrame(bm, limiterKey) {
			return 0, 0, false, nil
		}

		var private map[int64][]byte
		if bm.presence != nil {
			bm.msg, private = h.buildPresenceBatch(bm.presence)
			if bm.msg == nil {
				return 0, 0, false, nil
			}
		}

		if bm.members != nil {
			bm.msg = h.memberUpdatesWithoutErased(bm.members, bm.msg)
			if bm.msg == nil {
				return 0, 0, false, nil
			}
		}

		// A frame naming an erased user, from a request that read its rows before the
		// erasure and reached the hub after the purge, must not be sequenced.
		if h.dropsForTombstonesWith(bm.msg, preRefs) {
			return 0, 0, false, nil
		}

		seq = h.nextSeq()
		msg := wrapWithSeq(bm.msg, seq)
		if gateUnconfirmed {
			// The deny-all gate withheld this frame from subscribers it may not have meant
			// to skip: a resume at or behind it takes the full ready, a connected one resyncs.
			h.bumpVisibilityWatermark()
			h.markLoss(lossRoute{channelID: bm.channelID, recipients: bm.recipients, audienceMark: bm.audienceMark})
		}

		stored := storedCopy(rs, bm.msg, msg, seq)
		h.replayBuf.pushEntry(seq, bm.channelID, contentBearing, stored)
		h.persistEvent(seq, bm.channelID, stored)

		// Plugin fan-out is captured here and called after seqMu is released on this same
		// dispatch goroutine, so sink order equals seq order. A plugin has no NSFW
		// acknowledgement, so a labelled channel's content never reaches it.
		if h.events.pluginSink.Load() != nil && !labelled {
			pluginMsg = msg
		}

		switch {
		case bm.recipients != nil:
			for _, userID := range bm.recipients {
				h.SendToUser(userID, msg)
			}
			h.sendToLateResumes(bm.audienceMark, bm.channelID, bm.recipients, msg)
		case bm.channelID == 0:
			h.publishGlobal(bm, msg, seq, private)
		default:
			// contentFilter narrows delivery to the subset of this live subscriber list it
			// approves, using label and acknowledgements read after dequeue, so a concurrent
			// reconnect's registration (also under seqMu) cannot land between who was asked
			// and who got it.
			if contentFilter != nil {
				delivered = h.pubsub.PublishFiltered(ChannelTopic(bm.channelID), msg, contentFilter)
			} else {
				delivered = h.pubsub.Publish(ChannelTopic(bm.channelID), msg, 0)
			}
			channelSend = true
		}
		return seq, delivered, channelSend, pluginMsg
	}()

	if pluginMsg != nil {
		h.dispatchToPlugins(pluginMsg)
	}

	// Instrumentation runs after seqMu is released. seq == 0 means the topic limiter
	// shed the frame.
	if seq != 0 {
		m := telemetry.NewAppMetrics()
		m.WSMessagesTotal.Add(context.Background(), 1)
		if !bm.enqueuedAt.IsZero() {
			m.WSBroadcastLatency.Record(context.Background(), time.Since(bm.enqueuedAt).Seconds())
		}
		h.recordBroadcastLatency(bm.enqueuedAt)
	}
	if channelSend {
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "seq", seq)
	}
}
