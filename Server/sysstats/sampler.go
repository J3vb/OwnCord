package sysstats

import (
	"context"
	"math"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	// Interval is how often the sampler reads.
	Interval = 5 * time.Second
	// Horizon is how far back the ring reaches.
	Horizon = 24 * time.Hour

	ringSize = int(Horizon / Interval) // 17,280 samples of 24 bytes, ~400 KB
)

// Point is one sample as the admin API serves it. A nil field is a figure
// this system could not give, or (for CPU) the first sample, which has no
// earlier one to measure from.
type Point struct {
	T             int64    `json:"t"` // unix seconds
	ProcessCPU    *float64 `json:"process_cpu"`
	MachineCPU    *float64 `json:"machine_cpu"`
	ProcessMemory *uint64  `json:"process_memory"`
	MemoryUsed    *uint64  `json:"memory_used"`
}

// Snapshot is the newest sample plus the series over a window.
type Snapshot struct {
	// Latest is the newest sample; ok is false until the first one is taken.
	Latest Point
	OK     bool
	// MemTotal and MemScope describe MemoryUsed: the machine's memory, or the
	// container's limit. MemTotal is zero when unknown.
	MemTotal uint64
	MemScope string
	Cores    int
	// Points is the window, oldest first, averaged down to at most the
	// requested number of points.
	Points []Point
}

// sample is one ring slot. NaN marks a missing figure.
type sample struct {
	at               int64
	procCPU, machCPU float32
	procMem, memUsed float32
}

// Sampler reads the system every Interval into a fixed ring. One goroutine
// (Run) writes; Snapshot reads under the same lock.
type Sampler struct {
	read  func() Reading
	now   func() time.Time
	cores int

	mu       syncutil.Mutex
	ring     []sample
	next     int
	size     int
	prev     Reading
	prevAt   time.Time
	hasPrev  bool
	memTotal uint64
	memScope string
}

// NewSampler returns a sampler over this machine. It reads nothing until Run.
func NewSampler() *Sampler {
	return newSampler(Read, time.Now, Cores(), ringSize)
}

func newSampler(read func() Reading, now func() time.Time, cores, size int) *Sampler {
	return &Sampler{read: read, now: now, cores: cores, ring: make([]sample, size)}
}

// Run takes a sample now and then every Interval until ctx is done. The
// returned channel closes when the goroutine has exited.
func (s *Sampler) Run(ctx context.Context) <-chan struct{} {
	s.sample()
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.sample()
			}
		}
	}()
	return done
}

// sample reads the system outside the lock (it touches files) and records it.
func (s *Sampler) sample() {
	r := s.read()
	at := s.now()

	s.mu.Lock()
	defer s.mu.Unlock()
	nan := float32(math.NaN())
	sm := sample{at: at.Unix(), procCPU: nan, machCPU: nan, procMem: nan, memUsed: nan}
	if s.hasPrev {
		proc, procOK, mach, machOK := Usage(s.prev, r, at.Sub(s.prevAt), s.cores)
		if procOK {
			sm.procCPU = float32(proc)
		}
		if machOK {
			sm.machCPU = float32(mach)
		}
	}
	if r.ProcMemOK {
		sm.procMem = float32(r.ProcMem)
	}
	if r.MemOK {
		sm.memUsed = float32(r.MemUsed)
		s.memTotal, s.memScope = r.MemTotal, r.MemScope
	} else {
		s.memTotal, s.memScope = 0, ""
	}
	s.prev, s.prevAt, s.hasPrev = r, at, true

	s.ring[s.next] = sm
	s.next = (s.next + 1) % len(s.ring)
	if s.size < len(s.ring) {
		s.size++
	}
}

// Snapshot returns the newest sample and the samples of the last window,
// averaged in equal runs down to at most maxPoints.
func (s *Sampler) Snapshot(window time.Duration, maxPoints int) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := Snapshot{MemTotal: s.memTotal, MemScope: s.memScope, Cores: s.cores, Points: []Point{}}
	if s.size == 0 {
		return snap
	}
	newest := s.ring[(s.next-1+len(s.ring))%len(s.ring)]
	snap.Latest, snap.OK = newest.point(), true

	from := s.now().Add(-window).Unix()
	start := (s.next - s.size + len(s.ring)) % len(s.ring)
	var in []sample
	for i := range s.size {
		sm := s.ring[(start+i)%len(s.ring)]
		if sm.at > from {
			in = append(in, sm)
		}
	}
	snap.Points = downsample(in, maxPoints)
	return snap
}

// downsample averages consecutive runs of samples so at most maxPoints remain.
// A run is stamped with its last sample's time; a figure missing from every
// sample of a run stays missing.
func downsample(in []sample, maxPoints int) []Point {
	if maxPoints < 1 {
		maxPoints = 1
	}
	step := max((len(in)+maxPoints-1)/maxPoints, 1)
	out := make([]Point, 0, (len(in)+step-1)/step)
	for i := 0; i < len(in); i += step {
		run := in[i:min(i+step, len(in))]
		avg := sample{at: run[len(run)-1].at}
		avg.procCPU = mean(run, func(s sample) float32 { return s.procCPU })
		avg.machCPU = mean(run, func(s sample) float32 { return s.machCPU })
		avg.procMem = mean(run, func(s sample) float32 { return s.procMem })
		avg.memUsed = mean(run, func(s sample) float32 { return s.memUsed })
		out = append(out, avg.point())
	}
	return out
}

func mean(run []sample, field func(sample) float32) float32 {
	var sum float64
	var n int
	for _, s := range run {
		if v := field(s); !math.IsNaN(float64(v)) {
			sum += float64(v)
			n++
		}
	}
	if n == 0 {
		return float32(math.NaN())
	}
	return float32(sum / float64(n))
}

func (s sample) point() Point {
	p := Point{T: s.at}
	p.ProcessCPU = pct(s.procCPU)
	p.MachineCPU = pct(s.machCPU)
	p.ProcessMemory = bytes(s.procMem)
	p.MemoryUsed = bytes(s.memUsed)
	return p
}

// pct rounds a percentage to one decimal; NaN is missing.
func pct(v float32) *float64 {
	if math.IsNaN(float64(v)) {
		return nil
	}
	r := math.Round(float64(v)*10) / 10
	return &r
}

func bytes(v float32) *uint64 {
	if math.IsNaN(float64(v)) || v < 0 {
		return nil
	}
	b := uint64(v)
	return &b
}
