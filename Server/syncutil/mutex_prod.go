//go:build !deadlock

package syncutil

import "sync"

// Mutex is sync.Mutex in production builds.
type Mutex = sync.Mutex

// RWMutex is sync.RWMutex in production builds.
type RWMutex = sync.RWMutex
