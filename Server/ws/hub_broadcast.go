package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// broadcastMsg is a message queued for delivery.
type broadcastMsg struct {
	channelID int64 // 0 = send to all connected clients
	msg       []byte
	// recipients, when non-nil, replaces topic fan-out with direct delivery to these
	// user IDs. Used by voice_state/voice_leave, which are global in scope but must
	// not disclose a channel the recipient cannot READ; the audience is resolved off
	// the hub goroutine so deliverBroadcast stays free of permission queries.
	recipients []int64
	// excludeUserID, when non-zero, is omitted from a global (channelID == 0)
	// broadcast. Used for the public half of an invisible user's presence
	// (BroadcastToAllExcept): the owner's view comes from a separate synchronous
	// targeted send, and the async global broadcast racing it could overwrite it.
	excludeUserID int64
	// senderID, when non-zero, is the user whose request produced this channel frame;
	// the topic limiter counts it against that sender alone (allowTopicFrame).
	senderID int64
	// barrier, when non-nil, makes this entry a dispatch barrier: dispatch closes it
	// and sequences nothing. h.broadcast is FIFO on one dispatch goroutine and a
	// barrier waits for earlier frames still parked on their content gate
	// (hub_content_gate.go), so a waiter knows every earlier broadcast has been
	// sequenced, buffered and handed to the persister (awaitDispatch).
	barrier chan struct{}
	// enqueuedAt stamps the enqueue site for enqueue-to-fanout latency; zero on test messages.
	enqueuedAt time.Time
	// nsfwChannelID, when non-zero, marks a content-bearing channel event (see
	// contentBearingKinds) whose NSFW gate is resolved at dispatch time, not by the
	// caller at enqueue (hub_content_gate.go). It carries only the channel identity;
	// the label and acknowledgement are read after dequeue, so a revocation or
	// relabel that completed while the event waited is honoured. A list precomputed
	// at enqueue is unsound both ways: a later revocation is invisible to the queued
	// frame, and a frame enqueued while the channel was unlabelled carries no filter
	// and would reach every subscriber and the plugin sink if labelled before dispatch.
	nsfwChannelID int64
	// laneChannelID, on a global frame, names the channel whose parked content it must
	// not overtake (BroadcastChannelDelete). Ordering only; delivery is unchanged.
	laneChannelID int64
	// presence, droppable and presenceSnapshot carry presence_batch and its drop policy (hub_presence.go).
	presence         map[int64]pendingPresence
	droppable        bool
	presenceSnapshot bool
}

// BroadcastToChannel enqueues msg for clients subscribed to channelID (0 means
// every client). Non-blocking: a full broadcast channel drops it with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	h.enqueue(broadcastMsg{channelID: channelID, msg: msg}, "message")
}

// BroadcastToAll enqueues msg for every connected client. Non-blocking: a full
// channel drops it with a warning.
func (h *Hub) BroadcastToAll(msg []byte) {
	h.enqueue(broadcastMsg{channelID: 0, msg: msg}, "global message")
}

// BroadcastToAllExcept enqueues msg for every connected client except
// excludeUserID. Non-blocking like BroadcastToAll.
//
// It goes through the same h.broadcast queue, single dispatch goroutine and
// seqMu-serialized deliverBroadcast as other global broadcasts, which gives two
// broadcasts about one user (e.g. a connect presence frame and this one) their
// correct relative order at each observer. Publishing straight to pub/sub would
// reintroduce reordering.
func (h *Hub) BroadcastToAllExcept(excludeUserID int64, msg []byte) {
	h.enqueue(broadcastMsg{channelID: 0, excludeUserID: excludeUserID, msg: msg}, "global message")
}

// broadcastChannelScoped enqueues msg for exactly the clients whose current role
// may READ channelID, tagged with the channel id so replay filters it too
// (EventsSinceFiltered replays channelID 0 unconditionally). kind only labels the
// drop warning.
func (h *Hub) broadcastChannelScoped(ctx context.Context, channelID int64, msg []byte, kind string) {
	h.broadcastChannelScopedTo(channelID, msg, h.channelReadAudience(ctx, channelID), kind)
}

// broadcastChannelScopedTo enqueues msg for a pre-resolved audience, so callers
// fanning out several messages for one channel (CleanupVoiceForChannel) resolve it
// once. recipients is only read after enqueue, so sharing the slice is safe.
func (h *Hub) broadcastChannelScopedTo(channelID int64, msg []byte, recipients []int64, kind string) {
	h.enqueue(broadcastMsg{
		channelID:  channelID,
		msg:        msg,
		recipients: recipients,
	}, kind)
}

