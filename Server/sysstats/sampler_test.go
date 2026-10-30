package sysstats

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeSystem hands out readings that advance by a fixed amount per read, on a
// clock that advances by Interval per read.
type fakeSystem struct {
	mu    sync.Mutex
	calls int
	clock time.Time
}

func (f *fakeSystem) read() Reading {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.clock = f.clock.Add(Interval)
	n := uint64(f.calls) //nolint:gosec // test counter
	return Reading{
		// 0.5 s of CPU per 5 s on 2 cores = 5%.
		ProcCPU: time.Duration(f.calls) * 500 * time.Millisecond, ProcCPUOK: true,
		// 25 busy of every 100 ticks = 25%.
		MachBusy: n * 25, MachTotal: n * 100, MachCPUOK: true,
		ProcMem: 100 << 20, ProcMemOK: true,
		MemUsed: 4 << 30, MemTotal: 16 << 30, MemOK: true, MemScope: ScopeMachine,
	}
}

func (f *fakeSystem) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.clock
}

func newFakeSampler(size int) (*Sampler, *fakeSystem) {
	f := &fakeSystem{clock: time.Unix(1_800_000_000, 0)}
	return newSampler(f.read, f.now, 2, size), f
}

// Before the first sample there is nothing; the first sample has memory but
// no CPU, since CPU needs two readings. It is missing, not 0%.
func TestSampler_FirstReading(t *testing.T) {
	s, _ := newFakeSampler(10)
	if snap := s.Snapshot(time.Hour, 100); snap.OK || len(snap.Points) != 0 {
		t.Fatalf("empty sampler snapshot = %+v, want nothing", snap)
	}

	s.sample()
	snap := s.Snapshot(time.Hour, 100)
	if !snap.OK {
		t.Fatal("snapshot after one sample: not ok")
	}
	if snap.Latest.ProcessCPU != nil || snap.Latest.MachineCPU != nil {
		t.Errorf("first sample CPU = %v / %v, want missing", snap.Latest.ProcessCPU, snap.Latest.MachineCPU)
	}
	if snap.Latest.ProcessMemory == nil || *snap.Latest.ProcessMemory != 100<<20 {
		t.Errorf("first sample memory = %v, want 100 MiB", snap.Latest.ProcessMemory)
	}
	if snap.MemTotal != 16<<30 || snap.MemScope != ScopeMachine || snap.Cores != 2 {
		t.Errorf("snapshot = total %d scope %q cores %d", snap.MemTotal, snap.MemScope, snap.Cores)
	}

	s.sample()
	snap = s.Snapshot(time.Hour, 100)
	if p := snap.Latest.ProcessCPU; p == nil || *p != 5 {
		t.Errorf("second sample process CPU = %v, want 5", p)
	}
	if m := snap.Latest.MachineCPU; m == nil || *m != 25 {
		t.Errorf("second sample machine CPU = %v, want 25", m)
	}
	if len(snap.Points) != 2 {
		t.Errorf("points = %d, want 2", len(snap.Points))
	}
}

// The ring keeps the newest samples once it wraps, oldest first.
func TestSampler_RingWraps(t *testing.T) {
	s, _ := newFakeSampler(4)
	for range 7 {
		s.sample()
	}
	snap := s.Snapshot(24*time.Hour, 100)
	if len(snap.Points) != 4 {
		t.Fatalf("points = %d, want 4", len(snap.Points))
	}
	for i := 1; i < len(snap.Points); i++ {
		if snap.Points[i].T-snap.Points[i-1].T != int64(Interval/time.Second) {
			t.Errorf("points not consecutive and ascending: %d then %d", snap.Points[i-1].T, snap.Points[i].T)
		}
	}
	if snap.Latest.T != snap.Points[3].T {
		t.Errorf("latest %d is not the last point %d", snap.Latest.T, snap.Points[3].T)
	}
}

// The window keeps only recent samples, and long windows are averaged down.
func TestSampler_WindowAndDownsample(t *testing.T) {
	s, _ := newFakeSampler(ringSize)
	for range 1000 {
		s.sample()
	}
	// A one-minute window ending at the newest sample holds 12 samples.
	if got := len(s.Snapshot(time.Minute, 1000).Points); got != 12 {
		t.Errorf("one-minute window = %d points, want 12", got)
	}
	snap := s.Snapshot(24*time.Hour, 100)
	if len(snap.Points) > 100 || len(snap.Points) < 90 {
		t.Errorf("downsampled to %d points, want at most 100", len(snap.Points))
	}
	// The first sample has no CPU; averaged with the rest of its run it does.
	if p := snap.Points[0].ProcessCPU; p == nil || *p != 5 {
		t.Errorf("first averaged point CPU = %v, want 5", p)
	}
}

// Missing figures stay missing through averaging.
func TestDownsample_MissingStaysMissing(t *testing.T) {
	s := newSampler(func() Reading { return Reading{} }, time.Now, 1, 10)
	for range 6 {
		s.sample()
	}
	for _, p := range s.Snapshot(time.Hour, 2).Points {
		if p.ProcessCPU != nil || p.MachineCPU != nil || p.ProcessMemory != nil || p.MemoryUsed != nil {
			t.Errorf("point = %+v, want every figure missing", p)
		}
	}
}

// Run samples at once, keeps sampling, and exits when its context ends. Many
// readers race the writer under -race.
func TestSampler_RunAndConcurrentReads(t *testing.T) {
	s, _ := newFakeSampler(100)
	ctx, cancel := context.WithCancel(t.Context())
	done := s.Run(ctx)
	if !s.Snapshot(time.Hour, 10).OK {
		t.Error("Run did not take its first sample before returning")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 200 {
				s.Snapshot(time.Hour, 10)
				s.sample()
			}
		})
	}
	wg.Wait()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after cancel")
	}
}
