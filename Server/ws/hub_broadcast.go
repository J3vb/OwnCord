package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// broadcastMsg is an internal message queued for delivery.
type broadcastMsg struct {
	channelID int64 // 0 = send to all connected clients
	msg       []byte
	// recipients, when non-nil, replaces topic fan-out with direct delivery to
	// exactly these user IDs. Used by voice_state/voice_leave: they are global
	// in scope (every sidebar shows them) but must not disclose a channel the
	// recipient's role may not READ, and the audience is resolved off the hub
	// goroutine so deliverBroadcast stays free of permission queries.
	recipients []int64
	// excludeUserID, when non-zero, is omitted from a global (channelID == 0)
	// broadcast's live delivery. Used for the public half of an invisible
	// user's presence (see BroadcastToAllExcept): everyone else must see it,
	// but the owner's own view comes from a separate, synchronous, targeted
	// send, and the two racing would let the async global broadcast overwrite
	// it. Ignored outside the channelID == 0 branch of deliverBroadcast.
	excludeUserID int64
	// barrier, when non-nil, makes this entry a dispatch barrier rather than
	// a broadcast: deliverBroadcast closes it and sequences nothing. Because
	// h.broadcast is FIFO on one dispatch goroutine, whoever waits on it
	// knows every broadcast enqueued earlier has been sequenced, buffered
	// and handed to the persister (awaitDispatch).
	barrier chan struct{}
	// enqueuedAt stamps the enqueue site so deliverBroadcast can record
	// enqueue→fanout latency. Zero on test-constructed messages; skipped then.
	enqueuedAt time.Time
}

// BroadcastToChannel enqueues msg for delivery to all clients subscribed to
// channelID. When channelID is 0 the message is sent to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: channelID, msg: msg, enqueuedAt: time.Now()}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping message",
			"channel_id", channelID, "msg_len", len(msg))
	}
}

// BroadcastToAll enqueues msg for delivery to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToAll(msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: 0, msg: msg, enqueuedAt: time.Now()}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping global message",
			"msg_len", len(msg))
	}
}

// BroadcastToAllExcept enqueues msg for delivery to every connected client
// except excludeUserID. Non-blocking, like BroadcastToAll: if the broadcast
// channel is full the message is dropped with a warning.
//
// Routes through the SAME h.broadcast channel — and so the same single-
// goroutine hub dispatch loop and seqMu-serialized deliverBroadcast — as
// BroadcastToAll and every other normal-priority global broadcast. That
// shared serialization is what gives two broadcasts about the same user (say,
// a connect/disconnect presence frame and this one) their correct relative
// order at each observer: whichever enqueues onto h.broadcast first is also
// delivered to c.send first. A caller that instead published straight to
// pub/sub, bypassing this queue, would reintroduce exactly that kind of
// reordering from the other direction (OC-0003).
func (h *Hub) BroadcastToAllExcept(excludeUserID int64, msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: 0, excludeUserID: excludeUserID, msg: msg, enqueuedAt: time.Now()}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping global message",
			"msg_len", len(msg))
	}
}

// broadcastChannelScoped enqueues msg for exactly the connected clients whose
// current role may READ channelID, tagged with that channel id so reconnect
// replay filters it too (EventsSinceFiltered replays a channelID of 0
// unconditionally). kind only labels the drop warning.
func (h *Hub) broadcastChannelScoped(ctx context.Context, channelID int64, msg []byte, kind string) {
	h.broadcastChannelScopedTo(channelID, msg, h.channelReadAudience(ctx, channelID), kind)
}

// broadcastChannelScopedTo enqueues msg for a pre-resolved audience. Callers
// that fan out several messages for the same channel in one operation
// (CleanupVoiceForChannel) resolve the audience once via channelReadAudience
// and reuse it here, instead of re-running the role/override lookups per
// message. recipients is only read after enqueue, so sharing one slice across
// messages is safe.
func (h *Hub) broadcastChannelScopedTo(channelID int64, msg []byte, recipients []int64, kind string) {
	bm := broadcastMsg{
		channelID:  channelID,
		msg:        msg,
		recipients: recipients,
		enqueuedAt: time.Now(),
	}
	select {
	case h.broadcast <- bm:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping "+kind,
			"channel_id", channelID, "msg_len", len(msg))
	}
}

// BroadcastServerRestart sends a server_restart message to all connected clients.
// reason describes why the server is restarting (e.g., "update").
// delaySeconds tells clients how long until the server actually shuts down.
func (h *Hub) BroadcastServerRestart(reason string, delaySeconds int) {
	h.BroadcastToAll(buildServerRestartMsg(reason, delaySeconds))
}