// BroadcastChannelCreate sends channel_create to the clients whose current role
// may READ ch; a global send would hand every client the name, category and topic
// of a channel that overrides hide from their role.
//
// Each recipient gets its own frame with its channelAffordances verdicts (a new
// channel has no earlier verdict for an absent field to leave unchanged), the
// form RefreshChannelVisibility sends. The sends bypass the sequenced replay path,
// so begin/endTargetedFanout force a reconnect during or across them onto a full
// ready. The audience is resolved against Background because the admin
// HubBroadcaster interface carries no context and the fan-out must complete.
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

// BroadcastChannelUpdate sends channel_update to the clients whose current role
// may READ ch, as one shared sequenced frame.
func (h *Hub) BroadcastChannelUpdate(ch *db.Channel) {
	ctx := context.Background()
	h.broadcastChannelScoped(ctx, ch.ID, buildChannelUpdate(ch, h.channelIsPrivate(ctx, ch.ID, ch.Type)), "channel_update")
}

// BroadcastChannelDelete sends channel_delete to all connected clients.
//
// Deliberately unfiltered: the payload is the bare id, and by now the channel row
// and its cascaded channel_overrides are gone, so a permission check would use
// base role perms and could drop the delete for users who saw the channel via a
// positive override, stranding it in their sidebar. laneChannelID keeps it behind
// the channel's content still waiting on its gate, so a client never sees a
// message for a channel it already removed.
func (h *Hub) BroadcastChannelDelete(channelID int64) {
	h.enqueue(broadcastMsg{msg: buildChannelDelete(channelID), laneChannelID: channelID}, "global message")
}

// refreshChannelVisibilityRaceHook, when non-nil, runs once per connected user
// after RefreshChannelVisibility resolves visibility but before it re-resolves
// the live client. Test-only: the window is one or two DB round trips per client,
// too fast to land a real reconnect in, so tests use it to race one in
// deterministically.
var refreshChannelVisibilityRaceHook func(userID int64)

// BroadcastRolesUpdate sends the full role list to every connected client.
// Unfiltered: the list is already in every ready payload.
func (h *Hub) BroadcastRolesUpdate(roles []*db.Role) {
	h.BroadcastToAll(buildRolesUpdate(roles))
}

// BroadcastEmojiUpdate sends the full custom-emoji set to every connected client.
// Unfiltered: emoji are server-wide and every client may already GET the list.
func (h *Hub) BroadcastEmojiUpdate(list []*db.Emoji) {
	h.BroadcastToAll(buildEmojiUpdate(list))
}

// BroadcastChatBulkDeleted sends one chat_bulk_deleted carrying every purged
// message id to channelID's subscribers instead of N chat_deleted frames. It uses
// the sequenced channel path, so it replays on reconnect like chat_deleted.
func (h *Hub) BroadcastChatBulkDeleted(channelID int64, messageIDs []int64) {
	h.BroadcastToChannel(channelID, buildChatBulkDeleted(channelID, messageIDs))
	h.noteIfThread(channelID)
}

// BroadcastMemberBan sends member_ban to all clients and disconnects the banned user.
func (h *Hub) BroadcastMemberBan(userID int64) {
	h.BroadcastToAll(buildMemberBan(userID))
	h.DisconnectUser(userID)
}

// BroadcastMemberUnban mirrors BroadcastMemberBan: member_ban hard-deletes the
// row on every connected client, so an unban re-adds it with the member_join a
// fresh connect would send, or connected clients disagree with fresh ones. It
// satisfies admin's memberUnbanBroadcaster capability (pinned by
// hub_wiring_test.go).
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
	// A lapsed temporary ban lets the user reconnect while users.banned is still 1,
	// so they can be online at unban time. Report the live stamped status, never the
	// row (offline with no stamped connection; the row can lag the batched connect
	// stamp). buildMemberJoin hides invisible.
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
// reassigned user's live channel subscriptions.
func (h *Hub) BroadcastMemberUpdate(userID int64, roleName string) {
	h.BroadcastToAll(buildMemberUpdate(userID, roleName, nil))
	h.revokeUnreadableChannels(userID)
}

// revokeUnreadableChannels drops the channel-topic subscriptions the user's new
// role may no longer READ. READ_MESSAGES is checked once, at channel_focus, then
// becomes a durable subscription, so a demoted user would keep receiving
// channel traffic while the socket stays open.
//
// Per-client work mirrors RefreshChannelVisibility: targeted unsequenced
// channel_delete + Unsubscribe, then a visibilityChangeSeq bump so a resuming
// client takes the full-ready path. Only topics the socket actually holds are
// examined: a blanket sweep would disclose the full channel-ID list to a demoted user.
//
// revokeUnreadableChannelsPreActRaceHook, when non-nil, runs once per revoked
// topic just before the live-client re-resolve. Test-only; pins the
// replaced-mid-loop hazard deterministically.
var revokeUnreadableChannelsPreActRaceHook func(userID int64)

// SendToUser delivers msg to every live connection of userID. Returns true if at
// least one connection queued it.
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

