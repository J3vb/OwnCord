package api

import (
	"context"
	"runtime"
	"time"

	"golang.org/x/sync/semaphore"
)

const (
	// thumbMaxSlots bounds the thumbnails made at once on a large machine, so
	// decode buffers stay under thumbMaxSlots × thumbMaxDecodeBytes (384 MiB).
	thumbMaxSlots = 4
	// thumbSlotWait is how long a request waits for a free slot. A thumbnail
	// that cannot start in time is answered with its original instead; a
	// converted preview, which has no original to fall back on, with a 503.
	thumbSlotWait = 5 * time.Second
	// heicSlotWeight is how many slots a HEIC conversion holds: its peak
	// (convertedHEICPeakBytes) is close to three ordinary decodes.
	heicSlotWeight = (convertedHEICPeakBytes + thumbMaxDecodeBytes - 1) / thumbMaxDecodeBytes
)

// thumbSlotCount is how many thumbnails a machine with cpus CPUs makes at
// once: half its CPUs, at least one and at most thumbMaxSlots.
func thumbSlotCount(cpus int) int {
	return min(max(cpus/2, 1), thumbMaxSlots)
}

// thumbSlots bounds the thumbnails and previews generated at once, each slot
// worth one decode under thumbMaxDecodeBytes.
type thumbSlots struct {
	sem  *semaphore.Weighted
	size int64
	wait time.Duration
}

func makeThumbSlots(n int, wait time.Duration) *thumbSlots {
	return &thumbSlots{sem: semaphore.NewWeighted(int64(n)), size: int64(n), wait: wait}
}

// newThumbSlots builds the slots a thumbnail handler uses. It is a var only
// so tests can size and hold them.
var newThumbSlots = func() *thumbSlots {
	return makeThumbSlots(thumbSlotCount(runtime.NumCPU()), thumbSlotWait)
}

// acquire takes weight slots (all of them when weight is more), waiting at
// most s.wait and never past ctx. ok is false when they were not free in
// time; otherwise release gives them back.
func (s *thumbSlots) acquire(ctx context.Context, weight int64) (release func(), ok bool) {
	weight = min(weight, s.size)
	ctx, cancel := context.WithTimeout(ctx, s.wait)
	defer cancel()
	if err := s.sem.Acquire(ctx, weight); err != nil {
		return nil, false
	}
	return func() { s.sem.Release(weight) }, true
}
