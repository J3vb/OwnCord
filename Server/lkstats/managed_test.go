package lkstats

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/sysstats"
)

type proc struct {
	pid     int
	pidOK   bool
	r       sysstats.ProcessReading
	readOK  bool
	rooms   int
	parts   int
	roomErr error
}

func (p *proc) deps() ManagedDeps {
	return ManagedDeps{
		PID:       func() (int, bool) { return p.pid, p.pidOK },
		Read:      func(int) (sysstats.ProcessReading, bool) { return p.r, p.readOK },
		RoomUsage: func(context.Context) (int, int, error) { return p.rooms, p.parts, p.roomErr },
		Cores:     4,
	}
}

func newManagedTest(p *proc) (*Sampler, *fakeClock) {
	clk := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	src := &managedSource{deps: p.deps()}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return newSampler(SourceManaged, src.fetch, clk.now, log, 100), clk
}

func running(pid int, start uint64, cpu time.Duration) *proc {
	return &proc{pid: pid, pidOK: true, readOK: true, r: sysstats.ProcessReading{CPU: cpu, RSS: 1 << 20, Start: start}, rooms: 2, parts: 5}
}

func TestManaged_FillsFiguresAndLeavesTracksMissing(t *testing.T) {
	p := running(10, 1, 100*time.Second)
	s, clk := newManagedTest(p)
	s.sample(context.Background())
	p.r.CPU = 105 * time.Second
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	got := snap.Latest
	if snap.Source != SourceManaged || snap.Status != StatusOK {
		t.Fatalf("source %q status %q", snap.Source, snap.Status)
	}
	if got.CPU == nil || *got.CPU != 50 || *got.Memory != 1<<20 || *got.Cores != 4 || *got.Rooms != 2 || *got.Participants != 5 {
		t.Errorf("latest = %+v", got)
	}
	if got.TracksPublished != nil || got.TracksSubscribed != nil || got.BytesInPerSec != nil || got.BytesOutPerSec != nil {
		t.Errorf("tracks and traffic must stay missing: %+v", got)
	}
}

func TestManaged_PIDChangeDropsBaseline(t *testing.T) {
	p := running(10, 1, 100*time.Second)
	s, clk := newManagedTest(p)
	s.sample(context.Background())

	// A restarted LiveKit whose CPU total is higher than the old one would be a
	// spike (1000%) if the old baseline were kept.
	p.pid, p.r = 11, sysstats.ProcessReading{CPU: 200 * time.Second, RSS: 1 << 20, Start: 2}
	step(s, clk)
	if cpu := s.Snapshot(time.Hour, 10).Latest.CPU; cpu != nil {
		t.Fatalf("cpu after a pid change = %v, want nil", *cpu)
	}
	p.r.CPU = 205 * time.Second
	step(s, clk)
	if cpu := s.Snapshot(time.Hour, 10).Latest.CPU; cpu == nil || *cpu != 50 {
		t.Fatalf("cpu once the new baseline exists = %v, want 50", cpu)
	}
}

func TestManaged_ReusedOrVanishedPIDIsAGap(t *testing.T) {
	p := running(10, 1, 100*time.Second)
	s, clk := newManagedTest(p)
	s.sample(context.Background())

	// Same pid, different start token: another process's numbers.
	p.r = sysstats.ProcessReading{CPU: 900 * time.Second, RSS: 1 << 20, Start: 77}
	step(s, clk)
	if cpu := s.Snapshot(time.Hour, 10).Latest.CPU; cpu != nil {
		t.Fatalf("cpu after a start-token change = %v, want nil", *cpu)
	}

	// The process vanished between the pid check and the read.
	p.readOK = false
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusOK || snap.Latest.CPU != nil || snap.Latest.Memory != nil {
		t.Fatalf("a failed read must be a gap: status %q, %+v", snap.Status, snap.Latest)
	}

	// It is back with a CPU total above the earlier baseline; the failed read
	// dropped that baseline, so there is still no rate on this sample.
	p.readOK, p.r = true, sysstats.ProcessReading{CPU: 950 * time.Second, RSS: 1 << 20, Start: 77}
	step(s, clk)
	if cpu := s.Snapshot(time.Hour, 10).Latest.CPU; cpu != nil {
		t.Fatalf("cpu right after a gap = %v, want nil", *cpu)
	}
}

func TestManaged_NoPIDIsRestarting(t *testing.T) {
	p := running(10, 1, 100*time.Second)
	s, clk := newManagedTest(p)
	s.sample(context.Background())

	p.pidOK = false
	step(s, clk)
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusRestarting || snap.Latest.CPU != nil || snap.Latest.Rooms != nil || snap.Latest.Cores != nil {
		t.Fatalf("restarting: status %q, %+v", snap.Status, snap.Latest)
	}

	p.pidOK, p.pid, p.r = true, 12, sysstats.ProcessReading{CPU: time.Second, RSS: 1 << 20, Start: 9}
	step(s, clk)
	if got := s.Snapshot(time.Hour, 10); got.Status != StatusOK || got.Latest.CPU != nil {
		t.Fatalf("after restart: status %q, cpu %v", got.Status, got.Latest.CPU)
	}
}

func TestManaged_RoomUsageFailureKeepsStatusOK(t *testing.T) {
	p := running(10, 1, 100*time.Second)
	p.roomErr = errors.New("down")
	s, _ := newManagedTest(p)
	s.sample(context.Background())
	snap := s.Snapshot(time.Hour, 10)
	if snap.Status != StatusOK || snap.Latest.Rooms != nil || snap.Latest.Participants != nil || snap.Latest.Memory == nil {
		t.Fatalf("status %q, %+v", snap.Status, snap.Latest)
	}
}
