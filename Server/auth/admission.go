package auth

import (
	"runtime"
	"sync"
	"sync/atomic"
)

// AdmissionBudget bounds how much deliberately expensive authentication work
// runs at once — the bcrypt compares behind every password confirmation, the
// bcrypt hashes behind registration, password change and recovery-code
// issue, and the recovery-code match at verify (B4-4, SEC-01). One process
// holds one budget (inside the shared RateLimiter), so every route that pays
// for bcrypt takes the same server-owned admission decision: a slot is taken
// atomically before the computation starts and given back after it, and an
// over-budget attempt is refused up front — no compare runs, and the refusal
// charges no lockout attempt.
//
// The size counts concurrent computations, not requests per second: bcrypt
// at cost 12 is a quarter second of one core, so the budget is what keeps a
// burst of password attempts from growing the CPU-bound backlog without
// bound. The default is twice the core count — enough that legitimate
// traffic never sees a refusal, small enough that the worst-case queue
// behind it stays under a second.
type AdmissionBudget struct {
	slots    chan struct{}
	size     int
	inFlight atomic.Int64
	peak     atomic.Int64
}

const (
	// minDefaultAdmissionBudget keeps the computed default useful on a
	// one- or two-core host; an explicit configuration may go lower.
	minDefaultAdmissionBudget = 4
	// maxAdmissionBudget is where a budget stops bounding anything.
	maxAdmissionBudget = 4096
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
	return &AdmissionBudget{slots: make(chan struct{}, size), size: size}
}

// TryAcquire takes one slot without waiting. ok is false when the budget is
// exhausted: nothing was taken and release is a no-op. release is
// idempotent, so a caller can give the slot back as soon as the expensive
// step is done and still defer it as a safety net.
func (b *AdmissionBudget) TryAcquire() (release func(), ok bool) {
	select {
	case b.slots <- struct{}{}:
	default:
		return func() {}, false
	}
	n := b.inFlight.Add(1)
	for {
		p := b.peak.Load()
		if n <= p || b.peak.CompareAndSwap(p, n) {
			break
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			b.inFlight.Add(-1)
			<-b.slots
		})
	}, true
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
