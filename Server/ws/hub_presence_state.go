package ws

import "github.com/J3vb/OwnCord/Server/syncutil"

// presenceFeedState groups the hub's presence coalescer: the queued latest
// presence per user, whether a flush is armed, and the dropped-presence repair
// state. mu is the rank-4 feed lock (see lock_order.go) and must never be
// copied.
type presenceFeedState struct {
	// Presence coalescer (QueuePresence): latest presence per user, flush armed.
	// queue and flushArmed are guarded by mu.
	mu         syncutil.Ranked[lockRankFeed]
	queue      map[int64]pendingPresence
	flushArmed bool
	repair     presenceRepairState // dropped presence and its repair (hub_presence.go)
}
