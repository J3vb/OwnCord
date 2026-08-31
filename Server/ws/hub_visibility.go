package ws

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

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
	var ref permissions.ChannelRef
	if h.db != nil {
		ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
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
		if ch.Type == "dm" {
			return h.channelReadAudienceDM(ctx, channelID, userIDs)
		}
		ref = channelRef(ch)
		// CanViewChannel hides an archived channel from everyone, mirroring
		// RefreshChannelVisibility and VisibleChannelIDs: without that, an
		// admin edit to an archived channel (or a voice teardown inside one)
		// would fan out to every connected user whose base role holds
		// READ_MESSAGES, none of whom have the channel in their sidebar.
		// ignoreArchived resolves the pre-archival audience instead — see
		// channelReadAudienceIgnoringArchived.
		if ignoreArchived {
			ref.Archived = false
		}
	}

	// Resolved per USER, not memoised per role: channel_user_overrides is the
	// last layer of the resolution order, so two members of the same role can
	// legitimately disagree about one channel and a per-role memo would hand
	// one of them the other's verdict. The verdict is CanViewChannel over
	// subjectFor (cached service or live checker); an unresolvable user is
	// left out.
	audience := make([]int64, 0, len(userIDs))
	for _, uid := range userIDs {
		sub, err := h.subjectFor(ctx, uid, channelID)
		if err != nil {
			continue
		}
		sub.Channel = ref
		if permissions.CanViewChannel(sub) == nil {
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
	participantIDs, err := h.readers.Visibility.GetDMParticipantIDs(ctx, channelID)
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

	// Visibility is CanViewChannel — the single predicate shared with
	// buildReady / REST ListVisibleChannels — resolved per user from their
	// CURRENT role (c.user is a connect-time snapshot). With a
	// PermissionService the subject comes from the per-user cache — safe
	// because the admin handlers invalidate (InvalidateAll on override
	// change, InvalidateUser on role change) before calling into the hub, so
	// the lookups below repopulate from post-change data; the 30s TTL is only
	// a backstop and the F6 gen-counter guard keeps a racing populate from
	// caching stale rows. Without a service (bare test hubs) each client is
	// resolved live. Fails closed: an unresolvable role loses visibility
	// rather than keeping a stale grant.
	//
	// Deliberately NOT memoised per role: channel_user_overrides is the last
	// layer of the resolution order, so two members of the same role can
	// legitimately disagree about one channel — exactly the case a per-user
	// override edit creates, and exactly the fan-out this function targets.
	for _, c := range clients {
		if c.user == nil {
			continue
		}
		sub, err := h.subjectFor(ctx, c.user.ID, ch.ID)
		if err != nil {
			slog.Warn("hub: RefreshChannelVisibility could not resolve permissions, revoking",
				"user_id", c.user.ID, "channel_id", ch.ID, "err", err)
		}
		sub.Channel = channelRef(ch)
		visible := err == nil && permissions.CanViewChannel(sub) == nil

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
			live.sendMsg(buildChannelCreateFor(ch, h.refreshChannelVisibilityCanSend(ctx, ch, c.user.ID)))
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

// refreshChannelVisibilityCanSend is the can_send verdict the ready payload
// ships per channel (channelCanSend), recomputed for one live user from their
// CURRENT role: permissions.CanSendMessage over the subject subjectFor
// resolves in either the service or the bare-hub branch, failing closed on a
// lookup error (S-12).
//
// Without this, can_send is only ever computed at connect time, so a role
// edit or override edit leaves every connected client's composer stuck on
// its stale connect-time verdict until the socket is rebuilt.
func (h *Hub) refreshChannelVisibilityCanSend(ctx context.Context, ch *db.Channel, userID int64) bool {
	sub, err := h.subjectFor(ctx, userID, ch.ID)
	if err != nil {
		return false
	}
	sub.Channel = channelRef(ch)
	return permissions.CanSendMessage(sub) == nil
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
	channels, err := h.readers.Visibility.ListChannels(ctx)
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
	user, err := h.readers.Visibility.GetUserByID(ctx, userID)
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
		// Re-resolve before kicking: the lookups above are DB round trips a
		// reconnect can overlap, and kicking the stale snapshot would close a
		// dead socket while the replacement keeps its subscriptions.
		if live := h.GetClient(userID); live != nil {
			h.kickClient(live)
		}
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
		ch, chErr := h.readers.Visibility.GetChannel(ctx, chID)
		if chErr != nil {
			slog.Warn("hub: role change channel lookup failed, closing socket",
				"user_id", userID, "channel_id", chID, "err", chErr)
			if live := h.GetClient(userID); live != nil {
				h.kickClient(live)
			}
			return
		}
		if ch != nil && ch.Type == "dm" {
			continue
		}
		if revokeUnreadableChannelsPreActRaceHook != nil {
			revokeUnreadableChannelsPreActRaceHook(userID)
		}
		// Re-resolve the live client immediately before acting: the DB round
		// trips above (and computeAllowedChannels before the loop) give a
		// reconnect room to replace this user's *Client in h.clients. Acting
		// on the snapshot c would target the dead socket, and Unsubscribe
		// would no-op on unsubscribeLocked's identity guard — stranding the
		// replacement with the revoked topic (audit-2026-08-19 F-2; mirrors
		// RefreshChannelVisibility's live re-resolve). A nil result means the
		// user disconnected entirely; nothing left to revoke.
		live := h.GetClient(userID)
		if live == nil {
			return
		}
		live.sendMsg(buildChannelDelete(chID))
		h.pubsub.Unsubscribe(live, topic)
		live.mu.Lock()
		if live.channelID == chID {
			live.channelID = 0
		}
		live.mu.Unlock()
	}
}

// computeAllowedChannels returns the set of channel IDs a user may access,
// including both server channels (filtered by ReadMessages permission) and
// the user's open DM channels. The server-channel set comes from the single
// permissions.Checker predicate shared with buildReady and REST
// ListVisibleChannels, so replay-buffer filtering can never drift from the
// ready payload's visible channels.
func (h *Hub) computeAllowedChannels(ctx context.Context, database VisibilityReader, user *db.User) (map[int64]bool, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels ListChannels: %w", err)
	}

	role, err := database.GetRoleByID(ctx, user.RoleID)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetRoleByID: %w", err)
	}

	// Nil role = zero access (fail closed). Admins skip the override fetch.
	allowed := make(map[int64]bool)
	if role != nil {
		var overrides map[int64]db.ChannelOverride
		if !permissions.HasAdmin(role.Permissions) {
			overrides, err = database.GetChannelOverridesFor(ctx, role.ID, user.ID)
			if err != nil {
				return nil, fmt.Errorf("computeAllowedChannels GetChannelOverridesFor: %w", err)
			}
		}
		allowed = h.permChecker.VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
	}

	// Include the user's open DM channels. Only the ID set matters here, so
	// use the PK-covered dm_open_state lookup instead of the full DM query.
	// Fatal like the three sibling lookups above: a silently DM-stripped
	// replay advances the client's lastSeq past DM events it never received —
	// a permanent hole. The caller's error path falls back to full ready.
	dmIDs, dmErr := database.GetUserDMChannelIDs(ctx, user.ID)
	if dmErr != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetUserDMChannelIDs: %w", dmErr)
	}
	for _, id := range dmIDs {
		allowed[id] = true
	}

	return allowed, nil
}

