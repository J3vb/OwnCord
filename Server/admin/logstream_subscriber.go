package admin

import (
	"fmt"
	"time"
)

// logSubscriber is one live viewer's feed: its channel, and how many lines
// Write has had to skip since the viewer last had room. dropped is guarded by
// RingBuffer.mu.
type logSubscriber struct {
	ch      chan LogEntry
	dropped int
}

// deliver hands entry to a viewer without ever blocking. When the viewer fell
// behind, it first queues a marker saying how many lines were skipped, but only
// when the line itself also fits: a viewer that frees one slot at a time would
// otherwise get nothing but markers. The marker goes only to this viewer, never
// into the ring or the history. Callers hold rb.mu, and only Write sends, so
// the free space read here can only grow before the sends.
func (sub *logSubscriber) deliver(entry LogEntry) {
	if sub.dropped > 0 && cap(sub.ch)-len(sub.ch) >= 2 {
		marker := LogEntry{
			Timestamp: time.Now().Format(time.RFC3339Nano),
			Level:     "WARN",
			Message:   fmt.Sprintf("%d lines skipped (viewer fell behind)", sub.dropped),
			Source:    "admin",
		}
		select {
		case sub.ch <- marker:
			sub.dropped = 0
		default:
		}
	}
	select {
	case sub.ch <- entry:
	default:
		sub.dropped++
	}
}
