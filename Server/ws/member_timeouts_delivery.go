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
	mu syncutil.Ranked[lockRankFeed]
	// gen counts role refreshes. refreshVisibilityUsers bumps it under mu on
	// entry, and every caller (the role-refresh worker, RefreshAllChannelVisibility)
	// has already invalidated the permission cache by then (the cache's own generation drops any population that
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

// timeoutVerdictBudget bounds one resolveTimeoutVerdicts pass; a lookup that
// runs past it fails, which is a false verdict.
const timeoutVerdictBudget = 5 * time.Second

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

// timeoutVerdictLookupHook, when non-nil, can fail one user's verdict lookup
// in resolveTimeoutVerdicts. Test-only (nil in production).
var timeoutVerdictLookupHook func(userID int64) error

// resolveTimeoutVerdicts resolves permissions.CanModerate for every
// connected user, outside every lock. only, when non-nil, restricts the pass
// to those users (a role refresh resolves just the users whose role changed);
// nil means everyone. The verdict is three-way: true
// (moderator), false (not a moderator), or absent from the map (unknown: the
// lookup failed or ran out of time). An unknown user is skipped by the
// delivery, so a transient lookup failure neither narrows a moderator's list
// nor widens anyone else's; the next delivery or ready settles it.
func (h *Hub) resolveTimeoutVerdicts(ctx context.Context, only map[int64]struct{}) map[int64]bool {
	ctx, cancel := context.WithTimeout(ctx, timeoutVerdictBudget)
	defer cancel()
	h.mu.RLock()
	ids := make([]int64, 0, len(h.clients))
	for _, uid := range h.connectedUserIDsLocked() {
		if _, ok := only[uid]; only == nil || ok {
			ids = append(ids, uid)
		}
	}
	h.mu.RUnlock()
	verdicts := make(map[int64]bool, len(ids))
	for _, uid := range ids {
		sub, err := h.subjectFor(ctx, uid, 0)
		if err == nil && timeoutVerdictLookupHook != nil {
			err = timeoutVerdictLookupHook(uid)
		}
		if err != nil {
			slog.Warn("hub: member_timeouts verdict unknown, user skipped", "user_id", uid, "err", err)
			continue
		}
		verdicts[uid] = permissions.CanModerate(sub) == nil
	}
	return verdicts
}

// deliverTimeoutViews resolves every connected user's moderator verdict (only
// restricts that to a set, nil meaning everyone) and then, under timeoutView.mu, sends each evaluated user's live client its
// view when wants says so. wants runs under timeoutView.mu.
//
// When a role refresh moves timeoutView.gen while the verdicts are being
// resolved, they may predate that role change, so they are resolved again
// until gen holds still across one resolution. There is no cap: a narrowed
// fallback could strip a current moderator's list with nothing left to
// repair it, and each extra pass needs another role refresh to land inside
// one resolution, so the loop ends as soon as role changes pause.
//
// When the timeout mirror is not loaded it reloads it once, outside
// timeoutView.mu, and tries again; it returns false, having sent nothing,
// only when that reload fails or the mirror is still unloaded.
func (h *Hub) deliverTimeoutViews(ctx context.Context, only map[int64]struct{}, wants func(c *Client, isMod bool) bool) bool {
	reloaded := false
	for {
		gen := h.timeoutViewGenNow()
		verdicts := h.resolveTimeoutVerdicts(ctx, only)
		if timeoutViewResolvedHook != nil {
			timeoutViewResolvedHook()
		}
		h.timeoutView.mu.Lock()
		if h.timeoutView.gen != gen {
			h.timeoutView.mu.Unlock()
			continue
		}
		ok := h.sendTimeoutViewsLocked(verdicts, wants)
		h.timeoutView.mu.Unlock()
		if ok || reloaded {
			return ok
		}
		reloaded = true
		if !h.reloadTimeoutMirror(ctx) {
			return false
		}
	}
}

// reloadTimeoutMirror reloads the timeout mirror under timeoutVerdictBudget.
// The caller holds no lock.
func (h *Hub) reloadTimeoutMirror(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, timeoutVerdictBudget)
	defer cancel()
	return h.perms.RefreshTimeouts(ctx) == nil
}

// sendTimeoutViewsLocked is deliverTimeoutViews' send step. The caller holds
// timeoutView.mu. Only users present in verdicts are considered, each through
// its clients (every device) as registered now, so a connection that replaced the evaluated
// one gets the frame instead of the closed socket.
func (h *Hub) sendTimeoutViewsLocked(verdicts map[int64]bool, wants func(c *Client, isMod bool) bool) bool {
	snap, ok := h.perms.TimeoutSnapshot()
	if !ok {
		return false
	}
	h.mu.RLock()
	live := make([]*Client, 0, len(verdicts))
	for uid := range verdicts {
		live = append(live, h.clients[uid]...)
	}
	h.mu.RUnlock()
	now := time.Now()
	for _, c := range live {
		isMod := verdicts[c.userID]
		if wants(c, isMod) {
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
//   - Otherwise ready is the last list c receives so far, and the flag
//     records it. Recording it is safe even when ready's verdict predates a
//     role change: the flag then describes what c holds, and that change's
//     refresh (wants: moderator, or holding the full list) corrects c.
//   - The gen guard (leave the flag true when a refresh started since gen
//     was read) is belt-and-braces on top of that: a true flag costs at most
//     one redundant own-only frame.
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
