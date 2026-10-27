package ws

import "github.com/J3vb/OwnCord/Server/permissions"

// threadFocusBeforeSubscribeHook, when non-nil, runs in applyThreadFocus after
// the slot is set and before the Subscribe: the window a concurrent release can
// land in. Test-only (always nil in production).
var threadFocusBeforeSubscribeHook func(c *Client, threadID int64)

// applyThreadFocus moves c's thread slot (thread_focus) to newID, 0 to close
// it, and updates the topic subscription to match. It is applySetChannelID's
// twin for the second slot and follows the same rule for the same reason
// (OC-0024): the handler's admission and the Subscribe are separated by
// database round trips, and a revoke that commits inside that window finds
// nothing to undo. So once Subscribe has run the slot is re-validated live with
// permissions.CanAdmitSession, through the thread's own channel row and so
// through its parent's overrides, and unwound on a concrete refusal. A
// transient read failure is not a refusal; the sweeps stay authoritative.
//
// It takes focusMu, the same lock every channel_focus apply holds, so the two
// slots are never moved by two goroutines at once.
func (h *Hub) applyThreadFocus(c *Client, newID int64) {
	c.focusMu.Lock()
	defer c.focusMu.Unlock()
	c.mu.Lock()
	oldID := c.threadID
	c.threadID = newID
	c.mu.Unlock()
	if oldID == newID {
		return
	}
	if oldID > 0 {
		h.pubsub.Unsubscribe(c, ChannelTopic(oldID))
	}
	if newID <= 0 {
		return
	}
	if h.refusesForumTopic(c, newID) {
		c.mu.Lock()
		if c.threadID == newID {
			c.threadID = 0
		}
		c.mu.Unlock()
		return
	}
	if threadFocusBeforeSubscribeHook != nil {
		threadFocusBeforeSubscribeHook(c, newID)
	}
	h.pubsub.Subscribe(c, ChannelTopic(newID))
	// The slot was set before the Subscribe, so a release (a parent revoke, a
	// delete) can clear it in between and then find nothing to unsubscribe. On
	// every way out, a topic the slot no longer names is dropped.
	defer func() {
		c.mu.Lock()
		kept := c.threadID == newID
		c.mu.Unlock()
		if !kept {
			h.pubsub.Unsubscribe(c, ChannelTopic(newID))
		}
	}()
	ch, err := h.readers.Dispatch.GetChannel(c.ctx, newID)
	if err != nil {
		return
	}
	// A socket without the forums feature never holds a forum post's topic.
	if ch != nil && ch.IsThread() && !withholdsForumPost(c.ctx, h.readers.Dispatch, c, ch) {
		sub, subErr := h.subjectFor(c.ctx, c.userID, newID)
		if subErr != nil {
			return
		}
		sub.Channel = channelRef(ch)
		if permissions.CanAdmitSession(sub) == nil {
			return
		}
	}
	h.pubsub.Unsubscribe(c, ChannelTopic(newID))
	c.mu.Lock()
	if c.threadID == newID {
		c.threadID = 0
	}
	c.mu.Unlock()
}

// releaseThreadSocket drops the thread topic a socket holds: it unsubscribes,
// clears the slot, and tells the client with the thread_deleted frame when
// there is one (a nil frame is a silent revoke).
func (h *Hub) releaseThreadSocket(c *Client, threadID int64, frame []byte) {
	if frame != nil {
		c.sendMsg(frame)
	}
	h.pubsub.Unsubscribe(c, ChannelTopic(threadID))
	c.mu.Lock()
	if c.threadID == threadID {
		c.threadID = 0
	}
	c.mu.Unlock()
}

// releaseThreadSockets releases every socket that has threadID open: the thread
// was deleted. Each hears an unsequenced thread_deleted first, because a
// socket that has the thread open need not be on the parent's topic and so may
// miss the sequenced copy.
func (h *Hub) releaseThreadSockets(threadID, parentID int64) {
	h.mu.RLock()
	holders := make([]*Client, 0, 4)
	for _, c := range h.allClientsLocked() {
		if c.getThreadID() == threadID {
			holders = append(holders, c)
		}
	}
	h.mu.RUnlock()
	if len(holders) == 0 {
		return
	}
	frame := buildThreadDeleted(parentID, threadID)
	for _, c := range holders {
		h.releaseThreadSocket(c, threadID, frame)
	}
}

// holdsThread reports whether one of userID's live sockets has threadID in its
// second slot.
func (h *Hub) holdsThread(userID, threadID int64) bool {
	for _, c := range h.clientsOf(userID) {
		if c.getThreadID() == threadID {
			return true
		}
	}
	return false
}
