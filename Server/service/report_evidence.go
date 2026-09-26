package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Why Get withheld a report's evidence snapshot (B5-7/B5-8 follow-up).
const (
	EvidenceNSFWAcknowledgementRequired = "NSFW_ACKNOWLEDGEMENT_REQUIRED"
	EvidenceSourceChannelUnavailable    = "SOURCE_CHANNEL_UNAVAILABLE"
)

// evidenceWithheld applies decision 13 to the evidence snapshot, a second
// content path into its source channel: a moderator reads labelled evidence
// only with their own acknowledgement of that channel, like anyone else,
// with no bit or administrator bypass. Both the label and the
// acknowledgement are read live, so a revoke, an unlabel-then-relabel (which
// clears every acknowledgement) or a fresh label takes effect on the next
// read. A source channel that no longer exists has no label to read and no
// acknowledgement left to hold (047 cascades): its snapshot stays readable
// only when migration 052's sticky flag says the channel was never
// labelled, and is withheld when it was or when that is unknown. So is one
// whose label or acknowledgement cannot be read. A report with no source
// channel (a user target) has nothing to gate.
func (s *ReportService) evidenceWithheld(ctx context.Context, actorID int64, report *db.Report) string {
	if report.ChannelID == nil {
		return ""
	}
	ch, err := s.st.GetChannel(ctx, *report.ChannelID)
	if err != nil {
		slog.Error("report evidence: failed to read source channel", "report_id", report.ID, "error", err)
		return EvidenceSourceChannelUnavailable
	}
	if ch == nil {
		if report.SourceNSFW != nil && !*report.SourceNSFW {
			return ""
		}
		return EvidenceSourceChannelUnavailable
	}
	if !ch.NSFW {
		return ""
	}
	ok, err := s.st.HasNSFWAcknowledgement(ctx, actorID, ch.ID)
	if err != nil {
		slog.Error("report evidence: failed to check NSFW acknowledgement", "report_id", report.ID, "error", err)
	}
	if err != nil || !ok {
		return EvidenceNSFWAcknowledgementRequired
	}
	return ""
}
