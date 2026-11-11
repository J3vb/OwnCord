package ws

import "context"

// A hub-level loss is a sequenced frame that reached no connection (an enqueue dropped on a full
// queue, or one a content gate withheld because it could not be read). Replay cannot fill it, so
// every connected recipient is marked: its user's next resume takes the full ready, and its
// socket's next cseq skips one so a connected client sees the gap and resumes.
// Lock order: markLoss runs on the dispatch goroutine under seqMu and takes h.mu (read) or ps.mu
// (read), releasing each before marking. presenceFeed.repair.mu and queueDropState.mu are leaves;
// no client mu is taken.

// queueDropRouteCap bounds the drop routes kept between dispatches; past it the pending drops are
// marked as one global loss.
const queueDropRouteCap = 64

type lossRoute struct {
	channelID     int64
	recipients    []int64
	excludeUserID int64
	// audienceMark is the lost frame's broadcastMsg.audienceMark.
	audienceMark uint64
}

func (h *Hub) markLoss(r lossRoute) {
	var clients []*Client
	switch {
	case r.recipients != nil:
		for _, uid := range r.recipients {
			clients = append(clients, h.clientsOf(uid)...)
		}
		// The wider voice match is used whatever the frame was: marking a
		// connection that would not have received it costs one resync.
		clients = append(clients, h.lateResumes(r.audienceMark, r.channelID, r.recipients, true)...)
	case r.channelID != 0:
		clients = h.pubsub.subscribers(ChannelTopic(r.channelID), 0)
	default:
		clients = h.pubsub.subscribers(TopicGlobal, r.excludeUserID)
	}
	for _, c := range clients {
		h.setPresenceResync(c.userID, c.tokenHash, true)
		c.cseq.lossPending.Store(true)
	}
	h.stats.queueDrops.lossMarks.Add(uint64(len(clients)))
}

// markClientLoss marks one connection as having missed frames (full ready on resume, cseq skip).
// Safe from any goroutine (an atomic and a leaf lock), for a producer that knows whom it did not
// reach.
func (h *Hub) markClientLoss(c *Client) {
	h.setPresenceResync(c.userID, c.tokenHash, true)
	c.cseq.lossPending.Store(true)
	h.stats.queueDrops.lossMarks.Add(1)
}

// noteDropRoute keeps a dropped frame's audience for the dispatch goroutine to mark
// (markDroppedRoutes). Presence frames are left out: flushPresenceQueue repairs a lost batch with a
// snapshot, and a gap would send every client to a resume.
func (h *Hub) noteDropRoute(bm broadcastMsg) {
	if bm.presenceSnapshot || bm.droppable {
		return
	}
	q := &h.stats.queueDrops
	q.mu.Lock()
	if len(q.routes) < queueDropRouteCap {
		q.routes = append(q.routes, lossRoute{
			channelID: bm.channelID, recipients: bm.recipients, excludeUserID: bm.excludeUserID, audienceMark: bm.audienceMark,
		})
	} else {
		q.routesOverflow = true
	}
	q.mu.Unlock()
	q.routesPending.Store(true)
}

// noteRecipientsLoss keeps a loss route for users a producer could not resolve (a failed permission
// lookup left them out of a recipients frame); same list, cap and overflow handling as
// noteDropRoute.
func (h *Hub) noteRecipientsLoss(userIDs []int64) {
	if len(userIDs) == 0 {
		return
	}
	q := &h.stats.queueDrops
	q.mu.Lock()
	if len(q.routes) < queueDropRouteCap {
		q.routes = append(q.routes, lossRoute{recipients: userIDs})
	} else {
		q.routesOverflow = true
	}
	q.mu.Unlock()
	q.routesPending.Store(true)
}

// markDroppedRoutes marks the audiences noteDropRoute kept, on the dispatch goroutine under seqMu.
// A full ready covers a loss from any position, so marking need not wait for the drop to settle
// into the watermark.
func (h *Hub) markDroppedRoutes() {
	q := &h.stats.queueDrops
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

// takeOwedResync clears c's user's owed full ready and c's pending cseq skip for a fresh ready
// about to be built (it covers every earlier loss). Reports whether one was owed, so a ready that
// never reaches the client can restore it.
func (h *Hub) takeOwedResync(c *Client) bool {
	owed := h.setPresenceResync(c.userID, c.tokenHash, false)
	c.cseq.lossPending.Store(false)
	return owed
}

// LossMarkCount is the cumulative number of connections marked for a lost frame (markLoss) since
// start.
func (h *Hub) LossMarkCount() uint64 { return h.stats.queueDrops.lossMarks.Load() }

// replayFrameAllowed gates one replayed content frame. A frame withheld because the gate could not
// be read is lost to this connection like a failed live gate. The handshake goroutine is c's writer
// here.
func (h *Hub) replayFrameAllowed(ctx context.Context, c *Client, channelID int64) bool {
	readable, confirmed := h.frameReadableNow(ctx, c.user.ID, channelID)
	if !confirmed {
		h.setPresenceResync(c.userID, c.tokenHash, true)
		c.cseq.lossPending.Store(true)
		h.stats.queueDrops.lossMarks.Add(1)
	}
	return readable
}
