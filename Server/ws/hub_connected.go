package ws

// hub_connected.go — the live-connection id snapshot, split out of
// serve_ready.go (at its line ceiling). See connectedUserIDs.

// connectedUserIDs snapshots the ids with a live WebSocket connection.
func (h *Hub) connectedUserIDs() map[int64]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	set := make(map[int64]bool, len(h.clients))
	for uid := range h.clients {
		set[uid] = true
	}
	return set
}

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
