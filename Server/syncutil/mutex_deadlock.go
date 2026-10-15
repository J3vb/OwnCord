//go:build deadlock

package syncutil

import "github.com/sasha-s/go-deadlock"

// Mutex is deadlock.Mutex when built with -tags=deadlock.
// It detects potential deadlocks via lock ordering analysis.
type Mutex = deadlock.Mutex

// RWMutex is deadlock.RWMutex when built with -tags=deadlock.
type RWMutex = deadlock.RWMutex

// go-deadlock pools its lock-wait timers. A timer first used inside a
// testing/synctest bubble belongs to that bubble, so a later Lock outside it
// that reuses the pooled timer crashes the process ("reset of synctest timer
// from outside bubble"). Fresh timers per lock cost little in this debug-only
// build.
func init() {
	deadlock.Opts.TimerPool = deadlock.TimerPoolDisabled
}
