package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// timeoutViewState coordinates delivery of the member_timeouts view (WP
// 3C-7c): which list every connected client holds, against concurrent
// publishes, role refreshes and connects.
//
// Lock order: timeoutView.mu, then h.mu (read-locked only, to read the live
// client map), then Client.mu (sendMsg). timeoutView.mu is never taken with
// h.mu, h.seqMu or h.presenceMu held, and nothing under it does I/O:
// permission verdicts are resolved before it is taken, and sendMsg only
// queues.
type timeoutViewState struct {
	mu syncutil.Mutex
	// gen counts role refreshes. refreshTimeoutViewsAfterRoleChange bumps it
	// under mu before resolving anything, and every caller of
	// RefreshAllChannelVisibility has already invalidated the permission
	// cache by then (the cache's own generation drops any population that
	// raced the invalidation). So a verdict resolved after reading gen sees
	// every role change whose refresh has bumped it; a delivery that finds gen
	// moved resolves again.
	gen uint64
}

// heldTimeouts is one Client's member_timeouts state.
type heldTimeouts struct {
	// full: the last list this client applies is the full (moderator) list,
	// so a role refresh that finds it no longer a moderator must send its
	// own-only list. Written under timeoutView.mu once the client is
	// registered; registerNow sets it true before the client is reachable.
	full atomic.Bool
	// frameSent: a member_timeouts frame was queued for this client. Such a
	// frame reaches the peer after ready (the write pump starts after it), so
	// it, not ready, is what the client ends up holding. Guarded by
	// Hub.timeoutView.mu.
	frameSent bool
}

// timeoutViewAttempts bounds how often one delivery resolves verdicts again
// because a role refresh moved timeoutView.gen while it was resolving.
const timeoutViewAttempts = 4

// timeoutViewResolvedHook, when non-nil, runs after a delivery resolved its
// verdicts and before it takes timeoutView.mu, so a test can land a role
// change in exactly that window. Test-only (nil in production).
var timeoutViewResolvedHook func()

// readyTimeoutsCommitHook, when non-nil, runs after a fresh connect built its
// ready and before commitReadyTimeouts records which list that ready carried.
// Test-only (nil in production).
var readyTimeoutsCommitHook func()

// timeoutViewGenNow reads timeoutView.gen.
func (h *Hub) timeoutViewGenNow() uint64 {
	h.timeoutView.mu.Lock()
	defer h.timeoutView.mu.Unlock()
	return h.timeoutView.gen
}

// bumpTimeoutViewGen marks the start of a role refresh.
func (h *Hub) bumpTimeoutViewGen() {
	h.timeoutView.mu.Lock()
	defer h.timeoutView.mu.Unlock()
	h.timeoutView.gen++
}

// resolveTimeoutVerdicts resolves permissions.CanModerate for every
// connected user, outside every lock. Every user it returns was evaluated; a
// lookup failure is a false verdict (the narrow list).
func (h *Hub) resolveTimeoutVerdicts(ctx context.Context) map[int64]bool {
	h.mu.RLock()
	ids := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		ids = append(ids, uid)
	}
	h.mu.RUnlock()
	verdicts := make(map[int64]bool, len(ids))
	for _, uid := range ids {
		sub, err := h.subjectFor(ctx, uid, 0)
		verdicts[uid] = err == nil && permissions.CanModerate(sub) == nil
	}
	return verdicts
}

// deliverTimeoutViews resolves every connected user's moderator verdict and
// then, under timeoutView.mu, sends each evaluated user's live client its
// view when wants says so. wants runs under timeoutView.mu.
//
// When a role refresh moves timeoutView.gen while the verdicts are being
// resolved, they may predate that role change, so they are resolved again.
// After timeoutViewAttempts the delivery treats nobody as a moderator: every
// client holding the full list, and every client wants picks, gets its
// own-only list. The role refresh that moved gen re-sends the full list to
// moderators. It returns false when the timeout mirror is not loaded and
// nothing was sent.
func (h *Hub) deliverTimeoutViews(ctx context.Context, wants func(c *Client, isMod bool) bool) bool {
	for attempt := 1; ; attempt++ {
		gen := h.timeoutViewGenNow()
		verdicts := h.resolveTimeoutVerdicts(ctx)
		if timeoutViewResolvedHook != nil {
			timeoutViewResolvedHook()
		}
		h.timeoutView.mu.Lock()
		current := h.timeoutView.gen == gen
		if !current && attempt < timeoutViewAttempts {
			h.timeoutView.mu.Unlock()
			continue
		}
		ok := h.sendTimeoutViewsLocked(verdicts, current, wants)
		h.timeoutView.mu.Unlock()
		if !current {
			slog.Warn("hub: member_timeouts verdicts kept moving, sent own-only lists", "attempts", attempt)
		}
		return ok
	}
}

// sendTimeoutViewsLocked is deliverTimeoutViews' send step. The caller holds
// timeoutView.mu. Only users present in verdicts are considered, each through
// its client as registered now, so a connection that replaced the evaluated
// one gets the frame instead of the closed socket.
func (h *Hub) sendTimeoutViewsLocked(verdicts map[int64]bool, current bool, wants func(c *Client, isMod bool) bool) bool {
	snap, ok := h.perms.TimeoutSnapshot()
	if !ok {
		return false
	}
	h.mu.RLock()
	live := make([]*Client, 0, len(verdicts))
	for uid := range verdicts {
		if c := h.clients[uid]; c != nil {
			live = append(live, c)
		}
	}
	h.mu.RUnlock()
	now := time.Now()
	for _, c := range live {
		isMod := current && verdicts[c.userID]
		send := wants(c, isMod)
		if !current && c.timeouts.full.Load() {
			send = true
		}
		if send {
			h.sendTimeoutViewLocked(c, isMod, snap, now)
		}
	}
	return true
}

// sendTimeoutViewLocked queues c's view and records which list it is. The
// caller holds timeoutView.mu.
func (h *Hub) sendTimeoutViewLocked(c *Client, isMod bool, snap map[int64]time.Time, now time.Time) {
	c.timeouts.full.Store(isMod)
	c.timeouts.frameSent = true
	c.sendMsg(buildMemberTimeouts(memberTimeoutsFor(c.userID, isMod, snap, now)))
}

// commitReadyTimeouts records which list a fresh connect's ready carried.
// registerNow left c.timeouts.full true, so until this runs any role refresh
// sends c a frame. gen is timeoutView.gen read after registerNow and before
// buildReady resolved the viewer's Subject.
//
//   - A frame already queued for c reaches the peer after ready, and its
//     sender set the flag to match it: leave it.
//   - gen moved: ready's verdict may predate a role change. Leave the flag
//     true; the refresh that moved gen snapshots the clients after moving it,
//     finds c (registered before gen was read) holding true and sends it a
//     frame.
//   - Otherwise ready's verdict is current and ready is the last list c
//     receives so far: record it.
func (h *Hub) commitReadyTimeouts(c *Client, gen uint64, full bool) {
	if readyTimeoutsCommitHook != nil {
		readyTimeoutsCommitHook()
	}
	h.timeoutView.mu.Lock()
	defer h.timeoutView.mu.Unlock()
	if c.timeouts.frameSent || h.timeoutView.gen != gen {
		return
	}
	c.timeouts.full.Store(full)
}
