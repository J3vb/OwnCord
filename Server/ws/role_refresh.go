package ws

import (
	"context"
	"maps"
	"slices"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// role_refresh moves the fan-out of a role change off the admin request goroutine. The
// handler commits, invalidates the permission cache and makes ONE EnqueueRoleRefresh call;
// a hub-owned worker then refreshes each affected user in turn (held topics, sidebar and
// affordances, paced member_update_batch frames, timeout views) and sends one roles_update
// per round. Lock order: roleRefreshState.mu is a leaf. It may be taken under seqMu (from
// covers, via mustFullResyncAtRegister) and seqMu is never taken under it. It is never held
// across I/O or a send, or while taking h.mu, timeoutView.mu or any Client.mu. flushMu sits
// above everything a round takes (h.mu, ps.mu, timeoutView.mu, Client.mu);
// EnqueueRoleRefresh never takes it, and a round takes seqMu only inside
// bumpVisibilityWatermark's lock-free CAS, never through MarkVisibilityChanged.

// RoleRefresh is one role mutation's fan-out request; the caller already committed and invalidated the
// permission cache.
type RoleRefresh struct {
	// Visibility lists users whose role or role mask changed: held topics, sidebar, affordances and timeout
	// view are refreshed.
	Visibility []int64
	// AllConnected counts every connected user as Visibility: the holder list of an edited role could not be
	// read.
	AllConnected bool
	// MemberUpdate lists users whose displayed role name changed: a member_update_batch entry goes to
	// everyone.
	MemberUpdate []int64
	// Roles re-reads the role list and broadcasts roles_update at the end of the round.
	Roles bool
}

type roleRefreshFlags uint8

const (
	rrVisibility roleRefreshFlags = 1 << iota
	rrMember
)

type roleBatch struct {
	users map[int64]roleRefreshFlags
	all   bool
	roles bool
}

type roleRefreshState struct {
	mu          syncutil.Ranked[lockRankLeaf]
	pending     map[int64]roleRefreshFlags
	all, roles  bool
	inFlight    map[int64]roleRefreshFlags
	allInFlight bool
	wake        chan struct{} // cap 1; made on first use so a zero Hub works

	// flushMu serialises refresh rounds so only one runs at a time.
	flushMu syncutil.Ranked[lockRankSerialiser]

	// gate runs at the start of every round, after its pending work was taken. Test-only.
	gate atomic.Pointer[func()]
	// listFailures counts consecutive rounds whose channel list could not be read; worker-only (under
	// flushMu).
	listFailures int
	// userGate runs for each user after the revocation and before the first frame is queued. Test-only.
	userGate atomic.Pointer[func(userID int64)]
	// sendGate runs for each user at the start of the send pass. Test-only.
	sendGate atomic.Pointer[func(userID int64)]
}

// SetRoleRefreshGateForTest installs fn to run at the start of every round (nil clears it).
func (h *Hub) SetRoleRefreshGateForTest(fn func()) {
	if fn == nil {
		h.roleRefresh.gate.Store(nil)
		return
	}
	h.roleRefresh.gate.Store(&fn)
}

func (s *roleRefreshState) wakeChan() chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wake == nil {
		s.wake = make(chan struct{}, 1)
	}
	return s.wake
}

// covers reports whether userID's refresh is pending or running. A reconnect of such a user
// must take a full ready, not a replay that skips the unsequenced sidebar frames. Called under seqMu.
func (s *roleRefreshState) covers(userID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.all || s.allInFlight {
		return true
	}
	_, pending := s.pending[userID]
	_, running := s.inFlight[userID]
	return pending || running
}

