package ws

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

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
// Archived short-circuit. CleanupVoiceForChannel's only two
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
	var ch *db.Channel
	if h.db != nil {
		var err error
		ch, err = h.readers.Visibility.GetChannel(ctx, channelID)
		if err != nil {
			// Fail closed: an unresolvable channel must not fall through to
			// the role scan, which would treat it as a readable non-DM channel.
			slog.Error("ws: channelReadAudience GetChannel failed, denying",
				"channel_id", channelID, "err", err)
			return []int64{}
		}
		// Fail closed on a missing row too: GetChannel returns
		// (nil, nil) for a deleted channel, and falling through would hand a
		// channel with no override rows left to the role scan below — which
		// resolves to every connected user with base READ_MESSAGES, leaking
		// e.g. a closed group-DM's voice_leave server-wide. Callers that
		// tear down voice union the room's participants and the leaver back
		// in afterwards, so eviction/E2EE-teardown signals still arrive.
		if ch == nil {
			return []int64{}
		}
	}
	return h.channelReadAudienceFor(ctx, channelID, ch, ignoreArchived)
}

// channelReadAudienceFor is channelReadAudienceImpl over a channel row the
// caller already read, so a caller that also needs the row (the channel_activity
// flush reads its type and NSFW label) pays one GetChannel for both. A nil ch is
// the bare test hub with no database: the role scan runs without a channel ref.
func (h *Hub) channelReadAudienceFor(ctx context.Context, channelID int64, ch *db.Channel, ignoreArchived bool) []int64 {
	h.mu.RLock()
	userIDs := h.connectedUserIDsLocked()
	h.mu.RUnlock()

	// A DM channel carries no channel_overrides rows, so every connected
	// user whose base role holds READ_MESSAGES would otherwise pass the role
	// scan below — leaking a private DM call's voice_state/voice_leave
	// events to the whole server. Resolve the DM's real audience (its
	// participants, intersected with who is actually connected) instead,
	// mirroring the IsDMParticipant membership rule hasChannelAccess uses.
	var ref permissions.ChannelRef
	if ch != nil {
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

// channelNSFWFilter is deliverBroadcast's NSFW content gate for a content-bearing
// kind (chat_message, chat_edited, reaction_update, plugin_broadcast — see
// contentBearingKinds): who among a channel's CURRENT topic subscribers may
// receive it. Called on the dispatch goroutine at the head of the broadcast
// queue, immediately before seqMu is taken — not by the enqueueing caller, so
// the label and the acknowledgements it reads are the ones in force when the
// event is dispatched rather than when it was queued.
//
// Deliberately does NOT resolve a candidate list itself — unlike
// channelReadAudienceImpl, which is used for direct-recipient delivery of
// low-frequency metadata (channel_create/update), content stays on the
// ordinary topic-Publish path (PublishFiltered) so it keeps that path's
// existing guarantees: the topic limiter runs first, and the subscriber list
// is read fresh at delivery time, under the same seqMu section that
// serializes against a concurrent reconnect's registration (a
// precomputed recipient list evaluated before that lock would go stale
// exactly in the reconnect window, and would skip the limiter entirely).
//
// allow is nil for a CONFIRMED unlabelled channel (Publish, unfiltered —
// unlabelled channels pay nothing beyond this one GetChannel read);
// otherwise it checks membership in ONE batch ListNSFWAcknowledgedUserIDs
// query, taken only because the channel is actually labelled — or, on a
// lookup failure that leaves the label unconfirmed, denies every recipient
// rather than defaulting to nil/unfiltered. labelled also gates the plugin
// sink (a plugin has no acknowledgement, so it never receives a
// labelled channel's content). unconfirmed reports that a read failed and
// the deny-all filter stands in for an answer: subscribers who may well
// have been allowed get nothing live, so deliverBroadcast forces their
// resume onto the full-ready path.
func (h *Hub) channelNSFWFilter(ctx context.Context, channelID int64) (allow func(userID int64) bool, labelled, unconfirmed bool) {
	if h.db == nil {
		return nil, false, false
	}
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		// The label is UNKNOWN, not "not labelled".
		// A nil allow means "unfiltered" to deliverBroadcast — that would
		// leak the frame to every topic subscriber, unacknowledged or not,
		// which is exactly the disclosure the plugin-sink rule exists to prevent when
		// the label itself cannot even be confirmed off. Fail closed for
		// BOTH the socket path (deny-all filter, not nil) and the plugin
		// sink (labelled=true).
		if err != nil {
			slog.Error("ws: channelNSFWFilter GetChannel failed, denying all recipients",
				"channel_id", channelID, "err", err)
		}
		return func(int64) bool { return false }, true, err != nil
	}
	if !ch.NSFW {
		return nil, false, false
	}
	ids, err := h.readers.Visibility.ListNSFWAcknowledgedUserIDs(ctx, channelID)
	if err != nil {
		slog.Error("ws: channelNSFWFilter ListNSFWAcknowledgedUserIDs failed, denying",
			"channel_id", channelID, "err", err)
		return func(int64) bool { return false }, true, true // fail closed
	}
	ackSet := make(map[int64]bool, len(ids))
	for _, id := range ids {
		ackSet[id] = true
	}
	return func(uid int64) bool { return ackSet[uid] }, true, false
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

	// The sends below are unsequenced and walk a snapshot taken next, so a
	// reconnect that registers mid-loop is skipped by it, and its last_seq can
	// sit above any single leading watermark bump. begin/endTargetedFanout
	// force every reconnect during the loop onto a full ready, and the bump in
	// endTargetedFanout covers any resume after it.
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	h.mu.RLock()
	clients := h.allClientsLocked()
	h.mu.RUnlock()

	// Called via the admin HubBroadcaster interface, which carries no context;
	// the targeted re-sync must complete regardless of the triggering request.
	ctx := context.Background()
	// Channel-level, so read once for every recipient of this fan-out.
	private := h.channelIsPrivate(ctx, ch.ID, ch.Type)

	// Visibility is CanViewChannel — the single predicate shared with
	// buildReady / REST ListVisibleChannels — resolved per user from their
	// CURRENT role (c.user is a connect-time snapshot). With a
	// PermissionService the subject comes from the per-user cache — safe
	// because the role, channel and moderation services invalidate the
	// affected users (InvalidateAll when that list is unreadable) before
	// calling into the hub, so
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
		// A nil result means that device disconnected entirely since the
		// snapshot; nothing to act on. The user's other devices are separate
		// entries of the snapshot, each judged here on its own.
		live := h.sessionClient(c.user.ID, c.tokenHash)
		if live == nil {
			continue
		}

		if visible {
			// A socket without the forums feature is sent no forum row
			// (client_features.go). Nothing is allocated for the skipped send:
			// this frame is per recipient and unsequenced.
			if !live.sendsChannel(ch.Type) {
				continue
			}
			// Idempotent add on the client; also refreshes channel metadata.
			// Addressed per client so it can carry this recipient's own
			// affordance verdicts — the whole point of this fan-out is that
			// a permission change just made those verdicts diverge.
			live.sendMsg(buildChannelCreateFor(ch, private, h.refreshChannelVisibilityAffordances(ctx, ch, c.user.ID)))
			continue
		}
		live.sendMsg(buildChannelDelete(ch.ID))
		h.pubsub.Unsubscribe(live, ChannelTopic(ch.ID))
		live.mu.Lock()
		if live.channelID == ch.ID {
			live.channelID = 0
		}
		live.mu.Unlock()
		h.revokeHeldThread(ctx, live, ch.ID)
	}
}

