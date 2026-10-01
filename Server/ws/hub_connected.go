package ws

// hub_connected.go — live-connection status snapshots, split out of
// serve_ready.go (at its line ceiling). See livePresences.

// livePresences snapshots each connected user's live presence
// (Client.livePresence), status "" for a connection that has not stamped one
// yet.
func (h *Hub) livePresences() map[int64]livePresence {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]livePresence, len(h.clients))
	for uid, c := range h.clients {
		out[uid] = c.livePresence()
	}
	return out
}

// LiveStatus returns userID's live status, "" when the user has no
// connection or it has not stamped one yet. Safe to call from any goroutine.
func (h *Hub) LiveStatus(userID int64) string {
	h.mu.RLock()
	c := h.clients[userID]
	h.mu.RUnlock()
	if c == nil {
		return ""
	}
	return c.livePresence().status
}

// ConnectedUserIDs returns the users the hub still holds a connection for.
// The conn-writes close step stamps each one disconnected, since a stopped
// hub's readPump defers run too late for the final flush (P5-S07).
func (h *Hub) ConnectedUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		out = append(out, uid)
	}
	return out
}
