package ws

import "github.com/J3vb/OwnCord/Server/syncutil"

// presenceFeedState groups the presence coalescer: the queued latest presence per user, whether a
// flush is armed, and the dropped-presence repair state. mu is the rank-4 feed lock
// (lock_order.go); never copy it.
type presenceFeedState struct {
	// queue and flushArmed are guarded by mu.
	mu         syncutil.Ranked[lockRankFeed]
	queue      map[int64]pendingPresence
	flushArmed bool
	repair     presenceRepairState // dropped presence and its repair (hub_presence.go)
}
