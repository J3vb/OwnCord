//go:build deadlock

package syncutil

import "github.com/sasha-s/go-deadlock"

// Mutex is deadlock.Mutex when built with -tags=deadlock.
type Mutex = deadlock.Mutex

// RWMutex is deadlock.RWMutex when built with -tags=deadlock.
type RWMutex = deadlock.RWMutex

// go-deadlock pools lock-wait timers, and a timer first used inside a synctest
// bubble crashes a later Lock outside it that reuses it; fresh timers are cheap here.
func init() {
	deadlock.Opts.TimerPool = deadlock.TimerPoolDisabled
}
