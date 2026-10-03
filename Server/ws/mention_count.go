package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// mentionCountPayload is the mention_count frame's payload (DP-27): targeted
// at one reader, unsequenced, not replayed. channel_id names the channel whose
// read_states.mention_count changed; count is the reader's total after the
// bump. A client uses it to repaint that channel's badge live when the channel
// is not focused, whose chat_message broadcasts it never receives.
type mentionCountPayload struct {
	ChannelID int64 `json:"channel_id"`
	Count     int64 `json:"count"`
}

func buildMentionCount(channelID, count int64) []byte {
	return buildJSON(wsMsg{Type: MsgTypeMentionCount, Payload: mentionCountPayload{
		ChannelID: channelID, Count: count,
	}})
}

// NotifyMentionCount delivers a live mention_count frame to userID, satisfying
// service.MentionCountNotifier. Targeted and unsequenced (SendToUserLow): a
// disconnected reader recovers the authoritative count on their next ready,
// so a missed frame costs nothing — exactly the posture of
// NotifyAppealStatus/NotifyModAction. The count is the sender-side total, not
// a delta, so a lost or duplicated frame still converges.
//
// The frame is skipped when the reader cannot currently see the channel
// (CanViewChannel: channel READ_MESSAGES with both override layers, or DM
// membership). A reader whose access was revoked after being mentioned — a
// removed channel override, a role change, leaving the DM — must not receive
// a badge update for a channel their sidebar no longer lists. The stored count
// is still corrected; only the live frame is withheld.
func (h *Hub) NotifyMentionCount(userID, channelID, count int64) {
	if !h.canSeeChannelForMentionCount(userID, channelID) {
		return
	}
	h.SendToUserLow(userID, buildMentionCount(channelID, count))
}

// canSeeChannelForMentionCount reports whether userID may currently see
// channelID, using the same CanViewChannel predicate every channel-visibility
// path resolves. Fails closed on a channel or subject lookup error. A hub with
// no database (the bare test fixture) has nothing to resolve against and keeps
// the pre-existing delivery behavior.
func (h *Hub) canSeeChannelForMentionCount(userID, channelID int64) bool {
	if h.db == nil {
		return true
	}
	ctx := context.Background()
	ch, err := h.readers.Visibility.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return false
	}
	sub, err := channelSubject(ctx, h.readers.Dispatch, h.permChecker, h.perms, userID, ch, false)
	if err != nil {
		return false
	}
	return permissions.CanViewChannel(sub) == nil
}
