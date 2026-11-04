package ws

// voice_rejoin_block.go — a moderator's removal is not undone by a reconnect.
//
// A client whose voice was reconnecting when a moderator kicked or moved it
// can miss the unsequenced voice_disconnected or voice_moved, and its
// reconnect loop answers the released membership with voice_join (P2-T5). For
// voiceRejoinBlockWindow after any moderator kick or move, an automatic
// voice_join from that user to the channel it was removed from is refused.
// The user's own join (payload user_initiated) is not, and clears the block:
// a removed user may always click back into a channel they can still join.

import "time"

// voiceRejoinBlockWindow is how long a moderator removal refuses the removed
// user's voice_join to the same channel. A var so tests can shrink it.
var voiceRejoinBlockWindow = 60 * time.Second

// voiceRejoinRefusal is the error message of a refused voice_join.
const voiceRejoinRefusal = "You were removed from this voice channel"

// BlockVoiceRejoin records a moderator removal of userID from channelID.
func (h *Hub) BlockVoiceRejoin(userID, channelID int64) {
	h.voiceHub.rejoinBlocks.Block(userID, channelID, time.Now().Add(voiceRejoinBlockWindow))
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
