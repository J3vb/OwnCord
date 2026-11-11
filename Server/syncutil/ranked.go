package syncutil

// LockRank names one rank of a lock order: an empty struct type whose Rank
// method returns a constant (ws/lock_order.go, outermost lowest).
type LockRank interface {
	Rank() int
}

// Ranked is a Mutex carrying the rank R in its type. Under -tags deadlock an
// acquire whose rank is not strictly greater than every rank the goroutine
// holds panics with both stacks (ranked_deadlock.go); otherwise it is the Mutex.
// The zero value is an unlocked mutex; it must not be copied after first use.
type Ranked[R LockRank] struct {
	mu Mutex
}

// RankedRW is the RWMutex counterpart of Ranked. A read hold counts like a write
// hold, so a recursive RLock is flagged: it deadlocks once a writer queues between.
type RankedRW[R LockRank] struct {
	mu RWMutex
}