// refreshChannelVisibilityAffordances is the five affordance verdicts the
// ready payload ships per channel (affordancesFor), recomputed for one live
// user from their CURRENT role over the one subject subjectFor resolves in
// either the service or the bare-hub branch. A lookup error returns the zero
// value, which fails closed.
//
// Without this, they are only ever computed at connect time, so a role edit
// or override edit leaves every connected client's composer, voice, delete,
// pin and reaction controls stuck on their stale connect-time verdicts until
// the socket is rebuilt.
func (h *Hub) refreshChannelVisibilityAffordances(ctx context.Context, ch *db.Channel, userID int64) channelAffordances {
	sub, err := h.subjectFor(ctx, userID, ch.ID)
	if err != nil {
		return channelAffordances{}
	}
	sub.Channel = channelRef(ch)
	return affordancesFor(sub)
}

// RefreshAllChannelVisibility re-derives, for every connected user, which
// non-DM channels they may see: held topics are revoked first, then each user
// gets a channel_create (with their own affordances) or channel_delete per
// channel. A role's permission mask is the base every channel's effective
// permission is computed from, so editing or deleting a role can change
// visibility of *any* channel at once — where a channel_overrides edit touches
// exactly one. DM channels are skipped: their access is participant-based and
// no role change can alter it.
//
// Synchronous, against Background. The caller invalidates the permission cache
// first, so the per-user lookups repopulate from post-change data.
func (h *Hub) RefreshAllChannelVisibility() {
	// The same per-user step the role-refresh worker runs (role_refresh_round.go),
	// over every connected user and synchronously. Admin role handlers no
	// longer call it; they enqueue (EnqueueRoleRefresh).
	ctx := context.Background()
	h.refreshVisibilityUsers(ctx, h.connectedUserIDs(), nil)
	h.refreshTimeoutViewsFor(ctx, nil)
}

