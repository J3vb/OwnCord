package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
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
	// A room's own participants must always receive its voice_state /
	// voice_leave: voice membership is gated on CONNECT_VOICE alone, so the
	// READ filter can exclude a live participant — whose client then keeps a
	// stale E2EE key holder, stalling rotation and locking new joiners out
	// until e2ee_timeout. Union the READ audience with the room's current
	// participants; what outsiders may observe is unchanged.
	audience := h.channelReadAudience(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience))
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	h.mu.RLock()
	for uid, c := range h.clients {
		if _, ok := seen[uid]; !ok && c.getVoiceChID() == channelID {
			audience = append(audience, uid)
		}
	}
	h.mu.RUnlock()
	h.broadcastChannelScopedTo(channelID, msg, audience, "voice event")
}

// broadcastVoiceEventWithLeaver is broadcastVoiceEvent extended to guarantee
// leaverID is in the audience even though the caller has already cleared
// their client-side voice state — which means broadcastVoiceEvent's own
// still-in-the-room participant union can no longer see them. Every path
// that tears down a voice participant whose client state is cleared before
// the voice_leave goes out needs this: voice membership is gated on
// CONNECT_VOICE alone, so a leaver without READ_MESSAGES on the channel
// would otherwise never learn the server already ended their call. Mirrors
// CleanupVoiceForChannel's per-batch leaver union, for the single-leaver case.
func (h *Hub) broadcastVoiceEventWithLeaver(ctx context.Context, channelID int64, msg []byte, leaverID int64) {
	audience := h.channelReadAudience(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience)+1)
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	h.mu.RLock()
	for uid, c := range h.clients {
		if _, ok := seen[uid]; !ok && c.getVoiceChID() == channelID {
			seen[uid] = struct{}{}
			audience = append(audience, uid)
		}
	}
	h.mu.RUnlock()
	if _, ok := seen[leaverID]; !ok {
		audience = append(audience, leaverID)
	}
	h.broadcastChannelScopedTo(channelID, msg, audience, "voice event")
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
	return h.channelReadAudienceImpl(ctx, channelID, false)
}

// channelReadAudienceIgnoringArchived is channelReadAudience without the
// Archived short-circuit (OC-0022). CleanupVoiceForChannel's only two
// callers (admin/handlers_channels.go's archive and delete paths) always
// commit archived=1 to the channel before evicting its voice participants —
// deliberately, per admin/api_test.go's
// TestAdminAPI_DeleteChannel_ArchivesBeforeVoiceCleanup, so a concurrent
// voice_join sees the archived gate. That means channelReadAudience's own
// Archived check, evaluated from CleanupVoiceForChannel, always sees the
// channel already archived and always returns nobody: the voice_leave that
// should tell every bystander who could see the room a moment ago that the
// call ended never reaches them, only the evicted participants themselves
// (added back by CleanupVoiceForChannel's own loop). This resolves that same
// pre-archival READ audience for exactly that one broadcast, leaving every
// other channelReadAudience call site (and its archived-channel behavior)
// untouched.
func (h *Hub) channelReadAudienceIgnoringArchived(ctx context.Context, channelID int64) []int64 {
	return h.channelReadAudienceImpl(ctx, channelID, true)
}

