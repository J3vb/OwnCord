package ws

// voice_rejoin_block.go: a moderator's removal is not undone by a reconnect. A client whose
// voice was reconnecting when a moderator kicked or moved it can miss the unsequenced
// voice_disconnected or voice_moved, and its reconnect loop answers the released membership
// with voice_join. For voiceRejoinBlockWindow after a moderator kick or move, an automatic
// voice_join to the channel the user was removed from is refused; the user's own join
// (user_initiated) is not, and clears the block.

import "time"

// voiceRejoinBlockWindow is how long a moderator removal refuses the user's voice_join to the same channel. A
// var so tests can shrink it.
var voiceRejoinBlockWindow = 60 * time.Second

const voiceRejoinRefusal = "You were removed from this voice channel"

// BlockVoiceRejoin records a moderator removal of userID from channelID.
func (h *Hub) BlockVoiceRejoin(userID, channelID int64) {
	h.voiceHub.rejoinBlocks.Block(userID, channelID, time.Now().Add(voiceRejoinBlockWindow))
}

// voiceRejoinBlocker lets the moderation handlers record a removal; like voiceChannelDisconnector, an
// optional VoiceModerator extension the production moderator must keep satisfying.
type voiceRejoinBlocker interface {
	BlockVoiceRejoin(userID, channelID int64)
}

var _ voiceRejoinBlocker = (*Hub)(nil)

func blockVoiceRejoin(mod VoiceModerator, userID, channelID int64) {
	if b, ok := mod.(voiceRejoinBlocker); ok {
		b.BlockVoiceRejoin(userID, channelID)
	}
}
