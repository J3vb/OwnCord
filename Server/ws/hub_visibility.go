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
// channelID. Always non-nil: empty means deliver to nobody, not "no filter".
// Verdicts come from the cached PermissionService when present (a miss
// repopulates from the user's current role). Caching is safe because every
// mutation site invalidates synchronously before the hub fan-out (InvalidateUser
// for a role change, InvalidateAll for a channel-override change), with the 30s
// TTL as backstop and the service's generation counter stopping a racing populate
// from caching stale data. Fails closed: an unresolvable client is left out. Bare
// test hubs fall back to live lookups memoised per call.
func (h *Hub) channelReadAudience(ctx context.Context, channelID int64) []int64 {
	return h.channelReadAudienceImpl(ctx, channelID, false)
}

// channelReadAudienceIgnoringArchived is channelReadAudience without the Archived
// short-circuit. CleanupVoiceForChannel's callers (admin archive and delete) commit
// archived=1 before evicting voice participants, so a concurrent voice_join sees
// the archived gate. channelReadAudience would therefore always return nobody
// there, and the voice_leave telling bystanders the call ended would reach only
// the evicted participants. This resolves the pre-archival audience for that one
// broadcast.
func (h *Hub) channelReadAudienceIgnoringArchived(ctx context.Context, channelID int64) []int64 {
	return h.channelReadAudienceImpl(ctx, channelID, true)
}

func (h *Hub) channelReadAudienceImpl(ctx context.Context, channelID int64, ignoreArchived bool) []int64 {
	var ch *db.Channel
	if h.db != nil {
		var err error
		ch, err = h.readers.Visibility.GetChannel(ctx, channelID)
		if err != nil {
			// Fail closed: an unresolvable channel must not fall through to the role scan,
			// which would treat it as a readable non-DM channel.
			slog.Error("ws: channelReadAudience GetChannel failed, denying",
				"channel_id", channelID, "err", err)
			return []int64{}
		}
		// Fail closed on a missing row too: GetChannel returns (nil, nil) for a deleted
		// channel, and the role scan would resolve it to every connected user with base
		// READ_MESSAGES, leaking e.g. a closed group-DM's voice_leave server-wide.
		// Callers that tear down voice union the room's participants and the leaver back
		// in, so eviction signals still arrive.
		if ch == nil {
			return []int64{}
		}
	}
	return h.channelReadAudienceFor(ctx, channelID, ch, ignoreArchived)
}

