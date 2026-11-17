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

// channelReadAudience returns the connected user IDs whose current role may READ channelID. Never
// nil: empty means nobody, not "no filter". Verdicts come from the cached PermissionService when
// present; caching is safe because every mutation invalidates synchronously before the hub fan-out
// (30s TTL backstop; the generation counter stops a racing populate caching stale data). Fails
// closed: an unresolvable client is left out. Bare test hubs use live lookups memoised per call.
func (h *Hub) channelReadAudience(ctx context.Context, channelID int64) []int64 {
	return h.channelReadAudienceImpl(ctx, channelID, false)
}

// channelReadAudienceIgnoringArchived is channelReadAudience without the Archived short-circuit:
// CleanupVoiceForChannel's callers commit archived=1 before evicting, so the plain form would
// return nobody and the voice_leave would reach only the evicted participants.
func (h *Hub) channelReadAudienceIgnoringArchived(ctx context.Context, channelID int64) []int64 {
	return h.channelReadAudienceImpl(ctx, channelID, true)
}

func (h *Hub) channelReadAudienceImpl(ctx context.Context, channelID int64, ignoreArchived bool) []int64 {
	var ch *db.Channel
	if h.db != nil {
		var err error
		ch, err = h.readers.Visibility.GetChannel(ctx, channelID)
		if err != nil {
			// Fail closed: an unresolvable channel must not fall through to the role scan, which
			// would treat it as a readable non-DM channel.
			slog.Error("ws: channelReadAudience GetChannel failed, denying",
				"channel_id", channelID, "err", err)
			return []int64{}
		}
		// Fail closed on a missing row too: GetChannel returns (nil, nil) for a deleted channel and
		// the role scan would resolve it to every user with base READ_MESSAGES, leaking e.g. a
		// closed group-DM's voice_leave server-wide. Voice teardown callers union the participants
		// back in.
		if ch == nil {
			return []int64{}
		}
	}
	return h.channelReadAudienceFor(ctx, channelID, ch, ignoreArchived)
}

// channelReadAudienceFor is channelReadAudienceImpl over a channel row the caller already read. A
// nil ch is the bare test hub: the role scan runs without a channel ref.
func (h *Hub) channelReadAudienceFor(ctx context.Context, channelID int64, ch *db.Channel, ignoreArchived bool) []int64 {
	// A DM has no channel_overrides rows, so the role scan would pass every user with base
	// READ_MESSAGES and a private call's voice events would reach the whole server. Resolve the
	// participants intersected with the connected set instead (hasChannelAccess's IsDMParticipant
	// rule); membership is read live, so a DM is never memoised.
	var ref permissions.ChannelRef
	if ch != nil {
		if ch.Type == "dm" {
			userIDs, _ := h.connectedSnapshot()
			return h.channelReadAudienceDM(ctx, channelID, userIDs)
		}
		ref = channelRef(ch)
		// CanViewChannel hides an archived channel from everyone (as RefreshChannelVisibility
		// does), or an edit to one would fan out to every user with base READ_MESSAGES.
		// ignoreArchived resolves the pre-archival audience.
		if ignoreArchived {
			ref.Archived = false
		}
	}

	key := audienceMemoKey{channelID: channelID, ignoreArchived: ignoreArchived}
	now := time.Now()
	permGen, connGen, memo := h.memoGens()
	if memo {
		if audience, ok := loadFresh(&h.audience.channels, key, ref, permGen, connGen, now); ok {
			return audience
		}
	}
	userIDs, snapGen := h.connectedSnapshot()

	// Resolved per user, not per role: channel_user_overrides is the last layer, so two members of
	// one role can disagree. An unresolvable user is left out and the result not memoised, so the
	// next frame asks again.
	audience := make([]int64, 0, len(userIDs))
	var unresolved []int64
	for _, uid := range userIDs {
		sub, err := h.subjectFor(ctx, uid, channelID)
		if err != nil {
			unresolved = append(unresolved, uid)
			continue
		}
		sub.Channel = ref
		if permissions.CanViewChannel(sub) == nil {
			audience = append(audience, uid)
		}
	}
	if len(unresolved) > 0 {
		// A user left out for a failed lookup would never learn of the frame (recipient-addressed
		// frames skip replay): mark them lost so their sockets resync at the next dispatch.
		h.noteRecipientsLoss(unresolved)
		slog.Warn("hub: channelReadAudience could not resolve users, marking them for resync",
			"channel_id", channelID, "users", len(unresolved))
	}
	if memo && len(unresolved) == 0 {
		h.storeIfUnchanged(&h.audience.channels, key, ref, permGen, snapGen, now, audience)
	}
	return audience
}

