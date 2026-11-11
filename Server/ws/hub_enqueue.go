package ws

import "time"

// contentEnqueueWait is how long enqueue holds a content-bearing frame for room on a full broadcast
// queue before dropping it. A drop forces every resuming client through a full resync, so a message
// is worth a brief wait; other frames never wait (presence and metadata producers include the hub's
// own timers).
var contentEnqueueWait = time.Second

// enqueue hands bm to the single dispatch loop, stamping it for the enqueue-to-fanout latency
// metric. A content frame on a full channel waits up to contentEnqueueWait (never past hub stop);
// any other frame, or one still without room, is dropped and counted under kind, and enqueue
// returns false. A waiting frame can be overtaken by another producer, so cross-producer order is
// not guaranteed during the wait.
func (h *Hub) enqueue(bm broadcastMsg, kind string) bool {
	bm.enqueuedAt = time.Now()
	select {
	case h.broadcast <- bm:
		return true
	default:
	}
	if bm.nsfwChannelID != 0 && contentEnqueueWait > 0 {
		timer := time.NewTimer(contentEnqueueWait)
		defer timer.Stop()
		select {
		case h.broadcast <- bm:
			return true
		case <-timer.C:
		case <-h.stop:
		}
	}
	h.recordQueueDrop(bm, kind)
	return false
}
