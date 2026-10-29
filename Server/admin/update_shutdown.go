package admin

import (
	"context"
	"net/http"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// appliesInFlight holds the cancel func of every POST /updates/apply still
// running, and the servers that have begun shutting down. An apply can run for
// applyBudget, and http.Server.Shutdown does not cancel request contexts, so
// without this a SIGTERM during a slow update would hold the whole drain.
var appliesInFlight = struct {
	mu      syncutil.Mutex
	set     map[*applyEntry]struct{}
	closing map[*http.Server]struct{}
}{set: map[*applyEntry]struct{}{}, closing: map[*http.Server]struct{}{}}

type applyEntry struct {
	srv    *http.Server
	cancel context.CancelFunc
}

// EndApplies returns srv's shutdown hook: every update apply srv is serving
// has its context cancelled, and one that starts on srv afterwards is
// cancelled at once. Register it with http.Server.RegisterOnShutdown.
//
// The hook cuts the download and verification stage. The release-check stage
// waits for its detached lookup (up to about 30 s) and then returns. Once the
// handler has answered "applying", the swap runs on a context detached from
// the request: the request's end does not cancel it.
func EndApplies(srv *http.Server) func() {
	return func() {
		appliesInFlight.mu.Lock()
		appliesInFlight.closing[srv] = struct{}{}
		var cancels []context.CancelFunc
		for e := range appliesInFlight.set {
			if e.srv == srv {
				cancels = append(cancels, e.cancel)
			}
		}
		appliesInFlight.mu.Unlock()
		for _, c := range cancels { // outside the lock
			c()
		}
	}
}

// trackApply registers an apply's cancel func and returns the func that
// removes it. If srv is already shutting down, cancel runs immediately.
func trackApply(srv *http.Server, cancel context.CancelFunc) (untrack func()) {
	e := &applyEntry{srv: srv, cancel: cancel}
	appliesInFlight.mu.Lock()
	_, closing := appliesInFlight.closing[srv]
	appliesInFlight.set[e] = struct{}{}
	appliesInFlight.mu.Unlock()
	if closing && srv != nil {
		cancel()
	}
	return func() {
		appliesInFlight.mu.Lock()
		delete(appliesInFlight.set, e)
		appliesInFlight.mu.Unlock()
	}
}
