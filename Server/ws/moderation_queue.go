package ws

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// modQueuePayload is the mod_queue payload: EITHER a report's PUBLIC id (report_id) OR an
// appeal's PUBLIC id (appeal_id) plus the new state, never the reporter's/appellant's
// identity, the reported content or subject (report confidentiality), nor the internal
// sequential id (a gap would let a bit holder infer a neighbouring report's existence).
// Exactly one of ReportID/AppealID is set, so moderationAudience serves both queues.
type modQueuePayload struct {
	ReportID string `json:"report_id,omitempty"`
	AppealID string `json:"appeal_id,omitempty"`
	State    string `json:"state"`
}

func buildModQueue(publicID, state string) []byte {
	return buildJSON(wsMsg{Type: MsgTypeModQueue, Payload: modQueuePayload{ReportID: publicID, State: state}})
}

func buildAppealModQueue(publicID, state string) []byte {
	return buildJSON(wsMsg{Type: MsgTypeModQueue, Payload: modQueuePayload{AppealID: publicID, State: state}})
}

// moderationAudience returns the connected user IDs whose current Subject satisfies
// permissions.CanModerate, minus exclude: the server-wide mirror of channelReadAudienceImpl.
// CanModerate is not channel-scoped, so each user's role-only Subject (channelID 0) is asked.
func (h *Hub) moderationAudience(ctx context.Context, exclude ...int64) []int64 {
	mods := h.moderators(ctx)
	audience := mods[:0]
	for _, uid := range mods {
		excluded := false
		for _, ex := range exclude {
			if ex != 0 && uid == ex {
				excluded = true
				break
			}
		}
		if !excluded {
			audience = append(audience, uid)
		}
	}
	return audience
}

// moderators is every connected CanModerate holder, memoised like a channel audience
// (audience_memo.go) under the zero ChannelRef. The returned slice is the caller's own.
func (h *Hub) moderators(ctx context.Context) []int64 {
	var key struct{}
	now := time.Now()
	permGen, connGen, memo := h.memoGens()
	if memo {
		if mods, ok := loadFresh(&h.audience.mods, key, permissions.ChannelRef{}, permGen, connGen, now); ok {
			return mods
		}
	}
	userIDs, snapGen := h.connectedSnapshot()
	mods := make([]int64, 0, len(userIDs))
	failed := false
	for _, uid := range userIDs {
		sub, err := h.subjectFor(ctx, uid, 0)
		if err != nil {
			failed = true
			continue
		}
		if permissions.CanModerate(sub) == nil {
			mods = append(mods, uid)
		}
	}
	if memo && !failed {
		h.storeIfUnchanged(&h.audience.mods, key, permissions.ChannelRef{}, permGen, snapGen, now, mods)
	}
	return mods
}

// BroadcastModQueue notifies every connected moderation-bit holder that report reportID
// (the INTERNAL id, resolved to a public id before the wire) changed, on create, assign and
// close. A bit-holding SUBJECT or REPORTER must never receive it though they satisfy
// CanModerate: confidential filing keeps the subject and reporter identity unknown to them.
// Both principals are looked up here so File/Assign/Close signatures stay untouched. Fails
// closed: if the report cannot be read, nothing is sent.
func (h *Hub) BroadcastModQueue(ctx context.Context, reportID int64, state string) {
	if h.db == nil {
		return
	}
	report, err := h.readers.Dispatch.GetReport(ctx, reportID)
	if err != nil || report == nil {
		return
	}
	msg := buildModQueue(report.PublicID, state)
	for _, uid := range h.moderationAudience(ctx, report.ReporterID, report.SubjectID) {
		h.SendToUserLow(uid, msg)
	}
}

// BroadcastAppealQueue notifies every connected moderation-bit holder that appeal appealID
// (INTERNAL id, resolved to a public id before the wire) changed, on submit, assign and
// decide. The APPELLANT is excluded: a moderator-appellant must not learn of their own
// appeal's queue movement through the surface for reviewing others' (the rule Queue/Get
// apply to the read side). The acting moderator is NOT excluded: they may already see their
// own action's appeal move like any other bit holder.
func (h *Hub) BroadcastAppealQueue(ctx context.Context, appealID int64, state string) {
	if h.db == nil {
		return
	}
	appeal, err := h.readers.Dispatch.GetAppeal(ctx, appealID)
	if err != nil || appeal == nil {
		return
	}
	msg := buildAppealModQueue(appeal.PublicID, state)
	for _, uid := range h.moderationAudience(ctx, appeal.AppellantID) {
		h.SendToUserLow(uid, msg)
	}
}
