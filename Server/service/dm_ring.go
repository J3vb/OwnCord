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

// OpenForRing reopens the DM for every ring target who had closed it and
// returns each reopen with its dm_channel_open payload, so the caller can
// announce it ahead of the call_incoming. Without it a callee who closed the
// DM accepts a call into a channel their client does not have (D-04).
// OpenDM is idempotent and reports a genuine (re)open, so an already-open DM
// returns nothing — see the OC-0106 note in SendMessage.
//
// The payload is built before the row is written: a reopen that could not be
// announced would be persisted, and every later ring would see the DM as open
// and never announce it. A failure on either step skips that target (logged);
// the ring itself must still go out.
func (s *DMService) OpenForRing(ctx context.Context, channelID int64, targets []int64) []RingReopen {
	var reopened []RingReopen
	for _, pid := range targets {
		summary, err := s.DMSummaryFor(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing summary", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		ok, err := s.st.OpenDM(ctx, pid, channelID)
		if err != nil {
			slog.Warn("DMService.OpenForRing OpenDM", "err", err, "recipient_id", pid, "channel_id", channelID)
			continue
		}
		if ok {
			reopened = append(reopened, RingReopen{UserID: pid, Summary: summary})
		}
	}
	return reopened
}
