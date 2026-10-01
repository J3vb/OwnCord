package auth_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// B4-4 (SEC-01): the admission budget is the one atomic decision every
// expensive authentication computation takes. These pin its contract; the
// service and api tests pin that every site takes it.

func TestAdmissionBudget_AdmitsAtMostSizeAtOnce(t *testing.T) {
	const size, attempts = 3, 40
	b := auth.NewAdmissionBudget(size)

	start := make(chan struct{})
	hold := make(chan struct{})
	var decided, done sync.WaitGroup
	var admitted, refused atomic.Int64
	decided.Add(attempts)
	done.Add(attempts)
	for range attempts {
		go func() {
			defer done.Done()
			<-start
			release, ok := b.TryAcquire()
			// Count before signalling the decision, or decided.Wait can
			// return while a refused goroutine has not yet added itself.
			if !ok {
				refused.Add(1)
				decided.Done()
				return
			}
			admitted.Add(1)
			decided.Done()
			<-hold
			release()
		}()
	}
	close(start)
	decided.Wait()

	if got := admitted.Load(); got != size {
		t.Fatalf("admitted = %d, want exactly the budget %d", got, size)
	}
	if got := refused.Load(); got != attempts-size {
		t.Fatalf("refused = %d, want %d", got, attempts-size)
	}
	if b.InFlight() != size || b.Peak() != size {
		t.Fatalf("in flight = %d, peak = %d, want both %d", b.InFlight(), b.Peak(), size)
	}
	if _, ok := b.TryAcquire(); ok {
		t.Fatal("a full budget admitted one more")
	}

	close(hold)
	done.Wait()
	if b.InFlight() != 0 {
		t.Fatalf("in flight after every release = %d, want 0", b.InFlight())
	}
	if b.Peak() != size {
		t.Fatalf("peak after release = %d, want it to keep the high-water mark %d", b.Peak(), size)
	}
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("a drained budget refused")
	}
	release()
}

func TestAdmissionBudget_ReleaseIsIdempotent(t *testing.T) {
	b := auth.NewAdmissionBudget(1)
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("first acquire refused")
	}
	release()
	release()
	if b.InFlight() != 0 {
		t.Fatalf("in flight = %d after a double release, want 0 (a second release must not go negative)", b.InFlight())
	}
	if _, ok := b.TryAcquire(); !ok {
		t.Fatal("the slot a double release gave back twice is not reusable")
	}
	if b.InFlight() != 1 {
		t.Fatalf("in flight = %d, want 1", b.InFlight())
	}
}

func TestNewAdmissionBudget_DefaultAndClamp(t *testing.T) {
	def := auth.DefaultAdmissionBudget()
	if def < 4 {
		t.Fatalf("default budget = %d, want at least 4", def)
	}
	for _, size := range []int{0, -7} {
		if got := auth.NewAdmissionBudget(size).Size(); got != def {
			t.Errorf("NewAdmissionBudget(%d).Size() = %d, want the default %d", size, got, def)
		}
	}
	if got := auth.NewAdmissionBudget(1).Size(); got != 1 {
		t.Errorf("an explicit size of 1 was not honoured: %d", got)
	}
	if got := auth.NewAdmissionBudget(1 << 20).Size(); got != 4096 {
		t.Errorf("an absurd size was not clamped to 4096: %d", got)
	}
}

