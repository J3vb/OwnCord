package syncutil

// LockRank names one rank of a lock order. A rank is an empty struct type
// whose Rank method returns a constant: ws declares its ranks in
// ws/lock_order.go, outermost (lowest) first.
type LockRank interface {
	Rank() int
}

// Ranked is a Mutex that carries the rank R in its type. In production it is
// the Mutex and nothing else: every method is the Mutex call it wraps. Under
// -tags deadlock each acquire is also checked against the ranks the goroutine
// already holds, and an acquire whose rank is not strictly greater than every
// held rank panics with both stacks (ranked_deadlock.go).
//
// The zero value is an unlocked mutex of rank R, so a struct literal that
// contains one needs no constructor. A Ranked must not be copied after first
// use.
type Ranked[R LockRank] struct {
	mu Mutex
}

// RankedRW is the RWMutex counterpart of Ranked. A read hold counts as a hold
// of rank R like a write hold does, so a goroutine that read-locks it twice is
// flagged too: a recursive RLock deadlocks once a writer queues between them.
type RankedRW[R LockRank] struct {
	mu RWMutex
}
