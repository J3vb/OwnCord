package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Budget of one RefreshChannelVisibility walk: a base plus a share per connected
// client, capped. Vars so tests can shrink them.
var (
	channelVisibilityBaseBudget      = 5 * time.Second
	channelVisibilityPerClientBudget = 2 * time.Millisecond
	channelVisibilityMaxBudget       = 30 * time.Second
)

func channelVisibilityBudget(clients int) time.Duration {
	return min(channelVisibilityBaseBudget+time.Duration(clients)*channelVisibilityPerClientBudget, channelVisibilityMaxBudget)
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
	// re-sync must complete regardless of the triggering request, but not without
	// bound: a stalled permission read would hold the request and keep every reconnect
	// on a full ready for as long as the walk lasts.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), channelVisibilityBudget(len(clients)))
	defer cancel()
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
	for i, c := range clients {
		if c.user == nil {
			continue
		}
		sub, err := h.subjectFor(ctx, c.user.ID, ch.ID)
		if ctx.Err() != nil {
			// Out of time: this client and the rest were not judged. Their sidebar may be
			// stale, so move the watermark and send each to a resync.
			h.markVisibilityWalkTimedOut(ch.ID, clients[i:])
			return
		}
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
			if ctx.Err() != nil {
				// The affordances may have failed closed on the expiry; this client's frame
				// is not trustworthy either.
				h.markVisibilityWalkTimedOut(ch.ID, clients[i:])
				return
			}
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

// markVisibilityWalkTimedOut handles a RefreshChannelVisibility walk that ran out
// of time with unreached still unjudged: it moves the visibility watermark so a
// resume across the change takes the full ready, and marks each unreached live
// client so it resyncs by its next sequenced frame.
func (h *Hub) markVisibilityWalkTimedOut(channelID int64, unreached []*Client) {
	h.bumpVisibilityWatermark()
	n := 0
	for _, c := range unreached {
		if c.user == nil {
			continue
		}
		if live := h.sessionClient(c.userID, c.tokenHash); live != nil {
			h.markClientLoss(live)
			n++
		}
	}
	slog.Warn("hub: RefreshChannelVisibility timed out, unreached clients marked for resync",
		"channel_id", channelID, "unreached", n)
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