func TestAdmissionBudget_RefusedWorkRunsNoBcrypt(t *testing.T) {
	hash, err := auth.HashPassword("correct horse")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	b := auth.NewAdmissionBudget(1)
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("acquire refused")
	}

	if matched, admitted := b.CheckPassword(hash, "correct horse"); admitted || matched {
		t.Fatalf("CheckPassword on an exhausted budget: matched = %v, admitted = %v; want neither", matched, admitted)
	}
	if h, admitted, err := b.HashPassword("anything"); admitted || h != "" || err != nil {
		t.Fatalf("HashPassword on an exhausted budget = (%q, %v, %v); want refused with no hash and no error", h, admitted, err)
	}

	release()
	if matched, admitted := b.CheckPassword(hash, "correct horse"); !admitted || !matched {
		t.Fatalf("CheckPassword after release: matched = %v, admitted = %v; want both", matched, admitted)
	}
	if matched, admitted := b.CheckPassword(hash, "wrong"); !admitted || matched {
		t.Fatalf("CheckPassword(wrong) after release: matched = %v, admitted = %v; want admitted only", matched, admitted)
	}
	if h, admitted, err := b.HashPassword("anything"); !admitted || h == "" || err != nil {
		t.Fatalf("HashPassword after release = (%q, %v, %v); want a hash", h, admitted, err)
	}
	if b.InFlight() != 0 {
		t.Fatalf("in flight = %d after the wrapped calls returned, want 0", b.InFlight())
	}
}

// P5-S02: a login burst waits its turn instead of being refused. Acquire
// queues callers in arrival order behind the same budget, so the bounded-work
// guarantee (peak <= size) holds while every caller is eventually admitted.

