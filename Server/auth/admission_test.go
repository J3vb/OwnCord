package auth_test

import (
	"sync"
	"sync/atomic"
	"testing"

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
