package ws

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
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
}

// BroadcastToChannel enqueues msg for delivery to all clients subscribed to
// channelID. When channelID is 0 the message is sent to every connected client.
// Non-blocking: if the broadcast channel is full the message is dropped with a warning.
func (h *Hub) BroadcastToChannel(channelID int64, msg []byte) {
	select {
	case h.broadcast <- broadcastMsg{channelID: channelID, msg: msg}:
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
	case h.broadcast <- broadcastMsg{channelID: 0, msg: msg}:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping global message",
			"msg_len", len(msg))
	}
}

// broadcastVoiceEvent enqueues a voice_state / voice_leave message for the
// connected clients whose current role may READ channelID.
//
// These events used to go out via BroadcastToAll, which handed every
// authenticated client the membership and camera/mute state of voice channels
// that channel_overrides hides from their role — while the equivalent read path
// (buildReady) deliberately filters voice states to readable channels. Tagging
// the event with its real channel id also makes reconnect replay filter it,
// where a channelID of 0 was replayed unconditionally.
//
// The audience is resolved here, on the caller's goroutine, so the hub's
// dispatch loop never blocks on permission lookups.
func (h *Hub) broadcastVoiceEvent(ctx context.Context, channelID int64, msg []byte) {
	h.broadcastChannelScoped(ctx, channelID, msg, "voice event")
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
	}
	select {
	case h.broadcast <- bm:
	default:
		h.broadcastDrops.Add(1)
		slog.Warn("hub: broadcast channel full, dropping "+kind,
			"channel_id", channelID, "msg_len", len(msg))
	}
}

// channelReadAudience returns the connected user IDs whose current role may READ
// channelID. Always non-nil, so an empty result means "deliver to nobody"
// rather than "no filter". Each user's verdict comes from the cached
// PermissionService when the hub has one (one in-memory lookup per connected
// user; a miss repopulates from the user's CURRENT role, so a mid-session
// reassignment is still honored). Caching is safe here because revocation is
// delivered synchronously at every mutation site: a role change calls
// InvalidateUser (admin/handlers_users.go) and a channel-override change calls
// InvalidateAll (admin/handlers_channel_perms.go) before the hub fan-out runs,
// with the 30s cache TTL as a backstop; the F6 gen-counter guard in the service
// prevents a populate racing an invalidation from caching stale data. Fails
// closed: a client whose role cannot be resolved is left out. Bare test hubs
// without a service fall back to live per-call lookups, memoised for the
// duration of the call. Mirrors RefreshChannelVisibility, which resolves
// visibility the same way.
func (h *Hub) channelReadAudience(ctx context.Context, channelID int64) []int64 {
	h.mu.RLock()
	userIDs := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		userIDs = append(userIDs, uid)
	}
	h.mu.RUnlock()

	// A DM channel carries no channel_overrides rows, so every connected
	// user whose base role holds READ_MESSAGES would otherwise pass the role
	// scan below — leaking a private DM call's voice_state/voice_leave
	// events to the whole server. Resolve the DM's real audience (its
	// participants, intersected with who is actually connected) instead,
	// mirroring the IsDMParticipant membership rule hasChannelAccess uses.
	if h.db != nil {
		ch, err := h.db.GetChannel(ctx, channelID)
		if err != nil {
			// Fail closed: an unresolvable channel must not fall through to
			// the role scan, which would treat it as a readable non-DM channel.
			slog.Error("ws: channelReadAudience GetChannel failed, denying",
				"channel_id", channelID, "err", err)
			return []int64{}
		}
		if ch != nil && ch.Type == "dm" {
			participantIDs, err := h.db.GetDMParticipantIDs(ctx, channelID)
			if err != nil {
				slog.Error("ws: channelReadAudience GetDMParticipantIDs failed, denying",
					"channel_id", channelID, "err", err)
				return []int64{}
			}
			connected := make(map[int64]struct{}, len(userIDs))
			for _, uid := range userIDs {
				connected[uid] = struct{}{}
			}
			audience := make([]int64, 0, len(participantIDs))
			for _, uid := range participantIDs {
				if _, ok := connected[uid]; ok {
					audience = append(audience, uid)
				}
			}
			return audience
		}
	}

	audience := make([]int64, 0, len(userIDs))
	if h.perms != nil {
		for _, uid := range userIDs {
			if h.perms.HasChannelPerm(ctx, uid, channelID, permissions.ReadMessages) {
				audience = append(audience, uid)
			}
		}
		return audience
	}
	if h.db == nil || h.permChecker == nil {
		return audience
	}
	// Resolved per USER, not memoised per role: channel_user_overrides is the
	// last layer of the resolution order, so two members of the same role can
	// legitimately disagree about one channel and a per-role memo would hand
	// one of them the other's verdict.
	for _, uid := range userIDs {
		role, err := h.db.GetRoleForUser(ctx, uid)
		if err != nil || role == nil {
			continue
		}
		if h.permChecker.HasChannelPerm(ctx, role.Permissions, role.ID, uid, channelID, permissions.ReadMessages) {
			audience = append(audience, uid)
		}
	}
	return audience
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

