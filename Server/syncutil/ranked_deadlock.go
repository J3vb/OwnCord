//go:build deadlock

package syncutil

import (
	"fmt"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/petermattis/goid"
)

// The rank checker of the deadlock build. It mirrors the Go runtime's
// lockrank: every Ranked/RankedRW acquire records a hold against the acquiring
// goroutine, and a blocking acquire whose rank is not strictly greater than
// every rank the goroutine holds panics before blocking, with the acquire's
// stack and the held lock's.
//
// go-deadlock (mutex_deadlock.go) still runs underneath, but reports an
// inversion only once one process has taken the same two lock instances in
// both orders; the rank check fails the first time a path takes a forbidden
// edge.

// rankHold is one lock a goroutine holds.
type rankHold struct {
	lock any // the *Ranked or *RankedRW, compared by identity
	rank int
	name LockRank // the rank's type, for the report
	read bool
	try  bool
	pcs  []uintptr // where it was acquired
}

// rankHolds is the process-wide hold table, keyed by goroutine id. It is a
// raw sync.Mutex on purpose: a syncutil lock here would recurse into the
// checker. The table is touched only by this file and never held across
// anything but slice and map work.
var rankHolds = struct {
	mu sync.Mutex
	by map[int64][]rankHold
}{by: make(map[int64][]rankHold)}

// rankViolations counts violations since the last TakeRankViolations. The
// hub's dispatch loop and handlers recover panics, so a violation there would
// otherwise only reach the log; a package's TestMain fails the run on a
// non-zero count instead.
var rankViolations atomic.Int64

// rankViolation reports a violation: it counts it, writes the report to
// stderr and panics.
var rankViolation = func(report string) {
	rankViolations.Add(1)
	fmt.Fprintln(os.Stderr, report)
	panic(report)
}

// TakeRankViolations returns the number of rank violations since the last
// call and resets the count. A test that provokes a violation on purpose
// takes it, so TestMain sees only the unexpected ones.
func TakeRankViolations() int64 {
	return rankViolations.Swap(0)
}

const rankStackDepth = 32

func rankCallers() []uintptr {
	pcs := make([]uintptr, rankStackDepth)
	// Skip runtime.Callers, rankCallers and the Ranked method that calls it,
	// so the first frame is the caller of Lock.
	n := runtime.Callers(3, pcs)
	return pcs[:n]
}

// rankCheck runs before a blocking acquire. It panics when the goroutine
// already holds a lock of rank >= r's.
func rankCheck(gid int64, lock any, r LockRank, pcs []uintptr) {
	rank := r.Rank()
	rankHolds.mu.Lock()
	var bad *rankHold
	for _, h := range rankHolds.by[gid] {
		if h.rank >= rank {
			bad = &h
			break
		}
	}
	rankHolds.mu.Unlock()
	if bad == nil {
		return
	}
	what := "a lock of the same rank"
	if bad.lock == lock {
		what = "this same lock"
	} else if bad.rank > rank {
		what = "a lock ranked after it"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "syncutil: lock rank violation: acquiring %T (rank %d) while holding %s, %T (rank %d)%s\n",
		r, rank, what, bad.name, bad.rank, holdKind(bad))
	b.WriteString("\nacquire stack:\n")
	writeStack(&b, pcs)
	b.WriteString("\nheld lock acquired at:\n")
	writeStack(&b, bad.pcs)
	rankViolation(b.String())
}

func holdKind(h *rankHold) string {
	switch {
	case h.try && h.read:
		return " via TryRLock"
	case h.try:
		return " via TryLock"
	case h.read:
		return " for reading"
	default:
		return ""
	}
}

func writeStack(b *strings.Builder, pcs []uintptr) {
	frames := runtime.CallersFrames(pcs)
	for {
		f, more := frames.Next()
		fmt.Fprintf(b, "  %s\n      %s:%d\n", f.Function, f.File, f.Line)
		if !more {
			return
		}
	}
}

// rankAcquired records a hold once the lock is held.
func rankAcquired(gid int64, lock any, r LockRank, read, try bool, pcs []uintptr) {
	h := rankHold{lock: lock, rank: r.Rank(), name: r, read: read, try: try, pcs: pcs}
	rankHolds.mu.Lock()
	rankHolds.by[gid] = append(rankHolds.by[gid], h)
	rankHolds.mu.Unlock()
}

