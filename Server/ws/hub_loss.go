package ws

import "context"

// A hub-level loss is a sequenced frame that reached no connection: one
// enqueue dropped on a full broadcast queue, or one a content gate withheld
// because the gate could not be read. Replay cannot fill it, so every
// connected recipient is marked: its user's next resume takes the full ready
// (presenceRepair.users), and its socket's next cseq skips one, so a client
// that stays connected sees the gap and resumes (WP 2A-5).
//
// Lock order: markLoss runs on the dispatch goroutine under seqMu and takes
// h.mu (read) or ps.mu (read), releasing each before marking.
// presenceRepair.mu and queueDropState.mu are leaves. No client mu is taken.

// queueDropRouteCap bounds the drop routes kept between two dispatches; past
// it the pending drops are marked as one global loss.
const queueDropRouteCap = 64

// lossRoute names a lost frame's audience the way broadcastMsg does:
// recipients, else a channel's subscribers, else every client but
// excludeUserID.
type lossRoute struct {
	channelID     int64
	recipients    []int64
	excludeUserID int64
}

// markLoss marks every connected recipient of r. Called under seqMu.
func (h *Hub) markLoss(r lossRoute) {
	var clients []*Client
	switch {
	case r.recipients != nil:
		for _, uid := range r.recipients {
			clients = append(clients, h.clientsOf(uid)...)
		}
	case r.channelID != 0:
		clients = h.pubsub.subscribers(ChannelTopic(r.channelID), 0)
	default:
		clients = h.pubsub.subscribers(TopicGlobal, r.excludeUserID)
	}
	for _, c := range clients {
		h.setPresenceResync(c.userID, c.tokenHash, true)
		c.cseq.lossPending.Store(true)
	}
	h.queueDrops.lossMarks.Add(uint64(len(clients)))
}

// noteDropRoute keeps a dropped frame's audience for the dispatch goroutine
// to mark (markDroppedRoutes). Runs on the producer. Presence frames are left
// out: flushPresenceQueue repairs a lost batch with a snapshot, and a gap
// would send every client to a resume for it.
func (h *Hub) noteDropRoute(bm broadcastMsg) {
	if bm.presenceSnapshot || bm.droppable {
		return
	}
	q := &h.queueDrops
	q.mu.Lock()
	if len(q.routes) < queueDropRouteCap {
		q.routes = append(q.routes, lossRoute{channelID: bm.channelID, recipients: bm.recipients, excludeUserID: bm.excludeUserID})
	} else {
		q.routesOverflow = true
	}
	q.mu.Unlock()
	q.routesPending.Store(true)
}

// markDroppedRoutes marks the audiences noteDropRoute kept. Dispatch
// goroutine, under seqMu. A full ready covers a loss from any position, so
// marking need not wait for the drop to settle into the watermark.
func (h *Hub) markDroppedRoutes() {
	q := &h.queueDrops
	if !q.routesPending.Swap(false) {
		return
	}
	q.mu.Lock()
	routes, overflow := q.routes, q.routesOverflow
	q.routes, q.routesOverflow = nil, false
	q.mu.Unlock()
	if overflow {
		h.markLoss(lossRoute{})
		return
	}
	for _, r := range routes {
		h.markLoss(r)
	}
}

// takeOwedResync clears c's user's owed full ready, and then c's pending
// cseq skip, for a fresh ready about to be built: that ready covers every
// loss marked before it. Reports whether a resync was owed, so a ready that
// never reaches the client can restore it.
func (h *Hub) takeOwedResync(c *Client) bool {
	owed := h.setPresenceResync(c.userID, c.tokenHash, false)
	c.cseq.lossPending.Store(false)
	return owed
}

// LossMarkCount is the cumulative number of connections marked for a lost
// frame (markLoss) since start.
func (h *Hub) LossMarkCount() uint64 { return h.queueDrops.lossMarks.Load() }

// replayFrameAllowed gates one replayed content frame (frameReadableNow). A
// frame withheld because the gate could not be read is lost to this
// connection like a failed live gate: its next resume takes the full ready,
// and the next cseq skips one. The handshake goroutine is c's writer here.
func (h *Hub) replayFrameAllowed(ctx context.Context, c *Client, channelID int64) bool {
	readable, confirmed := h.frameReadableNow(ctx, c.user.ID, channelID)
	if !confirmed {
		h.setPresenceResync(c.userID, c.tokenHash, true)
		c.cseq.lossPending.Store(true)
		h.queueDrops.lossMarks.Add(1)
	}
	return readable
}