// RefreshChannelVisibility re-evaluates which connected clients may see ch
// after a channel_overrides change and sends targeted channel_create /
// channel_delete messages so sidebars converge without a reconnect. Clients
// that lose visibility are also unsubscribed from the channel topic and have
// their focused channel cleared so live messages stop flowing.
//
// The sends deliberately bypass the sequenced broadcast/replay path: a
// replayed channel_delete would be filtered by the allowed-channel set
// computed at replay time, which after an override change is exactly the
// inverse of the intended audience. Clients tolerate seq-less messages.
func (h *Hub) RefreshChannelVisibility(ch *db.Channel) {
	if ch == nil {
		return
	}

	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	// Called via the admin HubBroadcaster interface, which carries no context;
	// the targeted re-sync must complete regardless of the triggering request.
	ctx := context.Background()

	// Visibility is resolved per user. With a PermissionService it comes from
	// the per-user cache — safe because the admin handlers invalidate
	// (InvalidateAll on override change, InvalidateUser on role change) before
	// calling into the hub, so the lookups below repopulate from post-change
	// data; the 30s TTL is only a backstop and the F6 gen-counter guard keeps
	// a racing populate from caching stale rows. Without a service (bare test
	// hubs) each client is resolved live.
	//
	// Deliberately NOT memoised per role: channel_user_overrides is the last
	// layer of the resolution order, so two members of the same role can
	// legitimately disagree about one channel — exactly the case a per-user
	// override edit creates, and exactly the fan-out this function targets.
	userVisible := func(userID, roleID int64) bool {
		role, err := h.db.GetRoleByID(ctx, roleID)
		if err != nil || role == nil {
			return false
		}
		// Single visibility predicate shared with buildReady / REST
		// ListVisibleChannels; the checker fails closed on a lookup error
		// and bypasses for admins, matching the other sites exactly.
		return h.permChecker.HasChannelPerm(ctx, role.Permissions, roleID, userID, ch.ID, permissions.ReadMessages)
	}

	for _, c := range clients {
		if c.user == nil {
			continue
		}
		var visible bool
		switch {
		case ch.Archived:
			// Archived channels are hidden from every client regardless of
			// permissions, mirroring VisibleChannelIDs.
			visible = false
		case h.perms != nil:
			// The service resolves the user's CURRENT role internally (c.user
			// is a connect-time snapshot), failing closed — an unresolvable
			// role loses visibility rather than keeping a stale grant.
			visible = h.perms.HasChannelPerm(ctx, c.user.ID, ch.ID, permissions.ReadMessages)
		default:
			// c.user is a connect-time snapshot; an admin may have changed the
			// user's role mid-session, so resolve the current role from the DB.
			// Fail closed: on error send nothing rather than mis-target.
			fresh, err := h.db.GetUserByID(ctx, c.user.ID)
			if err != nil || fresh == nil {
				slog.Warn("hub: RefreshChannelVisibility could not resolve user role",
					"user_id", c.user.ID, "err", err)
				continue
			}
			visible = userVisible(fresh.ID, fresh.RoleID)
		}
		if visible {
			// Idempotent add on the client; also refreshes channel metadata.
			c.sendMsg(buildChannelCreate(ch))
			continue
		}
		c.sendMsg(buildChannelDelete(ch.ID))
		h.pubsub.Unsubscribe(c, ChannelTopic(ch.ID))
		c.mu.Lock()
		if c.channelID == ch.ID {
			c.channelID = 0
		}
		c.mu.Unlock()
	}

	// Clients not connected right now missed the targeted sends above. Move
	// the watermark so any resume from a seq at or before this point is
	// forced onto the full-ready path instead of replay (stored after the
	// sends so a concurrent seq advance errs toward re-syncing more clients).
	h.visibilityChangeSeq.Store(atomic.LoadUint64(&h.seq))
}

