//go:build deadlock

package syncutil

import "github.com/sasha-s/go-deadlock"

// Mutex is deadlock.Mutex when built with -tags=deadlock.
// It detects potential deadlocks via lock ordering analysis.
type Mutex = deadlock.Mutex

// RWMutex is deadlock.RWMutex when built with -tags=deadlock.
type RWMutex = deadlock.RWMutex
