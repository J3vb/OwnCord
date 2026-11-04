package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// mentionCountPayload is the mention_count frame's payload: targeted
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

var _ service.MentionCountBatcher = (*Hub)(nil)

// mentionAudienceTimeout bounds the channel and permission reads one badge
// preparation makes, so a stalled reader pool cannot hold the caller (which may
// hold a channel's mention emit lock) without end.
const mentionAudienceTimeout = 5 * time.Second

// NotifyMentionCount delivers a live mention_count frame to userID, satisfying
// service.MentionCountNotifier. Targeted and unsequenced (SendToUserLow): a
// disconnected reader recovers the authoritative count on their next ready,
// so a missed frame costs nothing — exactly the posture of
// NotifyAppealStatus/NotifyModAction. The count is the sender-side total, not
// a delta, so a lost or duplicated frame still converges. The service holds
// the channel's mention emit lock across every mention write and the frame, so
// the frames a reader receives arrive in the order the server changed the
// total (see service.reverseMentionCounts): the last frame always carries the
// latest committed total, never an overtaken one.
//
// The frame is skipped when the reader cannot currently see the channel
// (CanViewChannel: channel READ_MESSAGES with both override layers, or DM
// membership). A reader whose access was revoked after being mentioned — a
// removed channel override, a role change, leaving the DM — must not receive
// a badge update for a channel their sidebar no longer lists. The stored count
// is still corrected; only the live frame is withheld.
func (h *Hub) NotifyMentionCount(userID, channelID, count int64) {
	if len(h.clientsOf(userID)) == 0 {
		return
	}
	h.PrepareMentionCounts(context.Background(), channelID, []int64{userID})(userID, count)
}

// PrepareMentionCounts satisfies service.MentionCountBatcher: it resolves, once
// per flush, which of userIDs may get a live mention_count frame for channelID
// (the NotifyMentionCount rules), and returns the sender the service calls under
// the channel's emit lock. The channel is read once, not once per reader and
// connection, and only connected candidates get a permission check. The sender
// takes a reader's connections when it runs; a reader the preparation did not
// cover (not connected then) is checked at send time instead. The sender is
// called from one goroutine at a time.
func (h *Hub) PrepareMentionCounts(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64) {
	a := &mentionAudience{h: h, channelID: channelID}
	if h.db == nil {
		return a.send
	}
	ctx, cancel := context.WithTimeout(ctx, mentionAudienceTimeout)
	defer cancel()
	for _, uid := range userIDs {
		if len(h.clientsOf(uid)) == 0 {
			continue
		}
		if !a.loadChannel(ctx) {
			break
		}
		if a.visible == nil {
			a.visible = make(map[int64]bool)
		}
		a.visible[uid] = a.see(ctx, uid)
	}
	return a.send
}

// mentionAudience is one prepared badge fan-out for a channel.
type mentionAudience struct {
	h         *Hub
	channelID int64
	// loaded is set once the channel read ran; see is nil when it failed, which
	// sends nothing (fails closed).
	loaded bool
	// see reports whether a reader may currently see the loaded channel.
	see func(ctx context.Context, userID int64) bool
	// forumScoped withholds the frame from sockets without the forums feature.
	forumScoped bool
	// visible holds the verdict for each reader prepared ahead of the send.
	visible map[int64]bool
}

// loadChannel reads the channel once; false when it is missing or unreadable.
func (a *mentionAudience) loadChannel(ctx context.Context) bool {
	if !a.loaded {
		a.loaded = true
		ch, err := a.h.readers.Visibility.GetChannel(ctx, a.channelID)
		if err == nil && ch != nil {
			a.see = func(ctx context.Context, userID int64) bool { return a.h.canSeeLoadedChannel(ctx, userID, ch) }
			a.forumScoped = isForumScoped(ctx, a.h.readers.Visibility, ch)
		}
	}
	return a.see != nil
}

// send delivers userID's frame to each of their live connections that may see it.
func (a *mentionAudience) send(userID, count int64) {
	conns := a.h.clientsOf(userID)
	if len(conns) == 0 {
		return
	}
	if a.h.db != nil && !a.mayReceive(userID) {
		return
	}
	frame := buildMentionCount(a.channelID, count)
	for _, c := range conns {
		if a.forumScoped && !c.features.forums {
			continue
		}
		c.sendLowMsg(frame)
	}
}

// mayReceive is the prepared verdict for userID, or a fresh check for a reader
// who connected after the preparation.
func (a *mentionAudience) mayReceive(userID int64) bool {
	if ok, prepared := a.visible[userID]; prepared {
		return ok
	}
	ctx, cancel := context.WithTimeout(context.Background(), mentionAudienceTimeout)
	defer cancel()
	return a.loadChannel(ctx) && a.see(ctx, userID)
}
