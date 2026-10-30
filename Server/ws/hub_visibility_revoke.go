package ws

import (
	"context"
	"log/slog"
)

// RevokeUnreadableChannels releases the channel topics userID's live client
// holds and the user's current role cannot read, before the caller answers its
// request: a member's held channels are released as the role change returns.
// It re-resolves the user from the database, bumps the visibility watermarks,
// and takes none of the locks a role-refresh round holds across I/O. The role
// and moderation services call it (through PermissionChangeNotifier)
// for the users they name, ahead of EnqueueRoleRefresh.
func (h *Hub) RevokeUnreadableChannels(userID int64) {
	h.revokeUnreadableChannels(userID)
}

// revokeTopicsNotIn drops every channel topic userID's live client holds that
// is not in allowed, with a targeted channel_delete, an Unsubscribe and the
// focused channel cleared. It is the loop revokeUnreadableChannels and the
// role-refresh worker (role_refresh_round.go) share.
//
// Only the topics the socket actually holds are examined. DM topics are never
// revoked: access is dm_participants, which no role change can alter, while a
// closed DM is missing from allowed. A failed channel lookup closes the socket
// instead of guessing. It reports false when the user was kicked or is no
// longer connected, so the caller sends nothing more; revoked lists the
// channels it sent a channel_delete for.
func (h *Hub) revokeTopicsNotIn(ctx context.Context, userID int64, allowed map[int64]bool, known map[int64]struct{}) (revoked map[int64]struct{}, ok bool) {
	// Each device holds its own topics; all of them are judged against the one
	// verdict set. A failed lookup closes every socket of the user.
	for _, snap := range h.clientsOf(userID) {
		r, connOK := h.revokeConnTopicsNotIn(ctx, snap, allowed, known)
		for chID := range r {
			if revoked == nil {
				revoked = make(map[int64]struct{})
			}
			revoked[chID] = struct{}{}
		}
		if !connOK {
			return revoked, false
		}
	}
	return revoked, true
}

// revokeConnTopicsNotIn is revokeTopicsNotIn for the one connection snap. It
// reports false when the user was kicked.
func (h *Hub) revokeConnTopicsNotIn(ctx context.Context, snap *Client, allowed map[int64]bool, known map[int64]struct{}) (revoked map[int64]struct{}, ok bool) {
	userID := snap.userID
	for _, topic := range h.pubsub.TopicsForClient(snap) {
		chID := channelTopicID(topic)
		if chID == 0 || allowed[chID] {
			continue
		}
		// With a snapshot (known non-nil) a topic outside it, and not
		// explicitly decided in allowed, was subscribed after the verdicts
		// were read; it is judged on its own and left alone here.
		if known != nil {
			_, inSnap := known[chID]
			_, decided := allowed[chID]
			if !inSnap && !decided {
				continue
			}
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
			for _, live := range h.clientsOf(userID) {
				h.kickClient(live)
			}
			return nil, false
		}
		if ch != nil && ch.Type == "dm" {
			continue
		}
		// A thread topic (the second focus slot) is released with no frame:
		// the parent's own channel_delete is what tells the client, and a
		// thread was never a sidebar channel. A deleted thread (ch nil) is
		// released the same way when it is the slot's thread.
		// The deleted-thread test reads the slot from the LIVE connection of
		// this device, not the snapshot: a reconnect may have replaced the
		// *Client (and its thread focus) since the snapshot was taken.
		liveThread := h.sessionClient(userID, snap.tokenHash)
		if releasesAsThread(ch != nil, ch != nil && ch.IsThread(), liveThread, chID) {
			if liveThread == nil {
				return nil, true // that device is gone; nothing left to release on it
			}
			h.releaseThreadSocket(liveThread, chID, nil)
			continue
		}
		if revokeUnreadableChannelsPreActRaceHook != nil {
			revokeUnreadableChannelsPreActRaceHook(userID)
		}
		// Re-resolve the live client immediately before acting: the DB round trips above give
		// a reconnect room to replace this device's *Client in h.clients. Acting on a snapshot
		// would target the dead socket, and Unsubscribe would no-op on unsubscribeLocked's
		// identity guard, stranding the replacement with the revoked topic. A nil result means
		// that device disconnected entirely; nothing left to revoke on it.
		live := h.sessionClient(userID, snap.tokenHash)
		if live == nil {
			return revoked, true
		}
		live.sendMsg(buildChannelDelete(chID))
		h.pubsub.Unsubscribe(live, topic)
		live.mu.Lock()
		if live.channelID == chID {
			live.channelID = 0
		}
		live.mu.Unlock()
		if revoked == nil {
			revoked = make(map[int64]struct{})
		}
		revoked[chID] = struct{}{}
	}
	return revoked, true
}

// releasesAsThread reports whether chID's topic is a thread slot to release
// silently: a thread channel, or a deleted channel (exists false) that is the
// live connection's focused thread.
func releasesAsThread(exists, isThread bool, live *Client, chID int64) bool {
	if exists {
		return isThread
	}
	return live != nil && live.getThreadID() == chID
}
