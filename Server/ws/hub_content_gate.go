package ws

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/J3vb/OwnCord/Server/stackutil"
)

// contentGateTimeout bounds one NSFW gate read (label and acknowledgement list); on timeout the
// gate fails closed and the frame forces a resync.
const contentGateTimeout = time.Second

// gateResult is a resolved NSFW gate: who may receive the frame live, whether the channel is
// labelled, and whether it stands in for an answer the database could not give (deny-all, watermark
// bumped).
type gateResult struct {
	allow       func(userID int64) bool
	labelled    bool
	unconfirmed bool
}

type gateResolution struct {
	channelID int64
	through   uint64
	gateResult
}

type parkedEntry struct {
	bm      broadcastMsg
	ticket  uint64
	content bool
	gate    *gateResult
}

// gateLane holds a channel's frames while its gate is read, in enqueue order; the head is always
// unresolved content with a read in flight, so a lane drains within one contentGateTimeout.
type gateLane struct {
	entries  []parkedEntry
	inFlight bool
}

type parkedBarrier struct {
	ticket uint64
	done   chan struct{}
}

// contentGates keeps the dispatch goroutine off the database. A content frame parks in its
// channel's lane while a resolver reads the gate with a timeout, and later frames for that channel
// queue behind it (order kept); other channels and global frames deliver at once. A seq is
// allocated only at delivery.
// Owned by the dispatch goroutine: no lock. Resolvers take no hub lock; deliverGated takes seqMu.
type contentGates struct {
	lanes    map[int64]*gateLane
	parked   int
	ticket   uint64
	barriers []parkedBarrier
	results  chan gateResolution
	timeout  time.Duration // 0 = contentGateTimeout; tests shorten it
}

// initContentGates makes the results channel on first use; only the dispatch goroutine calls it,
// and Run re-reads h.gates.results on every select.
func (h *Hub) initContentGates() {
	if h.gates.results == nil {
		h.gates.results = make(chan gateResolution, 16)
	}
}

func (h *Hub) contentGateTimeout() time.Duration {
	if h.gates.timeout > 0 {
		return h.gates.timeout
	}
	return contentGateTimeout
}

func (h *Hub) lifeCtx() context.Context {
	if h.lifecycle.ctx != nil {
		return h.lifecycle.ctx
	}
	return context.Background()
}

// broadcastIn is the queue Run reads, or nil while as many frames are parked as the queue holds, so
// a stalled database pushes back through enqueue's wait and drop accounting instead of growing
// memory.
func (h *Hub) broadcastIn() chan broadcastMsg {
	if h.gates.parked >= cap(h.broadcast) {
		return nil
	}
	return h.broadcast
}

func (h *Hub) dispatch(bm broadcastMsg) {
	g := &h.gates
	switch {
	case bm.barrier != nil:
		if g.parked == 0 {
			close(bm.barrier)
			return
		}
		g.ticket++
		g.barriers = append(g.barriers, parkedBarrier{ticket: g.ticket, done: bm.barrier})
		return
	case bm.presenceSnapshot:
		h.deliverPresenceSnapshots()
		return
	}
	h.observeDispatchLag(bm.enqueuedAt)

	if bm.nsfwChannelID != 0 {
		// The hook runs on the dispatch goroutine before the read is issued, so a revocation or
		// relabel completed by now is honoured.
		if nsfwDispatchResolveRaceHook != nil {
			nsfwDispatchResolveRaceHook(bm.nsfwChannelID)
		}
		if h.db == nil && g.lanes[bm.nsfwChannelID] == nil {
			h.deliverGated(bm, gateResult{})
			return
		}
		h.park(bm.nsfwChannelID, bm, true)
		return
	}
	key := bm.channelID
	if key == 0 {
		key = bm.laneChannelID
	}
	if key != 0 && g.lanes[key] != nil {
		h.park(key, bm, false)
		return
	}
	h.deliverGated(bm, gateResult{})
}

func (h *Hub) park(channelID int64, bm broadcastMsg, content bool) {
	g := &h.gates
	if g.lanes == nil {
		g.lanes = make(map[int64]*gateLane)
	}
	lane := g.lanes[channelID]
	if lane == nil {
		lane = &gateLane{}
		g.lanes[channelID] = lane
	}
	g.ticket++
	lane.entries = append(lane.entries, parkedEntry{bm: bm, ticket: g.ticket, content: content})
	g.parked++
	if content && !lane.inFlight {
		h.issueGate(channelID, lane)
	}
}