// RefreshAllChannelVisibility re-runs RefreshChannelVisibility for every
// non-DM channel. A role's permission mask is the base every channel's
// effective permission is computed from, so editing or deleting a role can
// change visibility of *any* channel at once — where a channel_overrides edit
// touches exactly one. DM channels are skipped: their access is participant-
// based and no role change can alter it.
//
// Called via the admin HubBroadcaster interface (no context), so the channel
// list is read against Background — the re-sync must complete regardless of the
// triggering request. The caller invalidates the permission cache first, as the
// channel-override handlers do, so the per-client lookups below repopulate from
// post-change data.
func (h *Hub) RefreshAllChannelVisibility() {
	if h.db == nil {
		return
	}
	ctx := context.Background()
	channels, err := h.db.ListChannels(ctx)
	if err != nil {
		slog.Warn("hub: RefreshAllChannelVisibility could not list channels", "err", err)
		return
	}
	for i := range channels {
		if channels[i].Type == "dm" {
			continue
		}
		h.RefreshChannelVisibility(&channels[i])
	}
}

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

// BroadcastUserUpdate sends a user_update message to all connected clients
// when a user changes their profile (username, avatar, display name, about,
// identity key).
func (h *Hub) BroadcastUserUpdate(u UserUpdate) {
	h.BroadcastToAll(buildUserUpdate(u))
}

