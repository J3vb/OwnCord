package voicestate

import (
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

type rejoinBlock struct {
	channelID int64
	until     time.Time
}

// RejoinBlocks is the userID -> latest moderator removal map that refuses an
// automatic voice_join back into the channel the user was removed from. A later
// removal replaces the earlier one; expired entries are dropped when read. The
// window is the caller's policy: Block takes the expiry.
type RejoinBlocks struct {
	mu      syncutil.Ranked[lockrank.Leaf]
	entries map[int64]rejoinBlock
}

// Block records that userID was removed from channelID, refusing a rejoin there
// until until.
func (s *RejoinBlocks) Block(userID, channelID int64, until time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[int64]rejoinBlock{}
	}
	s.entries[userID] = rejoinBlock{channelID: channelID, until: until}
}

// Blocked reports whether userID's latest removal, still in force, was from
// channelID.
func (s *RejoinBlocks) Blocked(userID, channelID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[userID]
	if !ok {
		return false
	}
	if !time.Now().Before(e.until) {
		delete(s.entries, userID)
		return false
	}
	return e.channelID == channelID
}

// Clear forgets userID's removal (the user chose to join again).
func (s *RejoinBlocks) Clear(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, userID)
}
