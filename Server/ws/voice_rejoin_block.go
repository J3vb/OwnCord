package ws

// voice_rejoin_block.go — a moderator's removal is not undone by a reconnect.
//
// A client whose voice was reconnecting when a moderator kicked it (or moved
// it, which lands as a removal while its socket is gone) can miss the
// unsequenced voice_disconnected, and its reconnect loop answers the released
// membership with voice_join (P2-T5). For voiceRejoinBlockWindow after such a
// removal, voice_join from that user to that channel is refused.

import (
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// voiceRejoinBlockWindow is how long a moderator removal refuses the removed
// user's voice_join to the same channel. A var so tests can shrink it.
var voiceRejoinBlockWindow = 60 * time.Second

// voiceRejoinRefusal is the error message of a refused voice_join.
const voiceRejoinRefusal = "You were removed from this voice channel"

type voiceRejoinBlock struct {
	channelID int64
	until     time.Time
}

// voiceRejoinBlockState is the userID -> latest removal map. A later removal
// replaces the earlier one; expired entries are dropped when read.
type voiceRejoinBlockState struct {
	mu      syncutil.Mutex
	entries map[int64]voiceRejoinBlock
}

func (s *voiceRejoinBlockState) block(userID, channelID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = map[int64]voiceRejoinBlock{}
	}
	s.entries[userID] = voiceRejoinBlock{channelID: channelID, until: time.Now().Add(voiceRejoinBlockWindow)}
}

func (s *voiceRejoinBlockState) blocked(userID, channelID int64) bool {
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

// BlockVoiceRejoin records a moderator removal of userID from channelID.
func (h *Hub) BlockVoiceRejoin(userID, channelID int64) {
	h.voiceRejoinBlocks.block(userID, channelID)
}

// voiceRejoinBlocker lets the moderation handlers record a removal. Like
// voiceChannelDisconnector, an optional extension of VoiceModerator that the
// production moderator must keep satisfying.
type voiceRejoinBlocker interface {
	BlockVoiceRejoin(userID, channelID int64)
}

var _ voiceRejoinBlocker = (*Hub)(nil)

func blockVoiceRejoin(mod VoiceModerator, userID, channelID int64) {
	if b, ok := mod.(voiceRejoinBlocker); ok {
		b.BlockVoiceRejoin(userID, channelID)
	}
}