// BroadcastPresence fans a presence change out with the invisible mapping
// applied: everyone else sees db.BroadcastStatus(status), the user themselves
// sees the truth. It is the non-handler counterpart of presenceEvents, used by
// the connect and disconnect paths which write to the hub directly.
func (h *Hub) BroadcastPresence(userID int64, status string, customStatus *string) {
	public := db.BroadcastStatus(status)
	if public == status {
		h.BroadcastToAll(buildPresenceMsg(userID, status, customStatus))
		return
	}
	h.broadcastExcludeLow(0, userID, buildPresenceMsg(userID, public, customStatus))
	h.SendToUser(userID, buildPresenceMsg(userID, status, customStatus))
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
func (h *Hub) revokeUnreadableChannels(userID int64) {
	// Stored after the targeted sends (as in RefreshChannelVisibility) so a
	// concurrent seq advance errs toward re-syncing more clients. Deferred
	// because it must cover the early returns too: a user who is offline, or
	// whose socket is closed below, converges via the full-ready path.
	defer h.visibilityChangeSeq.Store(atomic.LoadUint64(&h.seq))

	if h.db == nil {
		return
	}
	h.mu.RLock()
	c, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok || c.user == nil {
		return
	}

	// Called via the admin HubBroadcaster interface, which carries no context;
	// the re-evaluation must complete regardless of the triggering request.
	ctx := context.Background()

	// c.user is a connect-time snapshot and the role just changed, so resolve
	// the current user — and through it the current role — from the DB.
	var allowed map[int64]bool
	user, err := h.db.GetUserByID(ctx, userID)
	if err == nil && user != nil {
		// Same predicate as the ready payload and reconnect replay filtering.
		allowed, err = h.computeAllowedChannels(ctx, h.db, user)
	}
	if err != nil || user == nil {
		// Visibility unresolved. Keeping the old subscriptions would leak, and
		// revoking them all would hollow out a sidebar the user may still be
		// entitled to, so close the socket instead: the client reconnects and
		// rebuilds from a ready payload computed with the new role. kickClient
		// rather than DisconnectUser — the latter sends a BANNED error, which
		// makes the client clear its credentials instead of reconnecting.
		slog.Warn("hub: role change visibility unresolved, closing socket",
			"user_id", userID, "err", err)
		h.kickClient(c)
		return
	}

	for _, topic := range h.pubsub.TopicsForClient(userID) {
		chID := channelTopicID(topic)
		if chID == 0 || allowed[chID] {
			continue
		}
		// DM access is gated on dm_participants, which no role change can
		// alter, while allowed sources DMs from dm_open_state — a DM the user
		// has closed (or every DM, if the DM lookup inside
		// computeAllowedChannels failed) is missing from allowed even though
		// its subscription is still legitimate. Never revoke a DM topic here;
		// on a lookup error close the socket rather than guess.
		ch, chErr := h.db.GetChannel(ctx, chID)
		if chErr != nil {
			slog.Warn("hub: role change channel lookup failed, closing socket",
				"user_id", userID, "channel_id", chID, "err", chErr)
			h.kickClient(c)
			return
		}
		if ch != nil && ch.Type == "dm" {
			continue
		}
		c.sendMsg(buildChannelDelete(chID))
		h.pubsub.Unsubscribe(c, topic)
		c.mu.Lock()
		if c.channelID == chID {
			c.channelID = 0
		}
		c.mu.Unlock()
	}
}

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

// BroadcastToAllLow enqueues a low-priority global broadcast.
// Low-priority messages are silently dropped if a client's buffer is full.
func (h *Hub) BroadcastToAllLow(msg []byte) {
	// Low-priority global broadcasts bypass the sequenced broadcast channel
	// and go directly through pub/sub — they don't need replay or seq numbering.
	h.pubsub.PublishGlobalLow(msg)
}

// sendSequencedToUsersHigh stamps msg with a monotonic seq, stores it in the
// replay buffer under channelID, and fans the wrapped payload out to the
// provided users with high-priority delivery.
func (h *Hub) sendSequencedToUsersHigh(channelID int64, userIDs []int64, msg []byte) {
	h.seqMu.Lock()
	defer h.seqMu.Unlock()

	seq := h.nextSeq()
	wrapped := wrapWithSeq(msg, seq)
	h.replayBuf.Push(seq, channelID, wrapped)
	h.persistEvent(seq, channelID, wrapped)

	for _, userID := range userIDs {
		h.SendToUserHigh(userID, wrapped)
	}
}

// deliverBroadcast stamps bm.msg with a monotonic sequence number, stores it
// in the replay buffer, and sends it to the appropriate clients via pub/sub.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	// The channel-broadcast debug log is emitted after seqMu is released
	// (below) so a slow logging sink never extends the critical section that
	// serializes every broadcast.
	seq, delivered, channelSend := func() (seq uint64, delivered int, channelSend bool) {
		h.seqMu.Lock()
		defer h.seqMu.Unlock()

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
			// Global broadcast — deliver to every connected client.
			h.pubsub.PublishGlobal(msg)
		default:
			// Channel-scoped broadcast — deliver to subscribers of the channel topic.
			topic := ChannelTopic(bm.channelID)
			if !h.topicLimiter.Allow(topic) {
				slog.Warn("hub: topic rate limit exceeded, dropping message",
					"channel_id", bm.channelID, "seq", seq)
				return seq, 0, false
			}
			delivered = h.pubsub.Publish(topic, msg, 0)
			channelSend = true
		}
		return seq, delivered, channelSend
	}()

	if channelSend {
		slog.Debug("hub: channel broadcast",
			"channel_id", bm.channelID, "delivered", delivered, "seq", seq)
	}
}
