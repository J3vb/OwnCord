package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// mentionCountPayload is the mention_count payload: targeted, unsequenced, not replayed.
// channel_id names the channel whose read_states.mention_count changed; count is the
// reader's total after the bump, letting a client repaint an unfocused channel's badge live.
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

// mentionAudienceTimeout bounds the reads one badge preparation makes, so a stalled reader
// pool cannot hold the caller (which may hold a channel's mention emit lock) without end.
const mentionAudienceTimeout = 5 * time.Second

// NotifyMentionCount delivers a live mention_count frame to userID
// (service.MentionCountNotifier), targeted and unsequenced (SendToUserLow): a disconnected
// reader recovers the count on their next ready. The count is the total, not a delta, so a
// lost or duplicated frame converges. The service holds the channel's mention emit lock
// across every mention write and the frame, so frames arrive in the order the total changed
// (service.reverseMentionCounts). Skipped when the reader cannot currently see the channel
// (CanViewChannel): a revoked reader must not get a badge update for a channel their
// sidebar no longer lists. The stored count is still corrected.
func (h *Hub) NotifyMentionCount(userID, channelID, count int64) {
	if len(h.clientsOf(userID)) == 0 {
		return
	}
	h.PrepareMentionCounts(context.Background(), channelID, []int64{userID})(userID, count)
}

// PrepareMentionCounts satisfies service.MentionCountBatcher: it resolves once per flush
// which of userIDs may see channelID (the NotifyMentionCount rules) and returns the sender
// the service calls under the channel's emit lock. The channel is read once, and only
// connected candidates get a permission check. The verdict is as of preparation: a reader
// revoked in between can still get this one frame (a channel and a count), and their next
// ready reconciles it. A reader not connected at preparation is checked at send time. Call
// the sender on the goroutine that prepared it (or after a happens-before such as the emit
// lock): it fills its channel read lazily.
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
	if ctx.Err() != nil {
		withheld := 0
		for _, ok := range a.visible {
			if !ok {
				withheld++
			}
		}
		slog.Warn("ws: mention badge audience ran out of time, withholding live badges",
			"channel_id", channelID, "withheld", withheld)
	}
	return a.send
}

type mentionAudience struct {
	h         *Hub
	channelID int64
	// loaded is set once the channel read ran; see is nil when it failed, which sends nothing (fail closed).
	loaded      bool
	see         func(ctx context.Context, userID int64) bool
	forumScoped bool
	visible     map[int64]bool
}

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

func (a *mentionAudience) mayReceive(userID int64) bool {
	if ok, prepared := a.visible[userID]; prepared {
		return ok
	}
	ctx, cancel := context.WithTimeout(context.Background(), mentionAudienceTimeout)
	defer cancel()
	return a.loadChannel(ctx) && a.see(ctx, userID)
}