func (h *Hub) channelReadAudienceImpl(ctx context.Context, channelID int64, ignoreArchived bool) []int64 {
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
		// Fail closed on a missing row too (OC-0090): GetChannel returns
		// (nil, nil) for a deleted channel, and falling through would hand a
		// channel with no override rows left to the role scan below — which
		// resolves to every connected user with base READ_MESSAGES, leaking
		// e.g. a closed group-DM's voice_leave server-wide. Callers that
		// tear down voice union the room's participants and the leaver back
		// in afterwards, so eviction/E2EE-teardown signals still arrive.
		if ch == nil {
			return []int64{}
		}
		// Archived channels are hidden from every client regardless of
		// permissions, mirroring RefreshChannelVisibility and VisibleChannelIDs.
		// Without this, an admin edit to an archived channel (or a voice
		// teardown inside one) fans out straight to every connected user whose
		// base role holds READ_MESSAGES, none of whom have the channel in their
		// ready payload or sidebar. ignoreArchived opts a caller out of this
		// specific check only — see channelReadAudienceIgnoringArchived.
		if ch.Archived && !ignoreArchived {
			return []int64{}
		}
		if ch.Type == "dm" {
			return h.channelReadAudienceDM(ctx, channelID, userIDs)
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

// channelReadAudienceDM resolves the audience of a DM channel: the DM's
// participants, intersected with the connected userIDs. Split verbatim out of
// channelReadAudienceImpl; the reason a DM must not fall through to the role
// scan is on the call site.
func (h *Hub) channelReadAudienceDM(ctx context.Context, channelID int64, userIDs []int64) []int64 {
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

	// Bump the watermark immediately, before the h.clients snapshot below and
	// the (potentially slow — up to two DB round trips per connected client)
	// fan-out loop that follows it. A reconnect handshake re-checks this
	// watermark right before it registers (OC-0206); bumping only at the end,
	// after the loop, left a window where that re-check could still observe
	// the pre-change value even though this function's snapshot — taken next
	// — will never include a client that registers mid-loop. Ratcheted
	// upward only (see bumpVisibilityWatermark), so this is a no-op whenever
	// a concurrent writer already pushed the watermark higher; the trailing
	// bump below still runs and covers any change to h.seq made during the
	// loop itself.
	h.bumpVisibilityWatermark()

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

		if refreshChannelVisibilityRaceHook != nil {
			refreshChannelVisibilityRaceHook(c.user.ID)
		}

		// Re-resolve the live client immediately before acting: the permission
		// lookups above (a PermissionService call, or two DB round trips in the
		// bare-hub branch) give a reconnect room to replace this user's *Client
		// in h.clients with a new connection under the same user ID. Acting on
		// the stale snapshot pointer c would target a dead socket, and
		// Unsubscribe would be a no-op — unsubscribeLocked's identity guard
		// leaves a topic alone when the current holder differs from the client
		// passed in — stranding the replacement with a subscription (or a
		// missing one) exactly inverted from what this fan-out just decided.
		// A nil result means the user disconnected entirely since the
		// snapshot; nothing to act on.
		live := h.GetClient(c.user.ID)
		if live == nil {
			continue
		}

		if visible {
			// Idempotent add on the client; also refreshes channel metadata.
			// Addressed per client so it can carry this recipient's own
			// can_send verdict — the whole point of this fan-out is that a
			// permission change just made those verdicts diverge.
			live.sendMsg(buildChannelCreateFor(ch, h.refreshChannelVisibilityCanSend(ctx, ch, c.user.ID, c.user.RoleID)))
			continue
		}
		live.sendMsg(buildChannelDelete(ch.ID))
		h.pubsub.Unsubscribe(live, ChannelTopic(ch.ID))
		live.mu.Lock()
		if live.channelID == ch.ID {
			live.channelID = 0
		}
		live.mu.Unlock()
	}

	// Clients not connected right now missed the targeted sends above. Move
	// the watermark so any resume from a seq at or before this point is
	// forced onto the full-ready path instead of replay. Ratcheted upward
	// only — see bumpVisibilityWatermark — so a concurrent writer that read
	// an older seq cannot regress a watermark another writer already pushed
	// higher.
	h.bumpVisibilityWatermark()
}

// refreshChannelVisibilityCanSend mirrors channelCanSend (serve_ready.go) — the value the ready
// payload ships per channel — but expressed as per-user permission checks
// so it works in both the service and bare-hub branches without needing a
// resolved *db.Role. HasChannelPerm already bypasses for admins and fails
// closed on a lookup error, matching channelCanSend's own admin shortcut.
//
// Without this, can_send is only ever computed at connect time, so a role
// edit or override edit leaves every connected client's composer stuck on
// its stale connect-time verdict until the socket is rebuilt.
func (h *Hub) refreshChannelVisibilityCanSend(ctx context.Context, ch *db.Channel, userID, roleID int64) bool {
	has := func(perm int64) bool {
		if h.perms != nil {
			return h.perms.HasChannelPerm(ctx, userID, ch.ID, perm)
		}
		role, err := h.db.GetRoleByID(ctx, roleID)
		if err != nil || role == nil {
			return false
		}
		return h.permChecker.HasChannelPerm(ctx, role.Permissions, roleID, userID, ch.ID, perm)
	}
	if !has(permissions.ReadMessages) || !has(permissions.SendMessages) {
		return false
	}
	if ch.Type == "announcement" {
		return has(permissions.ManageMessages)
	}
	return true
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

// presenceCoalesceWindow is how long QueuePresence buffers connect/disconnect
// presence before flushing. Long enough to collapse a socket flap
// (disconnect+reconnect through a proxy blip) into one frame, short enough
// that a genuine arrival still looks immediate to humans.
const presenceCoalesceWindow = 300 * time.Millisecond

// pendingPresence is the coalescer's latest-wins entry for one user.
type pendingPresence struct {
	status       string
	customStatus *string
}

// QueuePresence coalesces connect/disconnect presence broadcasts: the latest
// state per user is buffered for presenceCoalesceWindow and then flushed via
// BroadcastPresence. Each un-coalesced presence change is a sequenced global
// broadcast — an O(connected clients) fan-out under seqMu — so a reconnect
// storm (proxy blip, deploy, network hiccup) used to fire O(users) of them
// from the connect critical path all at once. Latest-wins is exactly
// presence's semantics: a flap inside the window collapses to its final
// state, and the flushed frames are ordinary sequenced presence messages, so
// the wire format and replay behaviour are unchanged. User-chosen status
// changes (presence_update handler) do not pass through here.
func (h *Hub) QueuePresence(userID int64, status string, customStatus *string) {
	h.presenceMu.Lock()
	if h.presenceQueue == nil {
		h.presenceQueue = make(map[int64]pendingPresence)
	}
	h.presenceQueue[userID] = pendingPresence{status: status, customStatus: customStatus}
	armed := h.presenceFlushArmed
	h.presenceFlushArmed = true
	h.presenceMu.Unlock()
	if !armed {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// dropQueuedPresenceAndBroadcast atomically removes any coalesced presence
// still queued for userID and runs broadcast, both under presenceMu. Called
// when a fresher presence for that user is delivered directly (the
// presence_update handler path, via EmitEvents), so the delete and the send
// of the fresher frame can never straddle flushPresenceQueue's own
// snapshot-and-broadcast critical section (OC-0005).
//
// Holding presenceMu across the delete AND the broadcast — rather than just
// the delete — is what actually closes the race: whichever of this call and
// flushPresenceQueue acquires presenceMu second also enqueues its broadcast
// second.
//   - If this call goes first, it deletes the entry before flush can ever
//     snapshot it, so flush never broadcasts the stale state at all.
//   - If flush goes first, this call's delete is a no-op against the
//     already-cleared queue, but its broadcast still cannot run until flush's
//     own broadcast has already been enqueued — so the fresher frame is
//     stamped with the higher seq by deliverBroadcast's single FIFO consumer
//     and every client's final view converges on it, not the stale one.
//
// broadcast runs with presenceMu held: every current caller (BroadcastToAll,
// BroadcastToAllExcept) only enqueues onto h.broadcast's non-blocking
// channel send, so this cannot block and introduces no new lock-order edge.
// Both callers sharing that same channel also means the "enqueues second"
// ordering guarantee above translates directly into delivery order: both
// broadcasts are drained by the same single-consumer hub dispatch loop
// (deliverBroadcast), in the order they were enqueued.
func (h *Hub) dropQueuedPresenceAndBroadcast(userID int64, broadcast func()) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	delete(h.presenceQueue, userID)
	broadcast()
}

// presenceFlushRaceHook, when non-nil, runs once per flushPresenceQueue call
// immediately after the coalesced queue has been snapshotted and cleared,
// while presenceMu is still held. Test-only (always nil in production): the
// snapshot-to-broadcast window is too narrow to land a real concurrent
// dropQueuedPresenceAndBroadcast reliably, so tests use this hook to
// reproduce that interleaving deterministically. Mirrors the established
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern.
var presenceFlushRaceHook func()

// flushPresenceQueue drains the coalescer and broadcasts each user's latest
// presence, all under presenceMu (OC-0005). Runs on the AfterFunc timer
// goroutine.
//
// presenceMu is held across the broadcast loop, not just the snapshot: it
// used to be released beforehand, which let a concurrent
// dropQueuedPresenceAndBroadcast (nee dropQueuedPresence) call race in after
// the snapshot had already escaped the lock. The drop was then a guaranteed
// no-op against the live (already-nilled) map, AND nothing constrained
// whether that call's own fresher broadcast landed on h.broadcast before or
// after this loop's stale one — so the stale connect-time presence could win
// the seq race and permanently overwrite a user-chosen status. Holding the
// lock here forces the two critical sections to serialize, which is what
// dropQueuedPresenceAndBroadcast's ordering guarantee depends on.
func (h *Hub) flushPresenceQueue() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	queued := h.presenceQueue
	h.presenceQueue = nil
	h.presenceFlushArmed = false
	if presenceFlushRaceHook != nil {
		presenceFlushRaceHook()
	}
	for uid, p := range queued {
		h.BroadcastPresence(uid, p.status, p.customStatus)
	}
}

// BroadcastPresence fans a presence change out with the invisible mapping
// applied: everyone else sees db.BroadcastStatus(status), the user themselves
// sees the truth. It is the non-handler counterpart of presenceEvents, used by
// the connect and disconnect paths (via the QueuePresence coalescer, which
// delivers through here).
func (h *Hub) BroadcastPresence(userID int64, status string, customStatus *string) {
	public := db.BroadcastStatus(status)
	if public == status {
		h.BroadcastToAll(buildPresenceMsg(userID, status, customStatus))
		return
	}
	// The public frame's status already collapsed to db.BroadcastStatus, but
	// customStatus does not: passing it through verbatim would tell every
	// other client an "offline" member's real free-text status, which is a
	// tell that they are actually online. Blank it explicitly (not omitted —
	// presencePayload.CustomStatus has no omitempty) so the client clears any
	// cached text, matching what db.MemberSummary.ForViewer already does for
	// the ready payload's member list.
	//
	// Normal priority, excluding the owner (BroadcastToAllExcept), not
	// broadcastExcludeLow: the low-priority queue is unsequenced and dropped
	// (not disconnected) on overflow, so it could silently lose this frame
	// with no replay recovery, and — since writePump always drains normal
	// strictly before low — deliver it out of order against the very
	// connect/disconnect presence frames this same coalescer flush also
	// produces for other users via BroadcastToAll (OC-0003).
	h.BroadcastToAllExcept(userID, buildPresenceMsg(userID, public, nil))
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
	// Ratcheted upward only (see bumpVisibilityWatermark), and evaluated at
	// defer-RUN time — not the plain Store(Load(&h.seq)) this used to be,
	// whose argument would have been evaluated at this defer STATEMENT,
	// capturing entry-time seq and stomping any higher watermark stored by a
	// concurrent writer during the per-topic DB loop below. Deferred because
	// it must cover the early returns too: a user who is offline, or whose
	// socket is closed below, converges via the full-ready path.
	defer h.bumpVisibilityWatermark()

	// Also bump immediately, before the h.clients lookup below and the
	// per-topic DB loop (a GetChannel round trip per revoked topic) that
	// follows it — see RefreshChannelVisibility's matching early bump and
	// OC-0206. Ratcheted upward only, so this is a no-op whenever a
	// concurrent writer already pushed the watermark higher; the deferred
	// bump above still covers every return path, including the early ones.
	h.bumpVisibilityWatermark()

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