// issueGate starts one read covering every content entry parked so far: a backlog costs one more
// round trip, not one per frame.
func (h *Hub) issueGate(channelID int64, lane *gateLane) {
	h.initContentGates()
	lane.inFlight = true
	through := h.gates.ticket
	life, timeout, results := h.lifeCtx(), h.contentGateTimeout(), h.gates.results
	h.lifecycle.sweeps.Go(func() {
		res := gateResolution{channelID: channelID, through: through, gateResult: h.resolveGateOnce(life, timeout, channelID)}
		select {
		case results <- res:
		case <-life.Done():
		}
	})
}

// resolveGateOnce reads the gate under its own timeout. A software panic fails closed like a read
// error; a hardware fault re-panics.
func (h *Hub) resolveGateOnce(life context.Context, timeout time.Duration, channelID int64) (res gateResult) {
	defer func() {
		if r := recover(); r != nil {
			if stackutil.Recovered(r) {
				panic(r)
			}
			slog.Error("hub: content gate read panicked, denying all recipients",
				"channel_id", channelID, "panic", r, "stack", stackutil.Capture())
			res = gateResult{allow: func(int64) bool { return false }, labelled: true, unconfirmed: true}
		}
	}()
	ctx, cancel := context.WithTimeout(life, timeout)
	defer cancel()
	allow, labelled, unconfirmed := h.resolveChannelContentGate(ctx, channelID)
	return gateResult{allow: allow, labelled: labelled, unconfirmed: unconfirmed}
}

func (h *Hub) onGateResolved(res gateResolution) {
	lane := h.gates.lanes[res.channelID]
	if lane == nil {
		return
	}
	lane.inFlight = false
	defer h.releaseBarriers()
	// Deferred so a delivery that panics cannot strand the lane: an empty one is removed and a non-
	// empty one gets a fresh read after the loop restarts.
	defer func() {
		switch {
		case len(lane.entries) == 0:
			delete(h.gates.lanes, res.channelID)
		case !lane.inFlight:
			h.issueGate(res.channelID, lane)
		}
	}()
	r := res.gateResult
	for i := range lane.entries {
		e := &lane.entries[i]
		if e.content && e.gate == nil && e.ticket <= res.through {
			e.gate = &r
		}
	}
	for len(lane.entries) > 0 {
		e := lane.entries[0]
		if e.content && e.gate == nil {
			break
		}
		lane.entries[0] = parkedEntry{}
		lane.entries = lane.entries[1:]
		h.gates.parked--
		var gate gateResult
		if e.gate != nil {
			gate = *e.gate
		}
		h.deliverGated(e.bm, gate)
	}
}

// closeParkedBarriers releases every barrier still parked when Run exits; nothing will drain the
// lanes, and awaitDispatch should not wait out its ctx.
func (h *Hub) closeParkedBarriers() {
	for _, b := range h.gates.barriers {
		close(b.done)
	}
	h.gates.barriers = nil
}

func (h *Hub) releaseBarriers() {
	g := &h.gates
	if len(g.barriers) == 0 {
		return
	}
	oldest := uint64(math.MaxUint64)
	for _, lane := range g.lanes {
		if len(lane.entries) > 0 && lane.entries[0].ticket < oldest {
			oldest = lane.entries[0].ticket
		}
	}
	keep := g.barriers[:0]
	for _, b := range g.barriers {
		if b.ticket < oldest {
			close(b.done)
			continue
		}
		keep = append(keep, b)
	}
	clear(g.barriers[len(keep):])
	g.barriers = keep
}

// deliverBroadcast delivers one entry synchronously, reading the gate inline. For callers that need
// the frame delivered first (tests), and only while Run is not running, since it reads gate state
// the dispatch goroutine owns.
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
	if bm.barrier != nil {
		close(bm.barrier)
		return
	}
	if bm.presenceSnapshot {
		h.deliverPresenceSnapshots()
		return
	}
	h.observeDispatchLag(bm.enqueuedAt)
	var gate gateResult
	if bm.nsfwChannelID != 0 {
		if nsfwDispatchResolveRaceHook != nil {
			nsfwDispatchResolveRaceHook(bm.nsfwChannelID)
		}
		gate = h.resolveGateOnce(h.lifeCtx(), h.contentGateTimeout(), bm.nsfwChannelID)
	}
	h.deliverGated(bm, gate)
}