// SendToUserLow sends a low-priority message to every connection of userID.
// Unlike SendToUserHigh an overflow is dropped rather than disconnecting the
// client; for ephemeral events (e.g. DM typing) that need direct routing.
func (h *Hub) SendToUserLow(userID int64, msg []byte) bool {
	conns := h.clientsOf(userID)
	for _, c := range conns {
		c.sendLowMsg(msg)
	}
	return len(conns) > 0
}

// sendSequencedToUsers stamps msg with a monotonic seq, stores it in the replay
// buffer under channelID and sends the wrapped payload to userIDs on the
// normal-priority queue.
//
// Sequenced frames must share one per-client FIFO: writePump drains sendHigh
// before send, so a seq-stamped frame on the high queue would overtake
// lower-seq frames still in send. The client acks max(seq) and replay is strictly
// seq > last_seq, so a disconnect then would silently lose the overtaken events.
// The high queue is for unsequenced targeted messages only.
func (h *Hub) sendSequencedToUsers(channelID int64, userIDs []int64, msg []byte) {
	// The replay copy's JSON work happens before the lock.
	rs := newReplaySplice(msg)
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
	h.replayBuf.Push(seq, channelID, stored)
	h.persistEvent(seq, channelID, stored)

	for _, userID := range userIDs {
		h.SendToUser(userID, wrapped)
	}
}

// deliverGated stamps bm.msg with a monotonic seq, stores it in the replay buffer
// and sends it via pub/sub. g is the NSFW gate resolved off the dispatch goroutine
// (hub_content_gate.go); the zero gateResult is unfiltered, as for every
// non-content frame.
func (h *Hub) deliverGated(bm broadcastMsg, g gateResult) {
	contentFilter, labelled, gateUnconfirmed := g.allow, g.labelled, g.unconfirmed

	// The replay copy's JSON work happens before seqMu. A presence window builds its
	// frame under the lock and carries no reply snippet, so has nothing to precompute.
	var rs *replaySplice
	if bm.presence == nil {
		rs = newReplaySplice(bm.msg)
	}

	// The channel-broadcast debug log is emitted after seqMu is released so a slow
	// sink never extends the critical section that serializes every broadcast.
	seq, delivered, channelSend, pluginMsg := func() (seq uint64, delivered int, channelSend bool, pluginMsg []byte) {
		h.seqMu.Lock()
		start := time.Now()
		defer h.seqMu.Unlock()
		defer h.observeSeqMuHold(start)
		defer h.applyQueueContentDrops()

		// Consult the topic limiter before a seq is allocated: a shed frame that consumed
		// a seq would sit in the replay buffer as a number no client saw live, and since
		// clients ack only max(seq) it could never be requested back. allowTopicFrame owns
		// the shed handling (count + watermark).
		if !h.allowTopicFrame(bm) {
			return 0, 0, false, nil
		}

		// A window's presence_batch names many users: an erased one loses only its own entry.
		var private map[int64][]byte
		if bm.presence != nil {
			bm.msg, private = h.buildPresenceBatch(bm.presence)
			if bm.msg == nil {
				return 0, 0, false, nil
			}
		}

		// A frame naming an erased user, produced by a request that read its rows before
		// the erasure and reached the hub after the purge, must not be sequenced.
		if h.dropsForTombstones(bm.msg) {
			return 0, 0, false, nil
		}

		seq = h.nextSeq()
		msg := wrapWithSeq(bm.msg, seq)
		if gateUnconfirmed {
			// The deny-all gate withheld this frame from subscribers it may not have meant to
			// skip: a resume at or behind it must take the full-ready path, a connected one resync.
			h.bumpVisibilityWatermark()
			h.markLoss(lossRoute{channelID: bm.channelID, recipients: bm.recipients})
		}

		stored := storedCopy(rs, bm.msg, msg, seq)
		h.replayBuf.Push(seq, bm.channelID, stored)
		h.persistEvent(seq, bm.channelID, stored)

		// Plugin fan-out is captured here and called after seqMu is released, on this same
		// dispatch goroutine, so sink order equals seq order. A plugin has no NSFW
		// acknowledgement, so a labelled channel's content never reaches the sink.
		if h.pluginSink.Load() != nil && !labelled {
			pluginMsg = msg
		}

		switch {
		case bm.recipients != nil:
			for _, userID := range bm.recipients {
				h.SendToUser(userID, msg)
			}
		case bm.channelID == 0:
			h.publishGlobal(bm, msg, seq, private)
		default:
			// Delivers to the channel topic's subscribers. The limiter already passed above.
			// contentFilter narrows delivery to the subset of this live subscriber list it
			// approves, using the label and acknowledgements read after dequeue, so a
			// concurrent reconnect's registration (also under seqMu) cannot land in a gap
			// between who was asked and who got it.
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

	// Instrumentation runs after seqMu is released so a metrics provider never extends
	// the critical section. seq == 0 means the topic limiter shed the frame.
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