// BroadcastChannelCreate sends a channel_create message to the connected
// clients whose current role may READ ch. It used to go out via BroadcastToAll,
// which handed every authenticated client the name, category and topic of a
// channel that channel_overrides hides from their role — metadata the ready
// payload (buildReady/VisibleChannelIDs) deliberately withholds.
//
// The admin HubBroadcaster interface carries no context, so — like
// RefreshChannelVisibility — the audience is resolved against Background: the
// fan-out must complete regardless of the triggering request.
func (h *Hub) BroadcastChannelCreate(ch *db.Channel) {
	h.broadcastChannelScoped(context.Background(), ch.ID, buildChannelCreate(ch), "channel_create")
}

// BroadcastChannelUpdate sends a channel_update message to the connected
// clients whose current role may READ ch. Same disclosure as
// BroadcastChannelCreate; same filtered fan-out.
func (h *Hub) BroadcastChannelUpdate(ch *db.Channel) {
	h.broadcastChannelScoped(context.Background(), ch.ID, buildChannelUpdate(ch), "channel_update")
}

// BroadcastChannelDelete sends a channel_delete message to all connected clients.
//
// Deliberately unfiltered: the payload is the bare channel id, with none of the
// metadata create/update carry, and by the time the admin handler calls this the
// channel row — and with it the ON DELETE CASCADE'd channel_overrides — is
// already gone, so a permission check here would answer from base role perms
// and could drop the delete for exactly the users who saw the channel via a
// positive override, stranding it in their sidebar.
func (h *Hub) BroadcastChannelDelete(channelID int64) {
	h.BroadcastToAll(buildChannelDelete(channelID))
}

// refreshChannelVisibilityRaceHook, when non-nil, runs once per connected
// user after RefreshChannelVisibility resolves that user's visibility for ch
// but before it re-resolves and acts on the live client. Test-only (always
// nil in production): the window it pins spans one or two DB round trips per
// client (the permission lookup below), too fast to land a real reconnect
// goroutine inside reliably, so tests use this hook to reproduce a reconnect
// racing in at exactly that point deterministically. Mirrors the established
// voiceJoinPostTokenRaceHook / cleanupVoiceRaceClearHook pattern.
var refreshChannelVisibilityRaceHook func(userID int64)

// BroadcastRolesUpdate sends the full role list to every connected client so
// name colors and permission-gated affordances converge without a reconnect.
//
// Unfiltered on purpose: the role list is already in every client's ready
// payload, so it discloses nothing a connected client cannot already read.
func (h *Hub) BroadcastRolesUpdate(roles []*db.Role) {
	h.BroadcastToAll(buildRolesUpdate(roles))
}

// BroadcastEmojiUpdate sends the full custom-emoji set to every connected
// client so a newly uploaded (or deleted) emoji renders in messages, the
// picker and reaction pills without a reconnect.
//
// Unfiltered, like BroadcastRolesUpdate: emoji are server-wide with no channel
// scope, and every client may already GET the same list.
func (h *Hub) BroadcastEmojiUpdate(list []*db.Emoji) {
	h.BroadcastToAll(buildEmojiUpdate(list))
}

// BroadcastChatBulkDeleted sends one chat_bulk_deleted message carrying every
// purged message id to the subscribers of channelID, replacing the N separate
// chat_deleted broadcasts a loop of single deletes would produce. Fan-out goes
// through the ordinary sequenced channel path, so the event replays on
// reconnect exactly like chat_deleted does.
func (h *Hub) BroadcastChatBulkDeleted(channelID int64, messageIDs []int64) {
	h.BroadcastToChannel(channelID, buildChatBulkDeleted(channelID, messageIDs))
}

// BroadcastMemberBan sends a member_ban message to all connected clients
// and immediately disconnects the banned user's WebSocket connection (BUG-113).
func (h *Hub) BroadcastMemberBan(userID int64) {
	h.BroadcastToAll(buildMemberBan(userID))
	h.DisconnectUser(userID)
}

// BroadcastMemberUnban is the mirror of BroadcastMemberBan: member_ban
// hard-deletes the row on every connected client, so an unban must re-add it
// or clients connected through the ban permanently disagree with freshly
// connecting ones. Fans out the same member_join a fresh connect would
// (clients map it to addMember — no protocol change), satisfying the admin
// package's memberUnbanBroadcaster capability; admin's hub_wiring_test.go
// pins that at compile time. (OC-0058)
func (h *Hub) BroadcastMemberUnban(userID int64) {
	ctx := context.Background()
	user, err := h.readers.Members.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		slog.Error("hub: BroadcastMemberUnban GetUserByID failed", "user_id", userID, "err", err)
		return
	}
	roleName := ""
	if role, err := h.readers.Members.GetRoleForUser(ctx, userID); err == nil && role != nil {
		roleName = role.Name
	}
	// The ban disconnected them and reconnecting was refused while banned,
	// so they cannot be online at unban time — report offline regardless of
	// the stale status the row carries (serve_ready's "no live connection is
	// offline, whatever the row says" rule).
	user.Status = "offline"
	h.BroadcastToAll(buildMemberJoin(user, roleName))
}

