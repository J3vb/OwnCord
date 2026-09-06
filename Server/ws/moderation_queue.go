package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// modQueuePayload is the mod_queue frame's payload: the report id and its
// new state — never the reporter's identity, never the reported content,
// never the subject (S5, report confidentiality).
type modQueuePayload struct {
	ReportID int64  `json:"report_id"`
	State    string `json:"state"`
}

func buildModQueue(reportID int64, state string) []byte {
	return buildJSON(wsMsg{Type: MsgTypeModQueue, Payload: modQueuePayload{ReportID: reportID, State: state}})
}

// moderationAudience returns the connected user IDs whose current Subject
// satisfies permissions.CanModerate — the server-wide mirror of
// channelReadAudienceImpl (hub_visibility.go), which resolves a per-channel
// predicate the same way. CanModerate is not channel-scoped, so this asks
// each connected user's role-only Subject (channelID 0: no channel exists to
// resolve an override against, and CanModerate does not consult one).
func (h *Hub) moderationAudience(ctx context.Context) []int64 {
	h.mu.RLock()
	userIDs := make([]int64, 0, len(h.clients))
	for uid := range h.clients {
		userIDs = append(userIDs, uid)
	}
	h.mu.RUnlock()

	audience := make([]int64, 0, len(userIDs))
	for _, uid := range userIDs {
		sub, err := h.subjectFor(ctx, uid, 0)
		if err != nil {
			continue
		}
		if permissions.CanModerate(sub) == nil {
			audience = append(audience, uid)
		}
	}
	return audience
}

// BroadcastModQueue notifies every connected moderation-bit holder that
// report reportID changed, on create, assign and close. Never reaches the
// subject or the reporter unless they also hold the bit, and even then the
// frame carries only the id and state. Unsequenced and not replayed
// (SendToUserLow): a moderator who was offline gets the current queue from
// GET /api/v1/moderation/queue, not from reconnect replay, so a dropped
// frame under backpressure costs nothing durable.
func (h *Hub) BroadcastModQueue(ctx context.Context, reportID int64, state string) {
	msg := buildModQueue(reportID, state)
	for _, uid := range h.moderationAudience(ctx) {
		h.SendToUserLow(uid, msg)
	}
}