// channelNSFWFilter is deliverBroadcast's NSFW gate for a content-bearing kind: who among a
// channel's current topic subscribers may receive it. Called on the dispatch goroutine just before
// seqMu, so label and acknowledgements are those in force at dispatch.
// It deliberately resolves no candidate list: content stays on the topic Publish path
// (PublishFiltered), where the limiter runs first and the subscriber list is read at delivery under
// the seqMu section serializing against reconnect registration; a precomputed list would go stale
// in exactly the reconnect window and skip the limiter.
// allow is nil for a confirmed unlabelled channel (one GetChannel read); otherwise it checks one
// batch ListNSFWAcknowledgedUserIDs query, or denies everyone if a failure leaves the label
// unconfirmed. labelled also gates the plugin sink (plugins have no acknowledgement). unconfirmed
// reports that a deny-all stands in for a failed read, so deliverBroadcast forces those
// subscribers' resume onto the full ready.
func (h *Hub) channelNSFWFilter(ctx context.Context, channelID int64) (allow func(userID int64) bool, labelled, unconfirmed bool) {
	if h.db == nil {
		return nil, false, false
	}
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		// The label is unknown, not "not labelled": nil allow means unfiltered and would leak. Fail
		// closed for the socket path (deny-all) and the plugin sink (labelled=true).
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

func (h *Hub) revokeUnreadableChannels(userID int64) {
	// The channel_delete frames revokeTopicsNotIn sends are unsequenced, so bracket the pass like
	// RefreshChannelVisibility: a reconnect during it takes a full ready, and endTargetedFanout's
	// bump covers every return.
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	if h.db == nil {
		return
	}
	if conns := h.clientsOf(userID); len(conns) == 0 || conns[0].user == nil {
		return
	}

	// Called via the admin HubBroadcaster (no context); the re-evaluation must complete regardless
	// of the triggering request.
	ctx, cancel := context.WithTimeout(context.Background(), roleRefreshUserBudget)
	defer cancel()

	// c.user is a connect-time snapshot and the role just changed: resolve the current user and
	// role from the DB.
	var allowed map[int64]bool
	user, err := h.readers.Visibility.GetUserByID(ctx, userID)
	if err == nil && user != nil {
		allowed, err = h.computeAllowedChannels(ctx, h.readers.Visibility, user)
	}
	if err != nil || user == nil {
		// Visibility unresolved: keeping old subscriptions would leak and revoking all would hollow
		// out a sidebar the user may be entitled to, so close the socket and let the client rebuild
		// from a ready. kickClient, not DisconnectUser, whose BANNED error makes the client clear
		// its credentials.
		slog.Warn("hub: role change visibility unresolved, closing socket",
			"user_id", userID, "err", err)
		// Re-resolve before kicking: a reconnect can overlap the DB lookups, and kicking the stale
		// snapshot would close a dead socket while the replacement keeps its subscriptions.
		for _, live := range h.clientsOf(userID) {
			h.kickClient(live)
		}
		return
	}

	_, _ = h.revokeTopicsNotIn(ctx, userID, allowed, nil)
}

// computeAllowedChannels returns the channel IDs a user may access: server channels (ReadMessages)
// plus open DM channels. The server set uses the same permissions.Checker predicate as buildReady
// and REST ListVisibleChannels, so replay filtering cannot drift from ready.
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

	// Only the ID set matters, so use the PK-covered dm_open_state lookup. Fatal: a silently DM-
	// stripped replay advances the client's lastSeq past DM events it never got, a permanent hole;
	// the caller falls back to full ready.
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

// bumpVisibilityWatermark ratchets visibilityChangeSeq up to the current seq, never down. Writers
// must use it, not a plain Store: a writer that read an older h.seq could regress a concurrently
// stored higher watermark that mustFullResync needs monotonic (same CAS-max as SeedSeq).
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

// MarkVisibilityChanged is the watermark bump for unsequenced targeted DM events, used by the REST
// handlers (via a dmVisibilityMarker assertion) and the WS emitter alike, so both give a full resync.
// It takes h.seqMu, which reconnectRegister holds across its watermark re-check and registerNow,
// rather than the lock-free bump (REST callers raced reconnectRegister): a call either completes
// before that section or blocks until the socket is registered, so what the caller sends next
// reaches it. Do not call while holding seqMu.
func (h *Hub) MarkVisibilityChanged() {
	h.seqMu.Lock()
	start := time.Now()
	defer h.seqMu.Unlock()
	defer h.observeSeqMuHold(start)
	h.bumpVisibilityWatermark()
}

type roleChannel struct {
	ch      *db.Channel
	private bool
}
