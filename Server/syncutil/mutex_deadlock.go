//go:build deadlock

package syncutil

import "github.com/sasha-s/go-deadlock"

// A pooled watcher timer first armed inside a testing/synctest bubble crashes
// the runtime when a later lock outside the bubble re-arms it ("reset of
// synctest timer from outside bubble"). Fresh timers per lock avoid that.
func init() {
	deadlock.Opts.TimerPool = deadlock.TimerPoolDisabled
}

// Mutex is deadlock.Mutex when built with -tags=deadlock.
// It detects potential deadlocks via lock ordering analysis.
type Mutex = deadlock.Mutex

// RWMutex is deadlock.RWMutex when built with -tags=deadlock.
type RWMutex = deadlock.RWMutex
