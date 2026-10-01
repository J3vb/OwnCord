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
// runs at once — the bcrypt compares behind every password confirmation, the
// bcrypt hashes behind registration, password change and recovery-code
// issue, and the recovery-code match at verify (B4-4, SEC-01). One process
// holds one budget (inside the shared RateLimiter), so every route that pays
// for bcrypt takes the same server-owned admission decision: a slot is taken
// atomically before the computation starts and given back after it. An
// over-budget attempt either waits its turn in a bounded FIFO queue (Acquire:
// the login, registration and recovery-code routes, so a login burst is slow
// rather than refused — P5-S02) or is refused up front (TryAcquire: the
// sensitive confirmations). A refusal runs no compare and charges no lockout
// attempt.
//
// The size counts concurrent computations, not requests per second: bcrypt
// at cost 12 is a quarter second of one core, so the budget is what keeps a
// burst of password attempts from growing the CPU-bound backlog without
// bound. The default is twice the core count — enough that legitimate
// traffic rarely queues, small enough that each queued caller moves up
// quickly.
type AdmissionBudget struct {
	size     int
	queueCap int
	mu       sync.Mutex
	// held counts slots taken; waiters are Acquire callers queued for one,
	// oldest first. A released slot passes straight to the oldest waiter,
	// so held never drops while anyone waits and nobody can jump the queue.
	held    int
	waiters list.List // of chan struct{}, closed when handed a slot
	// avgHold is a moving average of how long a slot is held, the service
	// time behind the retry hint.
	avgHold  time.Duration
	inFlight atomic.Int64
	peak     atomic.Int64
}

const (
	// minDefaultAdmissionBudget keeps the computed default useful on a
	// one- or two-core host; an explicit configuration may go lower.
	minDefaultAdmissionBudget = 4
	// maxAdmissionBudget is where a budget stops bounding anything.
	maxAdmissionBudget = 4096
	// AdmissionWait is how long an Acquire caller on the login, registration
	// and recovery-code paths waits in the queue before it is refused.
	AdmissionWait = 10 * time.Second
	// queueSlotsPerSecond caps the queue at four waiters per slot per second
	// of AdmissionWait. It is only an upper bound: it matches what the budget
	// serves inside the wait when a compare holds a slot a quarter second,
	// but slots outnumber cores by default, so holds run longer. Acquire
	// refuses earlier, from the measured hold time, whenever the wait it
	// would face already exceeds its maxWait.
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
// exhausted or callers are already queued for it: nothing was taken and
// release is a no-op. release is idempotent, so a caller can give the slot
// back as soon as the expensive step is done and still defer it as a safety
// net.
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

// Acquire takes one slot, waiting in arrival order for up to maxWait when
// the budget is exhausted. ok is false when the queue is already full or its
// estimated wait already exceeds maxWait, when maxWait passes, or when ctx
// ends first: nothing was taken, release is a no-op, and retryAfter
// estimates when a slot is likely to be free. A refusal is still the B4-4
// refusal — no computation runs and it charges no lockout attempt.
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
	select {
	case <-ready:
		// Handed a slot while giving up: pass it on rather than hold it for
		// a caller that no longer wants it.
		b.mu.Unlock()
		b.admitted()()
		b.mu.Lock()
	default:
		b.waiters.Remove(elem)
	}
	retryAfter = b.retryAfterLocked()
	b.mu.Unlock()
	return func() {}, retryAfter, false
}

// estimatedWaitLocked is how long a caller joining the queue now would wait
// for a slot: the queue ahead of it divided by the budget's throughput.
func (b *AdmissionBudget) estimatedWaitLocked() time.Duration {
	return time.Duration(b.waiters.Len()+1) * b.avgHold / time.Duration(b.size)
}

// retryAfterLocked estimates how long a caller refused now should wait before
// trying again: its estimated wait, never under a second.
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
			if front := b.waiters.Front(); front != nil {
				b.waiters.Remove(front)
				close(front.Value.(chan struct{}))
				return
			}
			b.held--
		})
	}
}

// Size is the number of concurrent computations the budget admits.
func (b *AdmissionBudget) Size() int { return b.size }

// InFlight is the number of computations admitted right now.
func (b *AdmissionBudget) InFlight() int { return int(b.inFlight.Load()) }

// Peak is the most computations ever admitted at once — the figure the
// bounded-work tests hold against Size.
func (b *AdmissionBudget) Peak() int { return int(b.peak.Load()) }

// CheckPassword runs CheckPassword inside one admitted slot. admitted is
// false when the budget refused: no comparison ran and matched is false.
func (b *AdmissionBudget) CheckPassword(hash, password string) (matched, admitted bool) {
	release, ok := b.TryAcquire()
	if !ok {
		return false, false
	}
	defer release()
	return CheckPassword(hash, password), true
}

// HashPassword runs HashPassword inside one admitted slot. admitted is false
// when the budget refused: no hash was computed and err is nil.
func (b *AdmissionBudget) HashPassword(password string) (hash string, admitted bool, err error) {
	release, ok := b.TryAcquire()
	if !ok {
		return "", false, nil
	}
	defer release()
	hash, err = HashPassword(password)
	return hash, true, err
}
