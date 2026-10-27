package ws

import "slices"

// hub_connected.go — live-connection status snapshots, split out of
// serve_ready.go (at its line ceiling), and the graceful-stop user snapshot
// kept out of hub.go (at its line ceiling). See livePresences, StoppedUserIDs.

// mergeLivePresence is the user's live presence across all of their
// connections (oldest first). The shown status is the highest presenceRank
// among the connections (any non-idle device wins over idle ones); within a
// rank, and for the custom status and idle stamp that travel with it, the most
// recent setter wins (livePresence.setAt, ties to the newer connection). A
// connection that has stamped nothing yet is skipped. The game activity is the
// status source's own when it has one, else the newest connection reporting
// one, so an activity set on one device is the user's, and it ends when that
// device's connection goes (or the user clears it there) rather than when an
// unrelated device sets a status.
func mergeLivePresence(conns []*Client) livePresence {
	var out livePresence
	var src *livePresence
	for _, c := range conns {
		p := c.presence.Load()
		if p == nil || p.status == "" {
			continue
		}
		if src == nil {
			src = p
			continue
		}
		pr, sr := presenceRank(p.status), presenceRank(src.status)
		if pr > sr || (pr == sr && !p.setAt.Before(src.setAt)) {
			src = p
		}
	}
	if src != nil {
		out = *src
	}
	if out.activity == nil {
		for _, c := range slices.Backward(conns) {
			if p := c.presence.Load(); p != nil && p.activity != nil {
				out.activity = p.activity
				break
			}
		}
	}
	return out
}

// livePresences snapshots each connected user's live presence
// (mergeLivePresence), status "" for a user none of whose connections has
// stamped one yet.
func (h *Hub) livePresences() map[int64]livePresence {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]livePresence, len(h.clients))
	for uid, conns := range h.clients {
		out[uid] = mergeLivePresence(conns)
	}
	return out
}

// userActivity is the game c's user reports across all of their connections:
// c's own when it has one, else another connection's (mergeLivePresence). The
// presence frames a connection emits carry it, so a status change on one device
// does not blank the game another device reports.
func (h *Hub) userActivity(c *Client) *gameActivity {
	if own := c.livePresence().activity; own != nil {
		return own
	}
	conns := h.clientsOf(c.userID)
	if len(conns) < 2 {
		return nil
	}
	return mergeLivePresence(conns).activity
}

// LiveStatus returns userID's live status, "" when the user has no
// connection or none has stamped one yet. Safe to call from any goroutine.
func (h *Hub) LiveStatus(userID int64) string {
	return mergeLivePresence(h.clientsOf(userID)).status
}

// StoppedUserIDs returns every user the hub held when GracefulStopContext
// began, plus any it closed; nil before. The conn-writes close step stamps
// each one disconnected, since a stopped hub's readPump defers, which
// unregister before they stamp, run too late for the final flush (P5-S07).
func (h *Hub) StoppedUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return append([]int64(nil), h.stopUsers...)
}

// recordStopUsers adds every user the hub holds to stopUsers; the first step
// of GracefulStopContext.
func (h *Hub) recordStopUsers() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for uid := range h.clients {
		h.stopUsers = append(h.stopUsers, uid)
	}
}

// closeClientsForStop closes every remaining client's send channel, adding
// each user to stopUsers first so one who connected during the notice window
// is stamped too.
func (h *Hub) closeClientsForStop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for uid, conns := range h.clients {
		h.stopUsers = append(h.stopUsers, uid)
		for _, c := range conns {
			c.closeSend()
		}
	}
}
