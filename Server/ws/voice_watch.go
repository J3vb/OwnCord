package ws

import (
	"context"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// voice_watch budget: the whole set is re-sent on every toggle, so a burst of clicks is
// normal but a flood is not (each accepted frame fans out to the channel).
const (
	voiceWatchRateLimit = 10
	voiceWatchWindow    = 5 * time.Second
	voiceWatchMaxIDs    = 16
)

type voiceWatchSet struct {
	chID    int64
	ids     []int64
	musicID int64 // the one sharer whose music the sender listens to; 0 = nobody
}

// handleVoiceWatchV2 validates and normalises the set (ids > 0, own id dropped, deduped,
// ascending, music_id kept only when > 0 and not the sender's own id, else 0) and returns SetVoiceWatching; the applier stores and relays it only if the
// sender is still in the channel. An empty set means "watching nothing". Ids are not
// checked against the roster: clients filter on display.
func handleVoiceWatchV2(_ context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	watchCmd := cmd.(VoiceWatchCmd)

	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("voice_watch", info.UserID), voiceWatchRateLimit, voiceWatchWindow) {
		return Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many watch updates"}}
	}
	if info.VoiceChannelID == 0 {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "not in a voice channel"}}
	}
	if len(watchCmd.UserIDs) > voiceWatchMaxIDs {
		return Result{Error: ClientError{Code: ErrCodeBadPayload, Message: "too many user_ids"}}
	}

	ids := make([]int64, 0, len(watchCmd.UserIDs))
	for _, id := range watchCmd.UserIDs {
		if id <= 0 || id == info.UserID {
			continue
		}
		ids = append(ids, id)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)

	musicID := watchCmd.MusicID
	if musicID <= 0 || musicID == info.UserID {
		musicID = 0
	}

	return Result{SetVoiceWatching: &voiceWatchSet{chID: info.VoiceChannelID, ids: ids, musicID: musicID}}
}

// sendVoicePeerWatching sends c one voice_watching for every other member of channelID with
// a non-empty watched set or a music listen. It is an unsequenced pub/sub frame no replay can recover, so a
// joiner and a resumed socket get it here, beside sendVoicePeerKeys. Peers are looked up
// under h.mu.RLock; the sends happen outside it.
func (h *Hub) sendVoicePeerWatching(c *Client, channelID int64) {
	for _, uid := range h.voiceChannelPeerUserIDs(channelID, c.userID) {
		peer := h.voiceClient(uid)
		if peer == nil {
			continue
		}
		if ids, musicID := peer.voice.watchStateIfChannel(channelID); len(ids) > 0 || musicID > 0 {
			c.sendMsg(buildVoiceWatching(uid, ids, musicID))
		}
	}
}

type voiceWatchingBroadcast struct {
	UserID  int64   `json:"user_id"`
	UserIDs []int64 `json:"user_ids"`
	MusicID int64   `json:"music_id,omitempty"` // the sharer whose music the member listens to; 0 = nobody
}

// buildVoiceWatching constructs a voice_watching relay; user_ids is always an array, never null.
func buildVoiceWatching(userID int64, ids []int64, musicID int64) []byte {
	if ids == nil {
		ids = []int64{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceWatching,
		Payload: voiceWatchingBroadcast{UserID: userID, UserIDs: ids, MusicID: musicID},
	})
}
