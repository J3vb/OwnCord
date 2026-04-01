// Package syncutil provides mutex types that switch between sync.Mutex
// and go-deadlock equivalents based on the "deadlock" build tag.
// Production builds use the standard library; test/dev builds with
// -tags=deadlock get automatic deadlock detection.
package syncutil