// rankReleased drops one hold of lock. It looks on the releasing goroutine
// first and then on every other, because a lock may be released by a different
// goroutine than took it: the hold leaves whichever goroutine recorded it. For
// a read hold that fallback cannot tell readers apart: an RUnlock on a
// goroutine holding no read of lock drops some reader's hold. No ranked RLock
// is released across goroutines today.
func rankReleased(lock any) {
	gid := goid.Get()
	rankHolds.mu.Lock()
	defer rankHolds.mu.Unlock()
	if dropHold(gid, lock) {
		return
	}
	for other := range rankHolds.by {
		if other != gid && dropHold(other, lock) {
			return
		}
	}
}

// dropHold removes the latest hold of lock by gid. The caller holds
// rankHolds.mu.
func dropHold(gid int64, lock any) bool {
	hs := rankHolds.by[gid]
	for i, h := range slices.Backward(hs) {
		if h.lock != lock {
			continue
		}
		hs = slices.Delete(hs, i, i+1)
		if len(hs) == 0 {
			delete(rankHolds.by, gid)
		} else {
			rankHolds.by[gid] = hs
		}
		return true
	}
	return false
}

// HoldsForTest reports how many holds of lock (a *Ranked or *RankedRW) the
// table records, on any goroutine. It exists only in the deadlock build.
func HoldsForTest(lock any) int {
	rankHolds.mu.Lock()
	defer rankHolds.mu.Unlock()
	n := 0
	for _, hs := range rankHolds.by {
		for _, h := range hs {
			if h.lock == lock {
				n++
			}
		}
	}
	return n
}

func rankOf[R LockRank]() LockRank {
	var r R
	return r
}

// Lock locks m after checking its rank against the goroutine's holds.
func (m *Ranked[R]) Lock() {
	r, gid, pcs := rankOf[R](), goid.Get(), rankCallers()
	rankCheck(gid, m, r, pcs)
	m.mu.Lock()
	rankAcquired(gid, m, r, false, false, pcs)
}

// Unlock unlocks m and drops its hold.
func (m *Ranked[R]) Unlock() {
	rankReleased(m)
	m.mu.Unlock()
}

// TryLock tries to lock m. A try cannot block, so it is never flagged; a
// successful one is recorded as a hold like any other.
func (m *Ranked[R]) TryLock() bool {
	if !m.mu.TryLock() {
		return false
	}
	rankAcquired(goid.Get(), m, rankOf[R](), false, true, rankCallers())
	return true
}

// Lock locks m for writing after checking its rank.
func (m *RankedRW[R]) Lock() {
	r, gid, pcs := rankOf[R](), goid.Get(), rankCallers()
	rankCheck(gid, m, r, pcs)
	m.mu.Lock()
	rankAcquired(gid, m, r, false, false, pcs)
}

// Unlock unlocks m for writing and drops its hold.
func (m *RankedRW[R]) Unlock() {
	rankReleased(m)
	m.mu.Unlock()
}

// RLock locks m for reading after checking its rank.
func (m *RankedRW[R]) RLock() {
	r, gid, pcs := rankOf[R](), goid.Get(), rankCallers()
	rankCheck(gid, m, r, pcs)
	m.mu.RLock()
	rankAcquired(gid, m, r, true, false, pcs)
}

// RUnlock undoes one RLock and drops one read hold.
func (m *RankedRW[R]) RUnlock() {
	rankReleased(m)
	m.mu.RUnlock()
}

// TryLock tries to lock m for writing; never flagged, recorded on success.
func (m *RankedRW[R]) TryLock() bool {
	if !m.mu.TryLock() {
		return false
	}
	rankAcquired(goid.Get(), m, rankOf[R](), false, true, rankCallers())
	return true
}

// TryRLock tries to lock m for reading; never flagged, recorded on success.
func (m *RankedRW[R]) TryRLock() bool {
	if !m.mu.TryRLock() {
		return false
	}
	rankAcquired(goid.Get(), m, rankOf[R](), true, true, rankCallers())
	return true
}
