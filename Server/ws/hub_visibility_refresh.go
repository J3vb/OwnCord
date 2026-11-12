package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Budget of one RefreshChannelVisibility walk: a base plus a share per connected client, capped;
// vars so tests can shrink them.
var (
	channelVisibilityBaseBudget      = 5 * time.Second
	channelVisibilityPerClientBudget = 2 * time.Millisecond
	channelVisibilityMaxBudget       = 30 * time.Second
	visibilityTimeoutSettleBudget    = time.Second
)

func channelVisibilityBudget(clients int) time.Duration {
	return min(channelVisibilityBaseBudget+time.Duration(clients)*channelVisibilityPerClientBudget, channelVisibilityMaxBudget)
}

// RefreshChannelVisibility re-evaluates which connected clients may see ch after a
// channel_overrides change and sends targeted channel_create / channel_delete so sidebars converge
// without a reconnect; clients losing visibility are unsubscribed and have their focused channel
// cleared.
// The sends bypass sequenced replay: a replayed channel_delete would be filtered by the allowed set
// computed at replay time, which after an override change is the inverse of the intended audience.
func (h *Hub) RefreshChannelVisibility(ch *db.Channel) {
	if ch == nil {
		return
	}

	// The sends are unsequenced and walk a snapshot, so a reconnect registering mid-loop is skipped
	// and its last_seq can sit above any single leading watermark bump. begin/endTargetedFanout
	// force reconnects during the loop onto a full ready, and the end bump covers any resume after.
	h.beginTargetedFanout()
	defer h.endTargetedFanout()

	h.mu.RLock()
	clients := h.allClientsLocked()
	h.mu.RUnlock()

	// Called via the admin HubBroadcaster (no context): the re-sync must complete regardless of the
	// request but not without bound, since a stalled permission read would keep every reconnect on
	// a full ready for the walk's duration.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), channelVisibilityBudget(len(clients)))
	defer cancel()
	private := h.channelIsPrivate(ctx, ch.ID, ch.Type)

	// Visibility is CanViewChannel (shared with buildReady / REST), resolved per user from their
	// current role (c.user is a connect-time snapshot). The cache is safe because services
	// invalidate affected users (InvalidateAll when the list is unreadable) before calling the hub;
	// 30s TTL and the generation counter are backstops. Fails closed: an unresolvable role loses
	// visibility.
	// Not memoised per role: channel_user_overrides is the last layer, so two members of one role
	// can disagree.
	for i, c := range clients {
		if c.user == nil {
			continue
		}
		sub, err := h.subjectFor(ctx, c.user.ID, ch.ID)
		if ctx.Err() != nil {
			// Out of time: this client and the rest were not judged, so move the watermark and send
			// each to a resync.
			h.markVisibilityWalkTimedOut(ctx, ch.ID, clients[i:])
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

		// Re-resolve the live client right before acting: the permission lookups give a reconnect
		// room to replace this user's *Client, and acting on the stale pointer would hit a dead
		// socket (Unsubscribe is a no-op by unsubscribeLocked's identity guard), stranding the
		// replacement. Nil means that device disconnected; other devices are judged as their own
		// snapshot entries.
		live := h.sessionClient(c.user.ID, c.tokenHash)
		if live == nil {
			continue
		}

		if visible {
			// A socket without the forums feature is sent no forum row (client_features.go); the
			// frame is unsequenced per recipient, so nothing is allocated for the skip.
			if !live.sendsChannel(ch.Type) {
				continue
			}
			// Idempotent add that also refreshes metadata, per client so it carries this
			// recipient's own affordance verdicts, which a permission change just made diverge.
			live.sendMsg(buildChannelCreateFor(ch, private, h.refreshChannelVisibilityAffordances(ctx, ch, c.user.ID)))
			if ctx.Err() != nil {
				// The affordances may have failed closed on the expiry, so this client's frame is
				// not trustworthy either.
				h.markVisibilityWalkTimedOut(ctx, ch.ID, clients[i:])
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

// markVisibilityWalkTimedOut handles a walk that ran out of time: it moves the visibility watermark
// so a resume across the change takes the full ready, takes each unreached live client off the
// channel as if it had lost access (its focus, topic and held thread under it), and marks it to
// resync by its next sequenced frame. The full ready gives the channel back to a client that may
// still see it, and its next focus is checked again.
func (h *Hub) markVisibilityWalkTimedOut(ctx context.Context, channelID int64, unreached []*Client) {
	h.bumpVisibilityWatermark()
	settled := make([]*Client, 0, len(unreached))
	for _, c := range unreached {
		if c.user == nil {
			continue
		}
		live := h.sessionClient(c.userID, c.tokenHash)
		if live == nil {
			continue
		}
		h.pubsub.Unsubscribe(live, ChannelTopic(channelID))
		live.mu.Lock()
		if live.channelID == channelID {
			live.channelID = 0
		}
		live.mu.Unlock()
		h.markClientLoss(live)
		settled = append(settled, live)
	}
	// Held threads need a lookup, so they go second, after every client is off the channel. The
	// walk's own budget is spent; these lookups share a short one, and a lookup that fails releases
	// the thread.
	tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), visibilityTimeoutSettleBudget)
	defer cancel()
	for _, live := range settled {
		h.revokeHeldThread(tctx, live, channelID)
	}
	slog.Warn("hub: RefreshChannelVisibility timed out, unreached clients marked for resync",
		"channel_id", channelID, "unreached", len(settled))
}

// refreshChannelVisibilityAffordances recomputes the five ready-payload affordance verdicts for one
// live user from their current role; a lookup error returns the zero value (fail closed). Otherwise
// they would stay stale until the socket is rebuilt.
func (h *Hub) refreshChannelVisibilityAffordances(ctx context.Context, ch *db.Channel, userID int64) channelAffordances {
	sub, err := h.subjectFor(ctx, userID, ch.ID)
	if err != nil {
		return channelAffordances{}
	}
	sub.Channel = channelRef(ch)
	return affordancesFor(sub)
}

// RefreshAllChannelVisibility re-derives which non-DM channels every connected user may see: held
// topics are revoked first, then each user gets a channel_create (own affordances) or
// channel_delete per channel. A role edit can change visibility of any channel (a channel_overrides
// edit touches one). DMs are skipped. Synchronous, against Background; the caller invalidates the
// permission cache first.
func (h *Hub) RefreshAllChannelVisibility() {
	// The same per-user step as the role-refresh worker (role_refresh_round.go), over every
	// connected user.
	ctx := context.Background()
	h.refreshVisibilityUsers(ctx, h.connectedUserIDs(), nil)
	h.refreshTimeoutViewsFor(ctx, nil)
}
