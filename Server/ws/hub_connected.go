package ws

import "slices"

// Live-connection status snapshots and the graceful-stop user snapshot, split out of serve_ready.go
// and hub.go (both at their line ceilings).

// mergeLivePresence is the user's live presence across their connections (oldest first). A non-idle
// status wins over idle; among those, and for the custom status and idle stamp that travel with it,
// the most recent setter wins (livePresence.setAt, ties to the newer connection). Unstamped
// connections are skipped. The game is the status source's own, else the newest connection's, so a
// game set on one device ends with that device, not when an unrelated device sets a status.
func mergeLivePresence(conns []*Client) livePresence {
	var out livePresence
	var src *livePresence
	var srcConn *Client
	for _, c := range conns {
		p := c.presence.Load()
		if p == nil || p.status == "" {
			continue
		}
		if src == nil {
			src, srcConn = p, c
			continue
		}
		// Any non-idle device beats an idle one (a background tab or sleeping phone must not make
		// an active user look idle); among equals the newest setter wins, since a chosen status is
		// stamped on every connection (applyChosenPresence).
		pi, si := isIdleStatus(p.status), isIdleStatus(src.status)
		if (si && !pi) || (si == pi && !p.setAt.Before(src.setAt)) {
			src, srcConn = p, c
		}
	}
	if src != nil {
		out = *src
		out.mobile = mobileShown(conns, srcConn, src)
	}
	// The song follows the game's rule.
	if out.activity == nil || out.listening == nil {
		for _, c := range slices.Backward(conns) {
			p := c.presence.Load()
			if p == nil {
				continue
			}
			if out.activity == nil && p.activity != nil {
				out.activity = p.activity
			}
			if out.listening == nil && p.listening != nil {
				out.listening = p.listening
			}
		}
	}
	return out
}

// mobileShown reports whether the merged presence, whose status comes from srcConn, shows the
// phone: srcConn is the Android app and every other stamped connection in the same idle class is a
// phone too. A desktop as active as the phone wins; a phone beside an idle desktop shows.
func mobileShown(conns []*Client, srcConn *Client, src *livePresence) bool {
	if !srcConn.features.mobile {
		return false
	}
	srcIdle := src.selfIdle
	for _, c := range conns {
		if c == srcConn || c.features.mobile {
			continue
		}
		if p := c.presence.Load(); p != nil && p.status != "" && p.selfIdle == srcIdle {
			return false
		}
	}
	return true
}

func (h *Hub) livePresences() map[int64]livePresence {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]livePresence, len(h.clients))
	for uid, conns := range h.clients {
		out[uid] = mergeLivePresence(conns)
	}
	return out
}

// userActivity is the game c's user reports across their connections (c's own, else another's), so
// a status change on one device does not blank another's game.
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

func (h *Hub) userListening(c *Client) *listeningActivity {
	if own := c.livePresence().listening; own != nil {
		return own
	}
	conns := h.clientsOf(c.userID)
	if len(conns) < 2 {
		return nil
	}
	return mergeLivePresence(conns).listening
}

// LiveStatus returns userID's live status, "" when no connection has stamped one. Safe from any
// goroutine.
func (h *Hub) LiveStatus(userID int64) string {
	return mergeLivePresence(h.clientsOf(userID)).status
}

// LiveMobile reports whether userID's merged live presence is on the Android app.
func (h *Hub) LiveMobile(userID int64) bool {
	return mergeLivePresence(h.clientsOf(userID)).mobile
}

// StoppedUserIDs returns every user the hub held when GracefulStopContext began plus any it closed;
// nil before. The conn-writes close step stamps each disconnected, since a stopped hub's readPump
// defers run too late for the final flush.
func (h *Hub) StoppedUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return append([]int64(nil), h.stopUsers...)
}

func (h *Hub) recordStopUsers() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for uid := range h.clients {
		h.stopUsers = append(h.stopUsers, uid)
	}
}

// closeClientsForStop closes every remaining client's send channel, adding each user to stopUsers
// first so one connecting during the notice window is stamped too.
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

// rebroadcastAfterDeviceLeft re-sends the user's presence when a device's leaving changed what they
// show (its game, song or a status only it held); no later command from a live connection would
// otherwise correct other members. A user with no connection left gets the offline broadcast, and a
// same-session replacement sends its own, so callers skip both.
func (h *Hub) rebroadcastAfterDeviceLeft(c *Client) {
	h.presenceFeed.mu.Lock()
	defer h.presenceFeed.mu.Unlock()
	remaining := h.clientsOf(c.userID)
	if len(remaining) == 0 || slices.Contains(remaining, c) {
		return
	}
	// The list the user's last frame was merged from: c back in its place.
	at := slices.IndexFunc(remaining, func(r *Client) bool { return r.connectedAt.After(c.connectedAt) })
	if at < 0 {
		at = len(remaining)
	}
	before := slices.Insert(slices.Clone(remaining), at, c)
	was, now := mergeLivePresence(before), mergeLivePresence(remaining)
	if sameShownPresence(was, now) {
		return
	}
	h.broadcastMergedPresenceLocked(c.userID, remaining, now)
}

func sameShownPresence(a, b livePresence) bool {
	return a.status == b.status &&
		a.mobile == b.mobile &&
		a.customStatusExpiresAt == b.customStatusExpiresAt &&
		sameText(a.customStatus, b.customStatus) &&
		sameActivity(a.activity, b.activity) &&
		sameListening(a.listening, b.listening)
}
