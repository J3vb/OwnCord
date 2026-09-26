package service

import (
	"context"
	"fmt"
	"time"
)

// sqliteDateTimeLayout matches SQLite's datetime('now') text format, so a
// Go-formatted cutoff string compares correctly against the stored column
// (lexical order on this layout is chronological order).
const sqliteDateTimeLayout = "2006-01-02 15:04:05"

// PruneClosedContent is the retention sweep (moderation.report_retention_days,
// scorecard decision 2): for every report closed more than olderThan ago,
// delete its evidence and notes and clear its detail. The reports row
// itself is kept — content is bounded, the outcome is indefinite (S5-d).
// Open reports (closed_at IS NULL) are never touched by this window.
func (s *ReportService) PruneClosedContent(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan).UTC().Format(sqliteDateTimeLayout)
	if _, err := s.st.PruneReportContentOlderThan(ctx, cutoff); err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return nil
}
