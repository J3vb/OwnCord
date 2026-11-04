package lkstats

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/sysstats"
)

// ManagedDeps are the reads the built-in source makes; tests replace them.
type ManagedDeps struct {
	// PID is the running LiveKit's process id, ok false when none runs.
	PID func() (int, bool)
	// RoomUsage counts open rooms and the participants in them.
	RoomUsage func(ctx context.Context) (rooms, participants int, err error)
	// Cores is how many cores LiveKit may use.
	Cores int
	// Read reads one process; sysstats.ReadProcess outside tests.
	Read func(pid int) (sysstats.ProcessReading, bool)
}

// NewManaged returns a sampler over the LiveKit process OwnCord runs. Tracks
// and traffic are not available from outside the process, so they stay
// missing. log may be nil.
func NewManaged(d ManagedDeps, log *slog.Logger) *Sampler {
	if log == nil {
		log = slog.Default()
	}
	src := &managedSource{deps: d}
	return newSampler(SourceManaged, src.fetch, time.Now, log, ringSize)
}

// managedSource remembers which process it last read, so a restart or a reused
// pid is never read as the same process. Only the sampler goroutine calls it.
type managedSource struct {
	deps  ManagedDeps
	have  bool
	pid   int
	start uint64
}

func (s *managedSource) fetch(ctx context.Context) fetchResult {
	pid, ok := s.deps.PID()
	if !ok {
		s.have = false
		return fetchResult{status: StatusRestarting, reason: "no process", reset: true}
	}
	res := fetchResult{status: StatusOK}
	if r, ok := s.deps.Read(pid); ok {
		res.reset = s.have && (s.pid != pid || s.start != r.Start)
		s.have, s.pid, s.start = true, pid, r.Start
		res.m.CPUSeconds, res.m.HasCPU = r.CPU.Seconds(), true
		res.m.RSSBytes, res.m.HasRSS = float64(r.RSS), true
	} else {
		// Gone between the pid check and the read, or unreadable here.
		s.have = false
		res.reset = true
	}
	if s.deps.Cores > 0 {
		res.m.Cores, res.m.HasCores = float64(s.deps.Cores), true
	}
	if s.deps.RoomUsage != nil {
		rctx, cancel := context.WithTimeout(ctx, Timeout)
		defer cancel()
		if rooms, parts, err := s.deps.RoomUsage(rctx); err == nil {
			res.m.Rooms, res.m.HasRooms = float64(rooms), true
			res.m.Participants, res.m.HasParticipants = float64(parts), true
		}
	}
	return res
}
