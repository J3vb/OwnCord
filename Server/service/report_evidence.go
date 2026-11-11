package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// Why Get withheld a report's evidence snapshot.
const (
	EvidenceNSFWAcknowledgementRequired = "NSFW_ACKNOWLEDGEMENT_REQUIRED"
	EvidenceSourceChannelUnavailable    = "SOURCE_CHANNEL_UNAVAILABLE"
)

// evidenceWithheld applies the NSFW consent rule to the evidence snapshot, a second content path into its
// source channel: a moderator reads labelled evidence only with their own acknowledgement of that channel,
// with no bit or administrator bypass. Label and acknowledgement are read live, so a revoke or relabel takes
// effect on the next read. A source channel that no longer exists has no label to read and no acknowledgement
// left (047 cascades): its snapshot stays readable only when migration 052's sticky flag says it was never
// labelled, and is withheld when it was or when that is unknown, or when the label or acknowledgement cannot
// be read. A report with no source channel (a user target) has nothing to gate.
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
