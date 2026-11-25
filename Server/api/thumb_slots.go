package api

import (
	"context"
	"runtime"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"
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
	// heavy admits one multi-slot conversion at a time (see acquireHeavy).
	heavy *semaphore.Weighted
	// flights collapses concurrent requests for one thumbnail into one generation.
	flights singleflight.Group
}

func makeThumbSlots(n int, wait time.Duration) *thumbSlots {
	return &thumbSlots{sem: semaphore.NewWeighted(int64(n)), size: int64(n), wait: wait, heavy: semaphore.NewWeighted(1)}
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

// acquireHeavy takes the slots for a conversion worth weight ordinary decodes (a HEIC). Only one runs at a
// time, and with two or more slots it leaves at least one free, so ordinary thumbnails keep going while a
// slow conversion runs: its decoder takes no context and cannot be stopped once started. Memory stays
// within thumbMaxSlots × thumbMaxDecodeBytes: one conversion (convertedHEICPeakBytes) plus at most
// size-weight ordinary decodes. The whole wait, for both, is at most s.wait and never past ctx.
func (s *thumbSlots) acquireHeavy(ctx context.Context, weight int64) (release func(), ok bool) {
	if s.size > 1 {
		weight = min(weight, s.size-1)
	}
	weight = min(weight, s.size)
	ctx, cancel := context.WithTimeout(ctx, s.wait)
	defer cancel()
	if err := s.heavy.Acquire(ctx, 1); err != nil {
		return nil, false
	}
	if err := s.sem.Acquire(ctx, weight); err != nil {
		s.heavy.Release(1)
		return nil, false
	}
	return func() {
		s.sem.Release(weight)
		s.heavy.Release(1)
	}, true
}

var (
	sharedSlotsMu syncutil.Mutex
	sharedSlots   *thumbSlots
)

// sharedThumbSlots is the one set of slots every thumbnail generation in the process takes: the thumbnail
// routes and the avatar uploads that make their small sizes up front.
func sharedThumbSlots() *thumbSlots {
	sharedSlotsMu.Lock()
	defer sharedSlotsMu.Unlock()
	if sharedSlots == nil {
		sharedSlots = newThumbSlots()
	}
	return sharedSlots
}

func resetSharedThumbSlots() {
	sharedSlotsMu.Lock()
	defer sharedSlotsMu.Unlock()
	sharedSlots = nil
}
