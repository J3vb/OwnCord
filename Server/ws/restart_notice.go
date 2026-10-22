package ws

import (
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// restartNoticeDedupeWindow is how long an identical restart announcement
// suppresses a repeat.
const restartNoticeDedupeWindow = 10 * time.Second

// restartNoticeGate remembers the last restart announcement. Its mutex is a
// leaf lock: nothing is acquired while it is held.
type restartNoticeGate struct {
	mu           syncutil.Ranked[lockRankLeaf]
	reason       RestartReason
	delaySeconds int
	at           time.Time
}

// claim reports whether this announcement should go out, and records it when
// it does.
func (g *restartNoticeGate) claim(reason RestartReason, delaySeconds int) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if delaySeconds == 0 {
		g.at = time.Time{}
		return true
	}
	now := time.Now()
	if g.reason == reason && g.delaySeconds == delaySeconds && now.Sub(g.at) < restartNoticeDedupeWindow {
		return false
	}
	g.reason, g.delaySeconds, g.at = reason, delaySeconds, now
	return true
}

// BroadcastServerRestart sends a server_restart message to all connected clients.
// reason says why the server is restarting; delaySeconds tells clients how
// long until the socket drops, and 0 cancels an earlier announcement. The
// redial spread scales with who is connected now (P5-S04).
//
// An announcement identical to one sent in the last restartNoticeDedupeWindow
// is dropped: a self-update announces from the admin handler and again from
// the graceful stop, and clients should see one countdown. A cancel
// (delaySeconds 0) is never dropped.
func (h *Hub) BroadcastServerRestart(reason RestartReason, delaySeconds int) {
	if !h.restartGate.claim(reason, delaySeconds) {
		return
	}
	h.BroadcastToAll(buildServerRestartMsg(reason, delaySeconds, restartSpreadMS(h.ClientCount())))
}
