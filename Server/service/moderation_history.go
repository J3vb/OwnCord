package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// moderationHistoryStore is what the moderation action history reads and writes.
// *db.DB satisfies it.
type moderationHistoryStore interface {
	AcknowledgeWarning(ctx context.Context, userID, actionID int64) (bool, error)
	ListModerationActionsForTarget(ctx context.Context, targetID int64) ([]db.ModerationAction, error)
	ListOwnModerationActions(ctx context.Context, userID, limit int64) ([]db.OwnModerationAction, error)
	ListModerationActionsForReport(ctx context.Context, reportID int64) ([]db.ModerationAction, error)
}

// moderationHistory is the ledger reads and the warning acknowledgement of
// ModerationService, embedded in it.
type moderationHistory struct {
	st moderationHistoryStore
}

// ListActionsForReport lists a report's "actions taken". It checks no permission:
// ReportService.Get already gated the read.
func (s *moderationHistory) ListActionsForReport(ctx context.Context, reportID int64) ([]db.ModerationAction, error) {
	rows, err := s.st.ListModerationActionsForReport(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// OwnModerationAction is one row of GET /api/v1/users/me/moderation. Appealable
// means an appealable kind with no appeal filed yet.
type OwnModerationAction struct {
	db.OwnModerationAction
	Appealable bool
}

// ownModerationListLimit caps ListOwnActions: removal and ban rows never retire.
const ownModerationListLimit = 200

// ListOwnActions reads userID's own ledger rows from storage with no permission
// bit: the query is scoped to target_id = userID and selects nothing a member may
// not see.
func (s *moderationHistory) ListOwnActions(ctx context.Context, userID int64) ([]OwnModerationAction, error) {
	rows, err := s.st.ListOwnModerationActions(ctx, userID, ownModerationListLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]OwnModerationAction, 0, len(rows))
	for _, r := range rows {
		out = append(out, OwnModerationAction{OwnModerationAction: r, Appealable: appealableKinds[r.Kind] && r.AppealID == nil})
	}
	return out, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID (own rows only).
// ErrNotFound covers a foreign, already-acknowledged or non-warning id alike, so
// the route cannot probe another user's ids.
func (s *moderationHistory) AcknowledgeWarning(ctx context.Context, userID, actionID int64) error {
	if actionID <= 0 {
		return fmt.Errorf("%w: id must be positive", ErrBadRequest)
	}
	ok, err := s.st.AcknowledgeWarning(ctx, userID, actionID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: notice not found", ErrNotFound)
	}
	return nil
}

// ListActionsForTarget backs GET /api/v1/moderation/users/{id}/actions, gated on
// MODERATE_MEMBERS like the report queue.
func (s *ModerationService) ListActionsForTarget(ctx context.Context, actorID, targetID int64) ([]db.ModerationAction, error) {
	if _, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers); err != nil {
		return nil, err
	}
	rows, err := s.moderationHistory.st.ListModerationActionsForTarget(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}
