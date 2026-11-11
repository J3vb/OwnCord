package service

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/dbtime"
)

// PruneClosedContent is the retention sweep (moderation.report_retention_days): for every report closed more
// than olderThan ago, delete its evidence and notes and clear its detail. The reports row is kept: content is
// bounded, the outcome is indefinite. Open reports are never touched.
func (s *ReportService) PruneClosedContent(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan).UTC().Format(dbtime.SQLiteLayout)
	if _, err := s.st.PruneReportContentOlderThan(ctx, cutoff); err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return nil
}
