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
