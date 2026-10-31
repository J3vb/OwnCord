package ws

import "slices"

// hub_connected.go: live-connection status snapshots and the graceful-stop user
// snapshot, split out of serve_ready.go and hub.go (both at their line ceilings).
// See livePresences, StoppedUserIDs.

// mergeLivePresence is the user's live presence across all their connections
// (oldest first). The shown status is a non-idle one when any connection has one (an
// idle device never outranks an active one); among those, and for the custom status
// and idle stamp that travel with it, the most recent setter wins (livePresence.setAt,
// ties to the newer connection). A connection that has stamped nothing is skipped.
// The game activity is the status source's own when it has one, else the newest
// connection reporting one, so an activity set on one device ends when that device's
// connection goes (or the user clears it there), not when an unrelated device sets a
// status.
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
		// Any non-idle device beats an idle one (a background tab or a sleeping
		// phone must not make an active user look idle); among equals the
		// newest setter wins, since a chosen status is stamped on every
		// connection (applyChosenPresence) and so is always the newest choice.
		pi, si := isIdleStatus(p.status), isIdleStatus(src.status)
		if (si && !pi) || (si == pi && !p.setAt.Before(src.setAt)) {
			src, srcConn = p, c
		}
	}
	if src != nil {
		out = *src
		out.mobile = mobileShown(conns, srcConn, src)
	}
	// The song follows the same rule as the game: the status source's own,
	// else the newest connection reporting one.
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

// mobileShown reports whether the merged presence, whose status comes from srcConn,
// shows the phone: srcConn is the Android app and every other stamped connection in
// the same idle class (all active, or all idle) is a phone too. A desktop that is as
// active as the phone wins, and a phone beside an idle desktop shows, since the idle
// desktop is not what the user is using.
func mobileShown(conns []*Client, srcConn *Client, src *livePresence) bool {
	if !srcConn.features.mobile {
		return false
	}
	srcIdle := isIdleStatus(src.status)
	for _, c := range conns {
		if c == srcConn || c.features.mobile {
			continue
		}
		if p := c.presence.Load(); p != nil && p.status != "" && isIdleStatus(p.status) == srcIdle {
			return false
		}
	}
	return true
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

// userListening is userActivity for the song: c's own when it has
// one, else another connection's, so a status change on one device does not
// blank the song another device reports.
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

// LiveStatus returns userID's live status, "" when the user has no
// connection or none has stamped one yet. Safe to call from any goroutine.
func (h *Hub) LiveStatus(userID int64) string {
	return mergeLivePresence(h.clientsOf(userID)).status
}

// StoppedUserIDs returns every user the hub held when GracefulStopContext began,
// plus any it closed; nil before. The conn-writes close step stamps each one
// disconnected, since a stopped hub's readPump defers (which unregister) run too
// late for the final flush.
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

// rebroadcastAfterDeviceLeft re-sends the user's presence when c, one of several
// connections, has gone and its leaving changed what the user shows: the game or
// song c reported, or a status (or custom status) only c held up. No command from a
// live connection follows a closed or kicked device, so without this the other
// members keep the departed device's state until the user changes something else.
// A user with no connection left gets the offline broadcast instead
// (shouldMarkOffline), and a same-session replacement sends its own presence, so
// callers skip both.
func (h *Hub) rebroadcastAfterDeviceLeft(c *Client) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	remaining := h.clientsOf(c.userID)
	if len(remaining) == 0 || slices.Contains(remaining, c) {
		return
	}
	// The list the user's last frame was merged from: c back in its place
	// among the oldest-first connections.
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

// sameShownPresence reports whether two merged presences render the same to
// other members: status, phone, custom status text, game and song.
func sameShownPresence(a, b livePresence) bool {
	return a.status == b.status &&
		a.mobile == b.mobile &&
		a.customStatusExpiresAt == b.customStatusExpiresAt &&
		sameText(a.customStatus, b.customStatus) &&
		sameActivity(a.activity, b.activity) &&
		sameListening(a.listening, b.listening)
}
