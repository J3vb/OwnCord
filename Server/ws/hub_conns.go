package ws

import "slices"

// maxConnectionsPerUser caps one account's live connections; the 11th registration evicts the
// oldest connection of another session with SESSION_REPLACED (registerNow).
const maxConnectionsPerUser = 10

// The per-user connection registry: one live connection per device session (Client.tokenHash);
// Hub.clients maps a user to all of them, oldest first. Pick an accessor instead of asking for
// "the" client: clientsOf (fan-out), isConnected (presence), voiceClient (the connection holding
// the call). The slices are copy-on-write, so a reader may keep iterating one after releasing h.mu.

func (h *Hub) clientsOf(userID int64) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.clients[userID]
}

func (h *Hub) isConnected(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// voiceClient returns the connection whose voice slot holds a call, or nil. A user has at most one
// call (a second device's voice_join moves it), so at most one matches.
func (h *Hub) voiceClient(userID int64) *Client {
	for _, c := range h.clientsOf(userID) {
		if c.voice.channel() != 0 {
			return c
		}
	}
	return nil
}

func (h *Hub) isRegistered(c *Client) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.registeredLocked(c)
}

// registeredLocked is isRegistered for a caller holding h.mu.
func (h *Hub) registeredLocked(c *Client) bool {
	return slices.Contains(h.clients[c.userID], c)
}

// allClientsLocked flattens every connection; the caller holds h.mu.
func (h *Hub) allClientsLocked() []*Client {
	n := 0
	for _, list := range h.clients {
		n += len(list)
	}
	out := make([]*Client, 0, n)
	for _, list := range h.clients {
		out = append(out, list...)
	}
	return out
}

// connectedUserIDsLocked lists connected users; the caller holds h.mu.
func (h *Hub) connectedUserIDsLocked() []int64 {
	ids := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		ids = append(ids, uid)
	}
	return ids
}

// connectionCountLocked is the number of live connections; the caller holds h.mu.
func (h *Hub) connectionCountLocked() int {
	n := 0
	for _, list := range h.clients {
		n += len(list)
	}
	return n
}

// sessionClientLocked returns the session's connection or nil; the caller holds h.mu.
func (h *Hub) sessionClientLocked(userID int64, tokenHash string) *Client {
	for _, e := range h.clients[userID] {
		if e.tokenHash == tokenHash {
			return e
		}
	}
	return nil
}

// addClientLocked appends c as the user's newest connection; the caller holds h.mu.
func (h *Hub) addClientLocked(c *Client) {
	old := h.clients[c.userID]
	next := make([]*Client, len(old), len(old)+1)
	copy(next, old)
	h.clients[c.userID] = append(next, c)
	c.regGen = h.connGen.Add(1)
}

// removeClientLocked drops c, reporting whether it was registered; the user's entry goes with its
// last connection. Caller holds h.mu.
func (h *Hub) removeClientLocked(c *Client) bool {
	old := h.clients[c.userID]
	for i, e := range old {
		if e != c {
			continue
		}
		h.connGen.Add(1)
		if len(old) == 1 {
			delete(h.clients, c.userID)
			return true
		}
		next := make([]*Client, 0, len(old)-1)
		next = append(next, old[:i]...)
		next = append(next, old[i+1:]...)
		h.clients[c.userID] = next
		return true
	}
	return false
}

// anyConnInVoiceChannelLocked reports whether one of userID's connections holds a call in
// channelID. Caller holds h.mu (order: h.mu then voiceSlot.voiceMu).
func (h *Hub) anyConnInVoiceChannelLocked(userID, channelID int64) bool {
	for _, c := range h.clients[userID] {
		if c.voice.channel() == channelID {
			return true
		}
	}
	return false
}

// sessionClient returns userID's live connection of the session, i.e. the replacement after a same-
// session reconnect, or nil if the device has gone.
func (h *Hub) sessionClient(userID int64, tokenHash string) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.sessionClientLocked(userID, tokenHash)
}

func (h *Hub) topicsOfUser(userID int64) []Topic {
	conns := h.clientsOf(userID)
	if len(conns) == 1 {
		return h.pubsub.TopicsForClient(conns[0])
	}
	seen := map[Topic]struct{}{}
	var out []Topic
	for _, c := range conns {
		for _, t := range h.pubsub.TopicsForClient(c) {
			if _, dup := seen[t]; !dup {
				seen[t] = struct{}{}
				out = append(out, t)
			}
		}
	}
	return out
}

// voiceHeldByOtherSession reports whether the call in channelID belongs to another session: a live
// connection of a different session holds it, or it is parked in the reconnect grace window. The
// caller holds the user's voice membership lock, so the answer cannot change under it.
func (h *Hub) voiceHeldByOtherSession(c *Client, channelID int64) bool {
	for _, o := range h.clientsOf(c.userID) {
		if o.tokenHash != c.tokenHash && o.voice.channel() != 0 {
			return true
		}
	}
	if e := h.voiceHub.reg.voiceGrace.get(c.userID); e != nil && e.client.tokenHash != c.tokenHash && e.snap.chID == channelID {
		return true
	}
	return false
}