// bumpVisibilityWatermark ratchets visibilityChangeSeq up to the current seq,
// never down. All three writers (RefreshChannelVisibility,
// revokeUnreadableChannels, DMChannelOpenEvent in emit.go) must go through
// this instead of a plain Store: a plain Store(Load(&h.seq)) lets a writer
// that read an older h.seq — e.g. one that spent time in a per-topic DB loop
// — finish and overwrite a concurrently stored higher watermark with its
// stale value, silently regressing the forced-full-resync boundary mustFullResync
// depends on being monotonic. Mirrors SeedSeq's CAS-max pattern.
func (h *Hub) bumpVisibilityWatermark() {
	for {
		cur := h.visibilityChangeSeq.Load()
		next := atomic.LoadUint64(&h.seq)
		if next <= cur {
			return
		}
		if h.visibilityChangeSeq.CompareAndSwap(cur, next) {
			return
		}
	}
}

// MarkVisibilityChanged bumps the visibility watermark. It is the exported
// entry point REST handlers (api.markDMVisibilityChanged, reached via a
// dmVisibilityMarker type assertion) use to force the same full-resync
// guarantee for an unsequenced, targeted DM event that the WS-side emitter of
// the same event (emit.go DMChannelOpenEvent) already gets via
// bumpVisibilityWatermark directly.
func (h *Hub) MarkVisibilityChanged() {
	h.bumpVisibilityWatermark()
}
