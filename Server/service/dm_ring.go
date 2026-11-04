package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// RingReopen is one DM reopened for a ring target, with the payload the
// dm_channel_open announcing it carries.
type RingReopen struct {
	UserID  int64
	Summary db.DMChannelInfo
}

// OpenForRing reopens the DM for every ring target who had closed it and returns
// each reopen with its dm_channel_open payload, for the caller to announce ahead of
// call_incoming: otherwise a callee who closed the DM accepts a call into a channel
// their client does not have. OpenDM is idempotent and reports a genuine (re)open,
// so an already-open DM returns nothing (see SendMessage).
// The payload is built before the row is written: a reopen that could not be
// announced would persist, and every later ring would see the DM open and never
// announce it. A failure on either step skips that target (logged); the ring must
// still go out.
func (s *DMService) OpenForRing(ctx context.Context, channelID int64, targets []int64) []RingReopen {
	var reopened []RingReopen
	for _, pid := range targets {
		summary, err := s.DMSummaryFor(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing summary", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		ok, err := s.st.OpenDMIfParticipant(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing OpenDM", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		if ok {
			reopened = append(reopened, RingReopen{UserID: pid, Summary: summary})
		}
	}
	s.withHistory(ctx, channelID, reopened)
	return reopened
}

// withHistory fills in what DMSummaryFor leaves at zero (last message, unread and
// mention counts) for every reopen, from one read for the channel. A ring sends no
// chat frame to repair a bare row, so the reopen carries it. On a failed read the
// bare summaries still announce the DM.
func (s *DMService) withHistory(ctx context.Context, channelID int64, reopened []RingReopen) {
	if len(reopened) == 0 {
		return
	}
	ids := make([]int64, len(reopened))
	for i := range reopened {
		ids[i] = reopened[i].UserID
	}
	history, err := s.st.GetDMHistoryForParticipants(ctx, channelID, ids)
	if err != nil {
		slog.Warn("DMService.OpenForRing history", "err", err, "channel_id", channelID)
		return
	}
	for i := range reopened {
		h, ok := history[reopened[i].UserID]
		if !ok {
			continue
		}
		sum := &reopened[i].Summary
		sum.LastMessageID = h.LastMessageID
		sum.LastMessage = h.LastMessage
		sum.LastMessageAt = h.LastMessageAt
		sum.UnreadCount = h.UnreadCount
		sum.MentionCount = h.MentionCount
	}
}