// waitQueued blocks until n callers are queued on b.
func waitQueued(t *testing.T, b *auth.AdmissionBudget, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for b.QueuedForTest() != n {
		if time.Now().After(deadline) {
			t.Fatalf("queued = %d, want %d", b.QueuedForTest(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestAdmissionBudget_AcquireAdmitsEveryWaiterInFIFOOrder(t *testing.T) {
	const size, callers = 4, 40
	b := auth.NewAdmissionBudget(size)
	held := make([]func(), size)
	for i := range held {
		release, ok := b.TryAcquire()
		if !ok {
			t.Fatalf("could not take slot %d", i)
		}
		held[i] = release
	}

	type admission struct {
		caller  int
		release func()
	}
	admitted := make(chan admission, callers)
	for i := range callers {
		go func() {
			release, _, ok := b.Acquire(context.Background(), 10*time.Second)
			if !ok {
				t.Errorf("caller %d refused", i)
				admitted <- admission{i, func() {}}
				return
			}
			admitted <- admission{i, release}
		}()
		// One at a time, so arrival order is the caller index.
		waitQueued(t, b, i+1)
	}
	if _, ok := b.TryAcquire(); ok {
		t.Fatal("TryAcquire jumped a non-empty queue")
	}

	// Hand the slots on one at a time: each release admits exactly the next
	// waiter, which then holds its slot until the test releases it.
	pending := held
	for want := range callers {
		pending[0]()
		pending = pending[1:]
		a := <-admitted
		if a.caller != want {
			t.Fatalf("admission %d went to caller %d, want FIFO order", want, a.caller)
		}
		pending = append(pending, a.release)
	}
	for _, release := range pending {
		release()
	}
	if b.Peak() > size {
		t.Fatalf("peak = %d, want at most the budget %d", b.Peak(), size)
	}
	if b.InFlight() != 0 || b.QueuedForTest() != 0 {
		t.Fatalf("in flight = %d, queued = %d after every release, want 0 and 0", b.InFlight(), b.QueuedForTest())
	}
}

func TestAdmissionBudget_CancelledWaiterLeavesWithoutASlot(t *testing.T) {
	b := auth.NewAdmissionBudget(1)
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("could not take the only slot")
	}
	ctx, cancel := context.WithCancel(context.Background())
	type result struct {
		retry time.Duration
		ok    bool
	}
	done := make(chan result, 1)
	go func() {
		_, retry, ok := b.Acquire(ctx, 10*time.Second)
		done <- result{retry, ok}
	}()
	waitQueued(t, b, 1)
	cancel()
	r := <-done
	if r.ok {
		t.Fatal("a cancelled waiter was admitted")
	}
	if r.retry <= 0 {
		t.Fatalf("retry hint = %v, want positive", r.retry)
	}
	if b.QueuedForTest() != 0 || b.InFlight() != 1 {
		t.Fatalf("queued = %d, in flight = %d, want 0 and 1 (only the held slot)", b.QueuedForTest(), b.InFlight())
	}
	release()
	if b.InFlight() != 0 {
		t.Fatalf("in flight = %d after release, want 0: the cancelled waiter took a slot", b.InFlight())
	}
	if again, ok := b.TryAcquire(); !ok {
		t.Fatal("the slot did not come back after the cancelled waiter left")
	} else {
		again()
	}
}

func TestAdmissionBudget_WaiterPastItsDeadlineIsRefused(t *testing.T) {
	b := auth.NewAdmissionBudget(1)
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("could not take the only slot")
	}
	defer release()
	// The deadline sits just past the estimated wait, so the caller queues
	// and is refused only when it runs out.
	b.SetAvgHoldForTest(10 * time.Millisecond)
	if _, retry, ok := b.Acquire(context.Background(), 30*time.Millisecond); ok || retry <= 0 {
		t.Fatalf("Acquire past its deadline = (ok %v, retry %v), want refused with a positive hint", ok, retry)
	}
	if b.QueuedForTest() != 0 || b.InFlight() != 1 {
		t.Fatalf("queued = %d, in flight = %d, want 0 and 1", b.QueuedForTest(), b.InFlight())
	}
}

func TestAdmissionBudget_FullQueueRefusesAtOnceWithARetryHint(t *testing.T) {
	b := auth.NewAdmissionBudget(1)
	release, ok := b.TryAcquire()
	if !ok {
		t.Fatal("could not take the only slot")
	}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	qcap := b.QueueCapForTest()
	if qcap <= 0 {
		t.Fatalf("queue cap = %d, want positive", qcap)
	}
	// Deadlines far past the estimated wait, so only the cap can refuse.
	for range qcap {
		wg.Go(func() { b.Acquire(ctx, time.Hour) })
	}
	waitQueued(t, b, qcap)

	start := time.Now()
	_, retry, ok := b.Acquire(context.Background(), time.Hour)
	if ok {
		t.Fatal("a full queue admitted one more")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("a full queue made the caller wait %v, want an immediate refusal", waited)
	}
	if retry <= 0 {
		t.Fatalf("retry hint = %v, want positive", retry)
	}
	if b.QueuedForTest() != qcap {
		t.Fatalf("queued = %d after the refusal, want %d", b.QueuedForTest(), qcap)
	}
	cancel()
	wg.Wait()
	release()
	if b.InFlight() != 0 {
		t.Fatalf("in flight = %d, want 0", b.InFlight())
	}
}

// A queue the budget cannot serve inside the caller's wait refuses at once,
// from the measured hold time, instead of letting the caller wait out its
// deadline for nothing.
func TestAdmissionBudget_UnservableWaitRefusesAtOnce(t *testing.T) {
	b := auth.NewAdmissionBudget(2)
	for range 2 {
		release, ok := b.TryAcquire()
		if !ok {
			t.Fatal("could not take a slot")
		}
		defer release()
	}
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	defer wg.Wait()
	defer cancel()
	// 6 s holds on 2 slots: the first waiter faces 3 s, inside a 5 s
	// deadline; the next, with one waiter ahead, faces 6 s, past it.
	b.SetAvgHoldForTest(6 * time.Second)
	wg.Go(func() { b.Acquire(ctx, 5*time.Second) })
	waitQueued(t, b, 1)

	start := time.Now()
	_, retry, ok := b.Acquire(context.Background(), 5*time.Second)
	if ok {
		t.Fatal("a caller the budget cannot serve inside its wait was admitted")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("an unservable wait made the caller wait %v, want an immediate refusal", waited)
	}
	if retry <= 0 {
		t.Fatalf("retry hint = %v, want positive", retry)
	}
	if b.QueuedForTest() != 1 || b.InFlight() != 2 {
		t.Fatalf("queued = %d, in flight = %d, want 1 and 2 (the refusal took nothing)", b.QueuedForTest(), b.InFlight())
	}
}

// P5-S02 keeps bcrypt at cost 12: the queue removes refusals, not work.
func TestPasswordBcryptCostIsTwelve(t *testing.T) {
	if got := auth.ProductionBcryptCostForTest; got != 12 {
		t.Fatalf("production bcrypt cost = %d, want 12", got)
	}
}