// channelReadAudienceFor is channelReadAudienceImpl over a channel row the caller
// already read, so a caller that also needs the row pays one GetChannel. A nil ch
// is the bare test hub with no database: the role scan runs without a channel ref.
func (h *Hub) channelReadAudienceFor(ctx context.Context, channelID int64, ch *db.Channel, ignoreArchived bool) []int64 {
	h.mu.RLock()
	userIDs := h.connectedUserIDsLocked()
	h.mu.RUnlock()

	// A DM carries no channel_overrides rows, so every connected user with base
	// READ_MESSAGES would pass the role scan and a private DM call's voice events
	// would reach the whole server. Resolve the DM's participants intersected with
	// the connected set instead (the IsDMParticipant rule hasChannelAccess uses).
	var ref permissions.ChannelRef
	if ch != nil {
		if ch.Type == "dm" {
			return h.channelReadAudienceDM(ctx, channelID, userIDs)
		}
		ref = channelRef(ch)
		// CanViewChannel hides an archived channel from everyone (as
		// RefreshChannelVisibility and VisibleChannelIDs do), or an edit to an archived
		// channel would fan out to every user with base READ_MESSAGES. ignoreArchived
		// resolves the pre-archival audience instead.
		if ignoreArchived {
			ref.Archived = false
		}
	}

	// Resolved per user, not memoised per role: channel_user_overrides is the last
	// layer of resolution, so two members of one role can disagree about a channel.
	// An unresolvable user is left out.
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

// channelNSFWFilter is deliverBroadcast's NSFW gate for a content-bearing kind
// (see contentBearingKinds): who among a channel's current topic subscribers may
// receive it. Called on the dispatch goroutine just before seqMu is taken, so the
// label and acknowledgements are those in force at dispatch, not at enqueue.
//
// It deliberately does not resolve a candidate list: content stays on the topic
// Publish path (PublishFiltered) to keep its guarantees. The topic limiter runs
// first, and the subscriber list is read at delivery time under the seqMu section
// that serializes against a reconnect's registration; a precomputed list would go
// stale in exactly the reconnect window and skip the limiter.
//
// allow is nil for a confirmed unlabelled channel (one GetChannel read, nothing
// more); otherwise it checks membership in one batch ListNSFWAcknowledgedUserIDs
// query, or denies every recipient if a lookup failure leaves the label
// unconfirmed. labelled also gates the plugin sink (a plugin has no
// acknowledgement, so it never receives labelled content). unconfirmed reports
// that a read failed and the deny-all stands in for an answer, so
// deliverBroadcast forces those subscribers' resume onto the full-ready path.
func (h *Hub) channelNSFWFilter(ctx context.Context, channelID int64) (allow func(userID int64) bool, labelled, unconfirmed bool) {
	if h.db == nil {
		return nil, false, false
	}
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		// The label is unknown, not "not labelled". A nil allow means unfiltered, which
		// would leak the frame to every subscriber. Fail closed for both the socket path
		// (deny-all filter) and the plugin sink (labelled=true).
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

// channelReadAudienceDM resolves a DM channel's audience: its participants
// intersected with the connected userIDs. A DM must not fall through to the role
// scan (see the call site).
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

// RefreshChannelVisibility re-evaluates which connected clients may see ch after
// a channel_overrides change and sends targeted channel_create / channel_delete so
// sidebars converge without a reconnect. Clients losing visibility are also
// unsubscribed from the topic and have their focused channel cleared.
//
// The sends bypass the sequenced broadcast/replay path: a replayed channel_delete
// would be filtered by the allowed-channel set computed at replay time, which
// after an override change is the inverse of the intended audience.
func (h *Hub) RefreshChannelVisibility(ch *db.Channel) {
	if ch == nil {
		return
	}

	// The sends are unsequenced and walk a snapshot, so a reconnect registering
	// mid-loop is skipped and its last_seq can sit above any single leading watermark
	// bump. begin/endTargetedFanout force every reconnect during the loop onto a full
	// ready, and endTargetedFanout's bump covers any resume after it.
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	h.mu.RLock()
	clients := h.allClientsLocked()
	h.mu.RUnlock()

	// Called via the admin HubBroadcaster interface, which carries no context; the
	// re-sync must complete regardless of the triggering request.
	ctx := context.Background()
	private := h.channelIsPrivate(ctx, ch.ID, ch.Type)

	// Visibility is CanViewChannel (shared with buildReady / REST ListVisibleChannels),
	// resolved per user from their current role (c.user is a connect-time snapshot).
	// With a PermissionService the cache is safe because role, channel and moderation
	// services invalidate affected users (InvalidateAll when that list is unreadable)
	// before calling the hub; the 30s TTL is a backstop and the generation counter
	// stops a racing populate caching stale rows. Bare test hubs resolve live. Fails
	// closed: an unresolvable role loses visibility.
	//
	// Not memoised per role: channel_user_overrides is the last resolution layer, so
	// two members of one role can disagree, which is exactly what a per-user override
	// edit creates.
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

		// Re-resolve the live client right before acting: the permission lookups above
		// give a reconnect room to replace this user's *Client in h.clients. Acting on the
		// stale pointer would target a dead socket and Unsubscribe would be a no-op
		// (unsubscribeLocked's identity guard), stranding the replacement with the
		// inverse of what this fan-out decided. Nil means that device disconnected; the
		// user's other devices are separate snapshot entries judged on their own.
		live := h.sessionClient(c.user.ID, c.tokenHash)
		if live == nil {
			continue
		}

		if visible {
			// A socket without the forums feature is sent no forum row (client_features.go);
			// this frame is per recipient and unsequenced, so nothing is allocated for the skip.
			if !live.sendsChannel(ch.Type) {
				continue
			}
			// Idempotent add that also refreshes metadata. Addressed per client so it carries
			// this recipient's own affordance verdicts, which a permission change just made diverge.
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

// refreshChannelVisibilityAffordances recomputes the five affordance verdicts the
// ready payload ships per channel (affordancesFor) for one live user from their
// current role. A lookup error returns the zero value, which fails closed.
// Without it they are computed only at connect time, leaving composer, voice,
// delete, pin and reaction controls on stale verdicts until the socket is rebuilt.
func (h *Hub) refreshChannelVisibilityAffordances(ctx context.Context, ch *db.Channel, userID int64) channelAffordances {
	sub, err := h.subjectFor(ctx, userID, ch.ID)
	if err != nil {
		return channelAffordances{}
	}
	sub.Channel = channelRef(ch)
	return affordancesFor(sub)
}

// RefreshAllChannelVisibility re-derives, for every connected user, which non-DM
// channels they may see: held topics are revoked first, then each user gets a
// channel_create (with their own affordances) or channel_delete per channel. A
// role's permission mask is the base for every channel, so a role edit or delete
// can change visibility of any channel, where a channel_overrides edit touches
// one. DM channels are skipped (participant-based). Synchronous, against
// Background; the caller invalidates the permission cache first.
func (h *Hub) RefreshAllChannelVisibility() {
	// The same per-user step the role-refresh worker runs (role_refresh_round.go),
	// over every connected user, synchronously.
	ctx := context.Background()
	h.refreshVisibilityUsers(ctx, h.connectedUserIDs(), nil)
	h.refreshTimeoutViewsFor(ctx, nil)
}

func (h *Hub) revokeUnreadableChannels(userID int64) {
	// The channel_delete frames revokeTopicsNotIn sends are unsequenced, so bracket
	// the pass like RefreshChannelVisibility: a reconnect during it goes to a full
	// ready, and endTargetedFanout's bump covers every return path.
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	if h.db == nil {
		return
	}
	if conns := h.clientsOf(userID); len(conns) == 0 || conns[0].user == nil {
		return
	}

	// Called via the admin HubBroadcaster interface (no context); the re-evaluation
	// must complete regardless of the triggering request.
	ctx, cancel := context.WithTimeout(context.Background(), roleRefreshUserBudget)
	defer cancel()

	// c.user is a connect-time snapshot and the role just changed, so resolve the
	// current user, and through it the role, from the DB.
	var allowed map[int64]bool
	user, err := h.readers.Visibility.GetUserByID(ctx, userID)
	if err == nil && user != nil {
		allowed, err = h.computeAllowedChannels(ctx, h.readers.Visibility, user)
	}
	if err != nil || user == nil {
		// Visibility unresolved. Keeping the old subscriptions would leak and revoking
		// them all would hollow out a sidebar the user may still be entitled to, so close
		// the socket: the client reconnects and rebuilds from a ready payload with the new
		// role. kickClient, not DisconnectUser, whose BANNED error makes the client clear
		// its credentials instead of reconnecting.
		slog.Warn("hub: role change visibility unresolved, closing socket",
			"user_id", userID, "err", err)
		// Re-resolve before kicking: a reconnect can overlap the DB lookups above, and
		// kicking the stale snapshot would close a dead socket while the replacement
		// keeps its subscriptions.
		for _, live := range h.clientsOf(userID) {
			h.kickClient(live)
		}
		return
	}

	_, _ = h.revokeTopicsNotIn(ctx, userID, allowed, nil)
}

// computeAllowedChannels returns the channel IDs a user may access: server
// channels (ReadMessages) plus open DM channels. The server set comes from the
// same permissions.Checker predicate as buildReady and REST ListVisibleChannels,
// so replay filtering cannot drift from the ready payload.
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

	// Only the ID set matters, so use the PK-covered dm_open_state lookup. Fatal like
	// the lookups above: a silently DM-stripped replay advances the client's lastSeq
	// past DM events it never received, a permanent hole. The caller falls back to
	// full ready.
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
// never down. Writers (RefreshChannelVisibility, revokeUnreadableChannels,
// DMChannelOpenEvent, the content-shed paths in hub_stats.go) must use this, not a
// plain Store: a writer that read an older h.seq could overwrite a concurrently
// stored higher watermark and regress the boundary mustFullResync needs to be
// monotonic. Same CAS-max pattern as SeedSeq.
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

// MarkVisibilityChanged bumps the visibility watermark. It is the exported entry
// point REST handlers (api.markDMVisibilityChanged, via a dmVisibilityMarker
// assertion) use to get the same full-resync guarantee for an unsequenced,
// targeted DM event that the WS-side emitter gets via bumpVisibilityWatermark.
//
// It takes h.seqMu, the lock reconnectRegister holds across its watermark
// re-check and registerNow, rather than the lock-free internal bump (those callers
// have their own tested timing guarantees; the REST callers are the ones that
// raced reconnectRegister). A call can no longer land between the re-check and
// registerNow: it either completes before that section starts, or blocks until it
// ends, by which point the socket is registered and whatever the caller sends
// next (notifyNSFWAck, broadcastDMOpen's SendToUser loop) reaches it. Do not call
// while holding seqMu; nothing in the hub's own paths does.
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
