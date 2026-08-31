package ws

import (
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// pendingPresence is the coalescer's latest-wins entry for one user.
type pendingPresence struct {
	status       string
	customStatus *string
}

// QueuePresence coalesces connect/disconnect presence broadcasts: the latest
// state per user is buffered for presenceCoalesceWindow and then flushed via
// BroadcastPresence. Each un-coalesced presence change is a sequenced global
// broadcast — an O(connected clients) fan-out under seqMu — so a reconnect
// storm (proxy blip, deploy, network hiccup) used to fire O(users) of them
// from the connect critical path all at once. Latest-wins is exactly
// presence's semantics: a flap inside the window collapses to its final
// state, and the flushed frames are ordinary sequenced presence messages, so
// the wire format and replay behaviour are unchanged. User-chosen status
// changes (presence_update handler) do not pass through here.
func (h *Hub) QueuePresence(userID int64, status string, customStatus *string) {
	h.presenceMu.Lock()
	if h.presenceQueue == nil {
		h.presenceQueue = make(map[int64]pendingPresence)
	}
	h.presenceQueue[userID] = pendingPresence{status: status, customStatus: customStatus}
	armed := h.presenceFlushArmed
	h.presenceFlushArmed = true
	h.presenceMu.Unlock()
	if !armed {
		time.AfterFunc(presenceCoalesceWindow, h.flushPresenceQueue)
	}
}

// dropQueuedPresenceAndBroadcast atomically removes any coalesced presence
// still queued for userID and runs broadcast, both under presenceMu. Called
// when a fresher presence for that user is delivered directly (the
// presence_update handler path, via EmitEvents), so the delete and the send
// of the fresher frame can never straddle flushPresenceQueue's own
// snapshot-and-broadcast critical section (OC-0005).
//
// Holding presenceMu across the delete AND the broadcast — rather than just
// the delete — is what actually closes the race: whichever of this call and

// presenceCoalesceWindow is how long QueuePresence buffers connect/disconnect
// presence before flushing. Long enough to collapse a socket flap
// (disconnect+reconnect through a proxy blip) into one frame, short enough
// that a genuine arrival still looks immediate to humans.
const presenceCoalesceWindow = 300 * time.Millisecond

// presenceFlushRaceHook, when non-nil, runs once per flushPresenceQueue call
// immediately after the coalesced queue has been snapshotted and cleared,
// while presenceMu is still held. Test-only (always nil in production): the
// snapshot-to-broadcast window is too narrow to land a real concurrent
// dropQueuedPresenceAndBroadcast reliably, so tests use this hook to
// reproduce that interleaving deterministically. Mirrors the established
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern.
//
// It is handed the Hub being flushed, and a test that installs it MUST
// ignore calls for any other Hub. The hook is package-global but flushes are
// per-Hub, and QueuePresence's AfterFunc outlives the test that armed it:
// dropQueuedPresenceAndBroadcast clears the queue without disarming the
// timer, so a sibling test's 300ms flush fires long after that test returned
// — into whatever hook is installed by then. Passing the Hub is what lets the
// installer tell its own flush from that stray one; without it, a hook body
// that is only safe to run once (closing a channel, say) panics.
var presenceFlushRaceHook func(*Hub)

// flushPresenceQueue acquires presenceMu second also enqueues its broadcast
// second.
//   - If this call goes first, it deletes the entry before flush can ever
//     snapshot it, so flush never broadcasts the stale state at all.
//   - If flush goes first, this call's delete is a no-op against the
//     already-cleared queue, but its broadcast still cannot run until flush's
//     own broadcast has already been enqueued — so the fresher frame is
//     stamped with the higher seq by deliverBroadcast's single FIFO consumer
//     and every client's final view converges on it, not the stale one.
//
// broadcast runs with presenceMu held: every current caller (BroadcastToAll,
// BroadcastToAllExcept) only enqueues onto h.broadcast's non-blocking
// channel send, so this cannot block and introduces no new lock-order edge.
// Both callers sharing that same channel also means the "enqueues second"
// ordering guarantee above translates directly into delivery order: both
// broadcasts are drained by the same single-consumer hub dispatch loop
// (deliverBroadcast), in the order they were enqueued.
func (h *Hub) dropQueuedPresenceAndBroadcast(userID int64, broadcast func()) {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	delete(h.presenceQueue, userID)
	broadcast()
}

// flushPresenceQueue drains the coalescer and broadcasts each user's latest
// presence, all under presenceMu (OC-0005). Runs on the AfterFunc timer
// goroutine.
//
// presenceMu is held across the broadcast loop, not just the snapshot: it
// used to be released beforehand, which let a concurrent
// dropQueuedPresenceAndBroadcast (nee dropQueuedPresence) call race in after
// the snapshot had already escaped the lock. The drop was then a guaranteed
// no-op against the live (already-nilled) map, AND nothing constrained
// whether that call's own fresher broadcast landed on h.broadcast before or
// after this loop's stale one — so the stale connect-time presence could win
// the seq race and permanently overwrite a user-chosen status. Holding the
// lock here forces the two critical sections to serialize, which is what
// dropQueuedPresenceAndBroadcast's ordering guarantee depends on.
func (h *Hub) flushPresenceQueue() {
	h.presenceMu.Lock()
	defer h.presenceMu.Unlock()
	queued := h.presenceQueue
	h.presenceQueue = nil
	h.presenceFlushArmed = false
	if presenceFlushRaceHook != nil {
		presenceFlushRaceHook(h)
	}
	for uid, p := range queued {
		h.BroadcastPresence(uid, p.status, p.customStatus)
	}
}

// BroadcastPresence fans a presence change out with the invisible mapping
// applied: everyone else sees db.BroadcastStatus(status), the user themselves
// sees the truth. It is the non-handler counterpart of presenceEvents, used by
// the connect and disconnect paths (via the QueuePresence coalescer, which
// delivers through here).
func (h *Hub) BroadcastPresence(userID int64, status string, customStatus *string) {
	public := db.BroadcastStatus(status)
	if public == status {
		h.BroadcastToAll(buildPresenceMsg(userID, status, customStatus))
		return
	}
	// The public frame's status already collapsed to db.BroadcastStatus, but
	// customStatus does not: passing it through verbatim would tell every
	// other client an "offline" member's real free-text status, which is a
	// tell that they are actually online. Blank it explicitly (not omitted —
	// presencePayload.CustomStatus has no omitempty) so the client clears any
	// cached text, matching what db.MemberSummary.ForViewer already does for
	// the ready payload's member list.
	//
	// Normal priority, excluding the owner (BroadcastToAllExcept), not
	// broadcastExcludeLow: the low-priority queue is unsequenced and dropped
	// (not disconnected) on overflow, so it could silently lose this frame
	// with no replay recovery, and — since writePump always drains normal
	// strictly before low — deliver it out of order against the very
	// connect/disconnect presence frames this same coalescer flush also
	// produces for other users via BroadcastToAll (OC-0003).
	h.BroadcastToAllExcept(userID, buildPresenceMsg(userID, public, nil))
	h.SendToUser(userID, buildPresenceMsg(userID, status, customStatus))
}