// DisconnectUser forcibly disconnects the client identified by userID.
// No-op if the user is not currently connected.
func (h *Hub) DisconnectUser(userID int64) {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	slog.Info("hub: disconnecting user", "user_id", userID)
	c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
	h.kickClient(c)
}

// DisconnectRevokedUser drops the live connection of a user whose sessions
// were just revoked (sign-out-everywhere, B4-7): the socket authenticated on
// a session that no longer exists, and the revoked-session sweep would only
// notice on its next tick. No frame precedes the close — the same treatment
// the sweep gives a revoked session — so the client's reconnect meets the
// 401 that tells it to sign in again. No-op if the user is not connected.
func (h *Hub) DisconnectRevokedUser(userID int64) {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	slog.Info("hub: disconnecting user after sign-out-everywhere", "user_id", userID)
	h.kickClient(c)
}

// BroadcastUserUpdate sends a user_update message to all connected clients
// when a user changes their profile (username, avatar, display name, about,
// identity key).
func (h *Hub) BroadcastUserUpdate(u UserUpdate) {
	h.BroadcastToAll(buildUserUpdate(u))
}

// BroadcastMemberUpdate sends a member_update message to all connected clients
// and re-evaluates the reassigned user's live channel subscriptions.
func (h *Hub) BroadcastMemberUpdate(userID int64, roleName string) {
	h.BroadcastToAll(buildMemberUpdate(userID, roleName))
	h.revokeUnreadableChannels(userID)
}

// revokeUnreadableChannels drops the channel-topic subscriptions the user's new
// role may no longer READ. READ_MESSAGES is checked once, at channel_focus, and
// then becomes a durable pub/sub subscription, so without this a demoted user
// keeps receiving every chat_message / chat_edited / reaction_update posted in
// the channels their old role could read for as long as the socket stays open.
//
// The per-client work mirrors RefreshChannelVisibility, the channel_overrides
// equivalent: targeted, unsequenced channel_delete + Unsubscribe (a replayed
// channel_delete would be filtered by the allowed set computed at replay time),
// then a visibilityChangeSeq bump so a client resuming across this change takes
// the full-ready path instead of replay.
//
// Only the topics the socket actually holds are examined — a blanket sweep over
// every channel would disclose the full channel-ID list to a demoted user.
//
// revokeUnreadableChannelsPreActRaceHook, when non-nil, runs once per revoked
// topic immediately before the live-client re-resolve. Test-only (nil in
// production); pins the replaced-mid-loop hazard deterministically — same
// pattern as refreshChannelVisibilityRaceHook.
var revokeUnreadableChannelsPreActRaceHook func(userID int64)

// SendToUser delivers msg directly to the client identified by userID.
// Returns true if the client was found and the message was queued.
func (h *Hub) SendToUser(userID int64, msg []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	return c.trySendMsg(msg)
}

// SendToUserHigh sends a high-priority message to a specific user.
func (h *Hub) SendToUserHigh(userID int64, msg []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	c.sendHighMsg(msg)
	return true
}

// SendToUserLow sends a low-priority message to a specific user. Unlike
// SendToUserHigh, an overflow is silently dropped rather than disconnecting
// the client — the targeted-delivery sibling of BroadcastToAllLow /
// broadcastExcludeLow, for events (e.g. DM typing indicators) that need
// direct-to-user routing but are ephemeral and safely droppable (OC-0260).
func (h *Hub) SendToUserLow(userID int64, msg []byte) bool {
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	c.sendLowMsg(msg)
	return true
}

// BroadcastToAllLow enqueues a low-priority global broadcast.
// Low-priority messages are silently dropped if a client's buffer is full.
func (h *Hub) BroadcastToAllLow(msg []byte) {
	// Low-priority global broadcasts bypass the sequenced broadcast channel
	// and go directly through pub/sub — they don't need replay or seq numbering.
	h.pubsub.PublishGlobalLow(msg)
}

