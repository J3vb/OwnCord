package voicestate

import (
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

// ReconcileMisses is the reconciler's cross-tick memory: consecutive ticks an exact SFU
// identity (user + join token) has been missing. Keyed by identity so a rejoin starts a
// fresh count.
type ReconcileMisses struct {
	mu      syncutil.Ranked[lockrank.Leaf]
	missing map[string]int
}

// Miss records one absent tick for identity and returns the new count.
func (s *ReconcileMisses) Miss(identity string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.missing == nil {
		s.missing = map[string]int{}
	}
	s.missing[identity]++
	return s.missing[identity]
}

// Clear forgets identity (seen this tick, or reaped).
func (s *ReconcileMisses) Clear(identity string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.missing, identity)
}

// Prune drops counters whose identity no longer belongs to any voice_states row, so none leaks for the
// process lifetime.
func (s *ReconcileMisses) Prune(live map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.missing {
		if _, ok := live[id]; !ok {
			delete(s.missing, id)
		}
	}
}
