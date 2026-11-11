package auth

import (
	"container/list"
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// AdmissionBudget bounds how much deliberately expensive authentication work
// (bcrypt compares and hashes, the recovery-code match) runs at once. One
// process holds one budget inside the shared RateLimiter: a slot is taken
// before the computation and given back after. An over-budget attempt either
// waits in a bounded FIFO queue (Acquire, so a login burst is slow rather than
// refused) or is refused up front (TryAcquire, the sensitive confirmations). A
// refusal runs no compare and charges no lockout attempt.
//
// The size counts concurrent computations, not requests per second, so a burst
// of password attempts cannot grow the CPU-bound backlog without bound.
type AdmissionBudget struct {
	size     int
	queueCap int
	mu       sync.Mutex
	// held counts slots taken; waiters are queued Acquire callers, oldest first.
	// A released slot passes straight to the oldest waiter, so nobody jumps the queue.
	held    int
	waiters list.List // of chan struct{}, closed when handed a slot
	// avgHold is a moving average of slot hold time, behind the retry hint.
	avgHold  time.Duration
	inFlight atomic.Int64
	peak     atomic.Int64
}

const (
	// minDefaultAdmissionBudget keeps the default useful on a one- or two-core host.
	minDefaultAdmissionBudget = 4
	// maxAdmissionBudget is where a budget stops bounding anything.
	maxAdmissionBudget = 4096
	// AdmissionWait is how long an Acquire caller waits in the queue before it is refused.
	AdmissionWait = 10 * time.Second
	// queueSlotsPerSecond caps the queue at four waiters per slot per second of
	// AdmissionWait, only an upper bound: Acquire refuses earlier, from the
	// measured hold time, when its estimated wait exceeds maxWait.
	queueSlotsPerSecond = 4
	// initialAvgHold seeds the retry hint before any slot has been released.
	initialAvgHold = 250 * time.Millisecond
)

// DefaultAdmissionBudget is the size a zero or negative configuration value
// means: twice the core count, never below four.
func DefaultAdmissionBudget() int {
	return max(2*runtime.NumCPU(), minDefaultAdmissionBudget)
}

// NewAdmissionBudget returns a budget of size concurrent computations. Zero
// or negative means DefaultAdmissionBudget; sizes above 4096 are clamped.
func NewAdmissionBudget(size int) *AdmissionBudget {
	if size <= 0 {
		size = DefaultAdmissionBudget()
	}
	size = min(size, maxAdmissionBudget)
	return &AdmissionBudget{
		size:     size,
		queueCap: queueSlotsPerSecond * size * int(AdmissionWait/time.Second),
		avgHold:  initialAvgHold,
	}
}

// TryAcquire takes one slot without waiting. ok is false when the budget is
// exhausted or callers are queued: nothing was taken and release is a no-op.
// release is idempotent, so it can be called early and deferred as well.
func (b *AdmissionBudget) TryAcquire() (release func(), ok bool) {
	b.mu.Lock()
	ok = b.held < b.size && b.waiters.Len() == 0
	if ok {
		b.held++
	}
	b.mu.Unlock()
	if !ok {
		return func() {}, false
	}
	return b.admitted(), true
}

// Acquire takes one slot, waiting in arrival order for up to maxWait. ok is
// false when the queue is full or its estimated wait exceeds maxWait, when
// maxWait passes, or when ctx ends first: nothing was taken, release is a
// no-op, and retryAfter estimates when a slot is likely free.
func (b *AdmissionBudget) Acquire(ctx context.Context, maxWait time.Duration) (release func(), retryAfter time.Duration, ok bool) {
	b.mu.Lock()
	if b.held < b.size && b.waiters.Len() == 0 {
		b.held++
		b.mu.Unlock()
		return b.admitted(), 0, true
	}
	if b.waiters.Len() >= b.queueCap || b.estimatedWaitLocked() > maxWait {
		retryAfter = b.retryAfterLocked()
		b.mu.Unlock()
		return func() {}, retryAfter, false
	}
	ready := make(chan struct{})
	elem := b.waiters.PushBack(ready)
	b.mu.Unlock()

	timer := time.NewTimer(maxWait)
	defer timer.Stop()
	select {
	case <-ready:
		return b.admitted(), 0, true
	case <-ctx.Done():
	case <-timer.C:
	}

	b.mu.Lock()
	b.abandonLocked(ready, elem)
	retryAfter = b.retryAfterLocked()
	b.mu.Unlock()
	return func() {}, retryAfter, false
}

// abandonLocked removes a waiter that gave up. One handed a slot in the same
// instant passes it on and is not booked as an admission.
func (b *AdmissionBudget) abandonLocked(ready chan struct{}, elem *list.Element) {
	select {
	case <-ready:
		b.handOffLocked()
	default:
		b.waiters.Remove(elem)
	}
}

// estimatedWaitLocked is how long a caller joining the queue now would wait.
func (b *AdmissionBudget) estimatedWaitLocked() time.Duration {
	return time.Duration(b.waiters.Len()+1) * b.avgHold / time.Duration(b.size)
}

// retryAfterLocked is the estimated wait, never under a second.
func (b *AdmissionBudget) retryAfterLocked() time.Duration {
	return max(b.estimatedWaitLocked(), time.Second)
}

// admitted books a slot the caller now holds and returns its release.
func (b *AdmissionBudget) admitted() func() {
	n := b.inFlight.Add(1)
	for {
		p := b.peak.Load()
		if n <= p || b.peak.CompareAndSwap(p, n) {
			break
		}
	}
	start := time.Now()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.inFlight.Add(-1)
			b.mu.Lock()
			defer b.mu.Unlock()
			b.avgHold += (time.Since(start) - b.avgHold) / 8
			b.handOffLocked()
		})
	}
}

// handOffLocked gives one held slot to the oldest waiter, else back to the budget.
func (b *AdmissionBudget) handOffLocked() {
	if front := b.waiters.Front(); front != nil {
		b.waiters.Remove(front)
		close(front.Value.(chan struct{}))
		return
	}
	b.held--
}

// Size is the number of concurrent computations the budget admits.
func (b *AdmissionBudget) Size() int { return b.size }

// InFlight is the number of computations admitted right now.
func (b *AdmissionBudget) InFlight() int { return int(b.inFlight.Load()) }

// Peak is the most computations ever admitted at once.
func (b *AdmissionBudget) Peak() int { return int(b.peak.Load()) }

// CheckPassword runs CheckPassword in one admitted slot; admitted is false
// when refused, with no comparison run.
func (b *AdmissionBudget) CheckPassword(hash, password string) (matched, admitted bool) {
	release, ok := b.TryAcquire()
	if !ok {
		return false, false
	}
	defer release()
	return CheckPassword(hash, password), true
}

// HashPassword runs HashPassword in one admitted slot; admitted is false when
// refused, with no hash computed and err nil.
func (b *AdmissionBudget) HashPassword(password string) (hash string, admitted bool, err error) {
	release, ok := b.TryAcquire()
	if !ok {
		return "", false, nil
	}
	defer release()
	hash, err = HashPassword(password)
	return hash, true, err
}