// sendSequencedToUsers stamps msg with a monotonic seq, stores it in the
// replay buffer under channelID, and fans the wrapped payload out to the
// provided users on the normal-priority queue.
//
// Sequenced frames must all share one per-client FIFO: writePump drains
// sendHigh before send, so a seq-stamped frame on the high queue would reach
// the socket ahead of lower-seq frames still queued in send. The client acks
// max(seq) and replay is strictly seq > last_seq, so a disconnect in that
// window would silently lose the overtaken events. The high queue remains for
// unsequenced targeted messages only.
func (h *Hub) sendSequencedToUsers(channelID int64, userIDs []int64, msg []byte) {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()

	if h.dropsForPurgedUser(msg) || h.dropsForPurgedMessage(msg) {
		return
	}
	seq := h.nextSeq()
	wrapped := wrapWithSeq(msg, seq)
	h.replayBuf.Push(seq, channelID, wrapped)
	h.persistEvent(seq, channelID, wrapped)

	for _, userID := range userIDs {
		h.SendToUser(userID, wrapped)
	}
}

// deliverBroadcast stamps bm.msg with a monotonic sequence number, stores it
// in the replay buffer, and sends it to the appropriate clients via pub/sub.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	if bm.barrier != nil {
		close(bm.barrier)
		return
	}
	// The channel-broadcast debug log is emitted after seqMu is released
	// (below) so a slow logging sink never extends the critical section that
	// serializes every broadcast.
	seq, delivered, channelSend := func() (seq uint64, delivered int, channelSend bool) {
		h.seqMu.Lock()
		defer h.seqMu.Unlock()

		// Channel-scoped sends consult the topic limiter BEFORE a seq is
		// allocated: a shed frame that consumed a seq would sit in the replay
		// buffer as a number no client ever saw live, and since clients ack
		// only max(seq), it could never be requested back.
		if bm.recipients == nil && bm.channelID != 0 {
			if !h.topicLimiter.Allow(ChannelTopic(bm.channelID)) {
				slog.Warn("hub: topic rate limit exceeded, dropping message",
					"channel_id", bm.channelID)
				return 0, 0, false
			}
		}

		// A frame naming an erased user, produced by a request that read
		// its rows before the erasure and reached the hub after the purge,
		// must not be sequenced: nothing it describes exists any more.
		if h.dropsForPurgedUser(bm.msg) || h.dropsForPurgedMessage(bm.msg) {
			return 0, 0, false
		}

		seq = h.nextSeq()
		msg := wrapWithSeq(bm.msg, seq)

		// Store in replay buffer for reconnection recovery.
		h.replayBuf.Push(seq, bm.channelID, msg)
		h.persistEvent(seq, bm.channelID, msg)

		// Fan out to plugins subscribed to this event type (Phase C Step 9).
		// Dispatch is a no-op in the default build; the wazero build calls into
		// the WASM module. Dispatch is called outside seqMu after we release it
		// conceptually — but since seqMu is still held here, the call MUST NOT
		// re-enter the hub. The default build is safe; the wazero build should
		// dispatch asynchronously once the runtime is real.
		if sink := h.pluginSink.Load(); sink != nil {
			eventType := extractEventType(msg)
			if eventType == "" {
				eventType = "broadcast"
			}
			sink.Dispatch(context.Background(), eventType, msg)
		}

		switch {
		case bm.recipients != nil:
			// Visibility-filtered fan-out: the audience was resolved by the caller.
			for _, userID := range bm.recipients {
				h.SendToUser(userID, msg)
			}
		case bm.channelID == 0:
			// Global broadcast — deliver to every connected client, minus
			// excludeUserID when the caller set one (see BroadcastToAllExcept).
			// Publish(TopicGlobal, msg, 0) is exactly PublishGlobal(msg) when
			// excludeUserID is the zero value, so ordinary BroadcastToAll
			// callers are unaffected.
			h.pubsub.Publish(TopicGlobal, msg, bm.excludeUserID)
		default:
			// Channel-scoped broadcast — deliver to subscribers of the channel
			// topic. The rate limiter already passed above, before the seq
			// was allocated.
			delivered = h.pubsub.Publish(ChannelTopic(bm.channelID), msg, 0)
			channelSend = true
		}
		return seq, delivered, channelSend
	}()

	// Instrumentation runs after seqMu is released: a metrics provider must
	// never extend the critical section that serializes every broadcast.
	// seq == 0 means the topic limiter shed the frame before delivery.
	if seq != 0 {
		m := telemetry.NewAppMetrics()
		m.WSMessagesTotal.Add(context.Background(), 1)
		if !bm.enqueuedAt.IsZero() {
			m.WSBroadcastLatency.Record(context.Background(), time.Since(bm.enqueuedAt).Seconds())
		}
	}

	if channelSend {
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "seq", seq)
	}
}
