package ws

import (
	"context"
	"log/slog"
)

// RevokeUnreadableChannels releases the channel topics userID's live client holds and their current
// role cannot read, before the caller answers its request. It re-resolves the user from the
// database, bumps the visibility watermarks and takes none of the locks a role-refresh round holds
// across I/O. The role and moderation services call it (via PermissionChangeNotifier) ahead of
// EnqueueRoleRefresh.
func (h *Hub) RevokeUnreadableChannels(userID int64) {
	h.revokeUnreadableChannels(userID)
}

// revokeTopicsNotIn drops every channel topic userID's live client holds that is not in allowed
// (targeted channel_delete, Unsubscribe, focused channel cleared); shared by
// revokeUnreadableChannels and the role-refresh worker.
// Only held topics are examined. DM topics are never revoked: access is dm_participants, which no
// role change alters, while a closed DM is missing from allowed. A failed channel lookup closes the
// socket instead of guessing. Returns false when the user was kicked or disconnected; revoked lists
// the channels it sent a channel_delete for.
func (h *Hub) revokeTopicsNotIn(ctx context.Context, userID int64, allowed map[int64]bool, known map[int64]struct{}) (revoked map[int64]struct{}, ok bool) {
	// Each device holds its own topics, all judged against the one verdict set; a failed lookup
	// closes every socket of the user.
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

func (h *Hub) revokeConnTopicsNotIn(ctx context.Context, snap *Client, allowed map[int64]bool, known map[int64]struct{}) (revoked map[int64]struct{}, ok bool) {
	userID := snap.userID
	for _, topic := range h.pubsub.TopicsForClient(snap) {
		chID := channelTopicID(topic)
		if chID == 0 || allowed[chID] {
			continue
		}
		// With a snapshot, a topic outside it and not decided in allowed was subscribed after the
		// verdicts were read; it is judged on its own and left alone here.
		if known != nil {
			_, inSnap := known[chID]
			_, decided := allowed[chID]
			if !inSnap && !decided {
				continue
			}
		}
		// DM access is gated on dm_participants, which no role change alters, while allowed sources
		// DMs from dm_open_state: a closed DM (or every DM, if that lookup failed) is missing from
		// allowed though its subscription is legitimate. Never revoke a DM here; on a lookup error
		// close the socket rather than guess.
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
		// A thread topic (second focus slot) is released with no frame: the parent's channel_delete
		// tells the client, and a thread was never a sidebar channel. A deleted thread is released
		// the same way when it is the slot's thread, read from the LIVE connection since a
		// reconnect may have replaced the *Client.
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
		// Re-resolve the live client immediately before acting: the DB round trips give a reconnect
		// room to replace this device's *Client, so acting on a snapshot would hit the dead socket
		// (Unsubscribe no-ops on its identity guard) and strand the replacement with the revoked
		// topic. Nil means the device disconnected.
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

// releasesAsThread reports whether chID's topic is a thread slot to release silently: a thread, or
// a deleted channel that is the live connection's focused thread.
func releasesAsThread(exists, isThread bool, live *Client, chID int64) bool {
	if exists {
		return isThread
	}
	return live != nil && live.getThreadID() == chID
}
