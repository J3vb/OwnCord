package ws

import (
	"context"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// voice_watch budget: the whole set is re-sent on every toggle, so a burst of
// clicks is normal but a flood is not (each accepted frame fans out to the
// channel).
const (
	voiceWatchRateLimit = 10
	voiceWatchWindow    = 5 * time.Second
	// voiceWatchMaxIDs bounds one set; more is BAD_PAYLOAD.
	voiceWatchMaxIDs = 16
)

// voiceWatchSet is what handleVoiceWatchV2 asks the applier to store and relay:
// the sanitized set, decided against channel chID.
type voiceWatchSet struct {
	chID int64
	ids  []int64
}

// handleVoiceWatchV2 is the pure V2 handler for voice_watch. It validates and
// normalises the set (ids > 0, own id dropped, deduped, ascending) and returns
// SetVoiceWatching; the applier stores and relays it only if the sender is
// still in the channel (Result.SetVoiceWatching). An empty set is valid and
// means "watching nothing". The ids are not checked against the roster: clients
// filter on display.
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

	return Result{SetVoiceWatching: &voiceWatchSet{chID: info.VoiceChannelID, ids: ids}}
}

// sendVoicePeerWatching sends c one voice_watching for every other member of
// channelID whose watched set is non-empty. voice_watching is an unsequenced
// pub/sub frame no reconnect replay can recover, so a joiner and a resumed
// socket get it here, beside sendVoicePeerKeys. Peer clients are looked up
// under h.mu.RLock (voiceChannelPeerUserIDs / the snapshot below); the sends
// happen outside it.
func (h *Hub) sendVoicePeerWatching(c *Client, channelID int64) {
	for _, uid := range h.voiceChannelPeerUserIDs(channelID, c.userID) {
		peer := h.voiceClient(uid)
		if peer == nil {
			continue
		}
		if ids := peer.voice.watchingIfChannel(channelID); len(ids) > 0 {
			c.sendMsg(buildVoiceWatching(uid, ids))
		}
	}
}

// voiceWatchingBroadcast is the server→client voice_watching relay: the users
// whose screen share user_id watches now.
type voiceWatchingBroadcast struct {
	UserID  int64   `json:"user_id"`
	UserIDs []int64 `json:"user_ids"`
}

// buildVoiceWatching constructs a voice_watching server→client relay. user_ids
// is always an array, never null.
func buildVoiceWatching(userID int64, ids []int64) []byte {
	if ids == nil {
		ids = []int64{}
	}
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceWatching,
		Payload: voiceWatchingBroadcast{UserID: userID, UserIDs: ids},
	})
}
