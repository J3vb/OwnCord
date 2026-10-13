package ws

import "time"

// contentEnqueueWait is how long enqueue holds a content-bearing frame
// (chat_message, chat_edited, reaction_update, plugin_broadcast) for room on
// a full broadcast queue before dropping it. A short burst drains well inside
// it, and a drop forces every resuming client through a full resync, so a
// message is worth a brief wait on the request that produced it. Other frames
// never wait: presence and metadata producers include the hub's own timers.
var contentEnqueueWait = time.Second

// enqueue hands bm to the single hub dispatch loop, stamping it for the
// enqueue→fanout latency metric. If the broadcast channel is full, a
// content-bearing frame waits up to contentEnqueueWait for room (never past
// hub stop); any other frame, or one still without room, is dropped and
// counted, with kind naming the dropped frame, and enqueue reports false.
// A waiting content frame can be overtaken by another producer's frame that
// takes the freed slot first, so delivery order across producers is not
// guaranteed during the wait.
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