func (h *Hub) revokeUnreadableChannels(userID int64) {
	// The channel_delete frames revokeTopicsNotIn sends are unsequenced, so
	// bracket the whole pass like RefreshChannelVisibility: a reconnect during
	// it goes to a full ready, and endTargetedFanout's bump covers every
	// return path, including the early ones (offline user, closed socket).
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	if h.db == nil {
		return
	}
	if conns := h.clientsOf(userID); len(conns) == 0 || conns[0].user == nil {
		return
	}

	// Called via the admin HubBroadcaster interface, which carries no context;
	// the re-evaluation must complete regardless of the triggering request.
	ctx, cancel := context.WithTimeout(context.Background(), roleRefreshUserBudget)
	defer cancel()

	// c.user is a connect-time snapshot and the role just changed, so resolve
	// the current user — and through it the current role — from the DB.
	var allowed map[int64]bool
	user, err := h.readers.Visibility.GetUserByID(ctx, userID)
	if err == nil && user != nil {
		// Same predicate as the ready payload and reconnect replay filtering.
		allowed, err = h.computeAllowedChannels(ctx, h.readers.Visibility, user)
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
		for _, live := range h.clientsOf(userID) {
			h.kickClient(live)
		}
		return
	}

	_, _ = h.revokeTopicsNotIn(ctx, userID, allowed, nil)
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

	roles, err := database.GetMemberRoles(ctx, user.ID)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetMemberRoles: %w", err)
	}

	// No role = zero access (fail closed). Admins skip the override fetch.
	allowed := make(map[int64]bool)
	if roles != nil {
		grants := permissions.MemberGrants{Perms: roles.Perms}
		if !permissions.HasAdmin(roles.Perms) {
			grants, err = database.GetMemberGrants(ctx, user.ID)
			if err != nil {
				return nil, fmt.Errorf("computeAllowedChannels GetMemberGrants: %w", err)
			}
			grants.Perms = roles.Perms
		}
		allowed = h.permChecker.VisibleChannelIDs(grants, channelRefs(channels))
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
	// The thread the user's socket has open rides its parent's visibility.
	if err := h.admitHeldThread(ctx, database, user.ID, allowed); err != nil {
		return nil, err
	}

	return allowed, nil
}

// bumpVisibilityWatermark ratchets visibilityChangeSeq up to the current seq,
// never down. Every writer (RefreshChannelVisibility,
// revokeUnreadableChannels, DMChannelOpenEvent in emit.go, and the
// content-shed paths in hub_stats.go) must go through
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
//
// Takes h.seqMu — the SAME lock reconnectRegister
// (replay.go) holds across its own check-then-register — rather than
// bumping via the internal, lock-free bumpVisibilityWatermark other callers
// use (RefreshChannelVisibility, revokeUnreadableChannels, emit.go's
// DMChannelOpenEvent branch already have their own, separately-tested
// timing guarantees; this entry point is the one api/nsfw_handler.go and
// api/dm_handler.go's broadcastDMOpen reach, and it is the one that raced
// reconnectRegister's window). A call landing strictly between
// reconnectRegister's watermark re-check and its registerNow can no longer
// happen: it either completes, and is visible to that check, before
// reconnectRegister's critical section starts, or it blocks until that
// section ends — by which point the socket is already registered, so
// whatever the caller sends right after this call (notifyNSFWAck,
// broadcastDMOpen's SendToUser loop) reaches it directly instead of missing
// a not-yet-registered client. Do not call this while already holding
// seqMu — nothing in the hub's own broadcast/purge/reconnect paths does.
func (h *Hub) MarkVisibilityChanged() {
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)
	h.bumpVisibilityWatermark()
}

// roleChannel is one non-DM channel and its channel-level private flag, read
// once per round for every user (the role refresh round).
type roleChannel struct {
	ch      *db.Channel
	private bool
}
