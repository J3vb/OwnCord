package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// voice_speak budget: a client sends one frame when its ring changes and one a second while
// it stays lit, about four a second at most. Each accepted frame fans out to the channel.
const (
	voiceSpeakRateLimit = 40
	voiceSpeakWindow    = 5 * time.Second
)

type voiceSpeakingRelay struct {
	chID     int64
	speaking *bool
}

// handleVoiceSpeakV2 passes the sender's own speaking ring on to its voice channel. The
// server keeps nothing: a listener drops a ring nobody repeats, so a frame that is over
// budget, or from a client that is in no voice channel, is dropped without an answer.
// The relay names the sender, so a client can announce only its own ring; whether a
// microphone is muted is the listener's check, as it is for the media server's verdict.
func handleVoiceSpeakV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	speakCmd := cmd.(VoiceSpeakCmd)

	if info.VoiceChannelID == 0 {
		return Result{}
	}
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("voice_speak", info.UserID), voiceSpeakRateLimit, voiceSpeakWindow) {
		return Result{}
	}
	return Result{RelayVoiceSpeaking: &voiceSpeakingRelay{chID: info.VoiceChannelID, speaking: speakCmd.Speaking}}
}

type voiceSpeakingBroadcast struct {
	UserID   int64 `json:"user_id"`
	Speaking *bool `json:"speaking"`
}

// buildVoiceSpeaking constructs a voice_speaking relay; speaking is true, false or null.
func buildVoiceSpeaking(userID int64, speaking *bool) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceSpeaking,
		Payload: voiceSpeakingBroadcast{UserID: userID, Speaking: speaking},
	})
}