// EnqueueRoleRefresh records r for the worker and returns at once (no I/O, DB work or
// channel send under a lock). Requests merge, so a user named many times is refreshed once.
func (h *Hub) EnqueueRoleRefresh(r RoleRefresh) {
	if len(r.Visibility) == 0 && !r.AllConnected && len(r.MemberUpdate) == 0 && !r.Roles {
		return
	}
	s := &h.roleRefresh
	s.mu.Lock()
	if s.pending == nil {
		s.pending = make(map[int64]roleRefreshFlags)
	}
	if s.wake == nil {
		s.wake = make(chan struct{}, 1)
	}
	wake := s.wake
	for _, uid := range r.Visibility {
		s.pending[uid] |= rrVisibility
	}
	for _, uid := range r.MemberUpdate {
		s.pending[uid] |= rrMember
	}
	s.all = s.all || r.AllConnected
	s.roles = s.roles || r.Roles
	s.mu.Unlock()

	// After the merge, so covers is already true for an affected user who reconnects meanwhile.
	// An offline user resumes from a seq at or before this watermark onto a full ready.
	if len(r.Visibility) > 0 || r.AllConnected || len(r.MemberUpdate) > 0 {
		h.MarkVisibilityChanged()
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (s *roleRefreshState) take() (roleBatch, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) == 0 && !s.all && !s.roles {
		return roleBatch{}, false
	}
	b := roleBatch{users: s.pending, all: s.all, roles: s.roles}
	s.inFlight = maps.Clone(s.pending)
	s.allInFlight = s.all
	s.pending, s.all, s.roles = nil, false, false
	return b, true
}

func (s *roleRefreshState) requeue(b roleBatch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending == nil {
		s.pending = make(map[int64]roleRefreshFlags, len(b.users))
	}
	for uid, f := range b.users {
		s.pending[uid] |= f
	}
	s.all = s.all || b.all
	s.roles = s.roles || b.roles
}

func (s *roleRefreshState) done(userID int64) {
	s.mu.Lock()
	delete(s.inFlight, userID)
	s.mu.Unlock()
}

func (s *roleRefreshState) finish() {
	s.mu.Lock()
	s.inFlight, s.allInFlight = nil, false
	s.mu.Unlock()
}

func (b roleBatch) usersWith(flag roleRefreshFlags) []int64 {
	var ids []int64
	for uid, f := range b.users {
		if f&flag != 0 {
			ids = append(ids, uid)
		}
	}
	slices.Sort(ids)
	return ids
}

// runRoleRefreshLife is a method value, not a closure in Run, so Run's closures keep their
// names (api's goleak filter names Run.func1).
func (h *Hub) runRoleRefreshLife() { h.runRoleRefresh(h.lifeCtx()) }

// runRoleRefresh is the worker, started once by Run on h.sweeps and joined by finishRun.
// Pending work at exit is discarded: Stop closes every socket and the boot-time watermark
// sends pre-restart resumes onto a full ready.
func (h *Hub) runRoleRefresh(ctx context.Context) {
	wake := h.roleRefresh.wakeChan()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.stop:
			return
		case <-wake:
		}
		// A round that could not read the channel list asks to run again after a backoff; its users stay
		// pending.
		for {
			retry := h.flushRoleRefresh(ctx)
			if retry <= 0 {
				break
			}
			t := time.NewTimer(retry)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-h.stop:
				t.Stop()
				return
			case <-t.C:
			}
		}
	}
}

// flushRoleRefresh runs one round over whatever is pending, on the worker (or a test barrier), never the
// dispatch goroutine. Returns the wait before running again when the round was put back, else 0.
func (h *Hub) flushRoleRefresh(ctx context.Context) time.Duration {
	s := &h.roleRefresh
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	b, ok := s.take()
	if !ok {
		return 0
	}
	defer s.finish()
	if g := s.gate.Load(); g != nil {
		(*g)()
	}
	return h.runRoleRound(ctx, b)
}

// startSweepWorkers starts Run's long-lived workers on h.sweeps, which finishRun joins.
func (h *Hub) startSweepWorkers() {
	h.lifecycle.sweeps.Go(h.runRemovedVoiceWatch)
	h.lifecycle.sweeps.Go(h.runVoiceResumeChecksLife)
	h.lifecycle.sweeps.Go(h.runChannelActivityLife)
	h.lifecycle.sweeps.Go(h.runRoleRefreshLife)
}
