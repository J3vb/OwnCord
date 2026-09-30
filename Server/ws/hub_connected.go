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

// liveStatuses snapshots each connected user's live status (Client.liveStatus),
// "" for a connection that has not stamped one yet.
func (h *Hub) liveStatuses() map[int64]string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]string, len(h.clients))
	for uid, c := range h.clients {
		out[uid] = c.liveStatus()
	}
	return out
}
