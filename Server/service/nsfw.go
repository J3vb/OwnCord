package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ErrNotNSFW is returned when acknowledging a channel that is not labelled; the api layer maps it to its own
// 409 NOT_NSFW.
var ErrNotNSFW = errors.New("channel is not labelled nsfw")

// nsfwStore is what NSFWService reads and writes.
type nsfwStore interface {
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	AcknowledgeNSFW(ctx context.Context, userID, channelID int64) (bool, error)
	RevokeNSFW(ctx context.Context, userID, channelID int64) error
}

// NSFWService owns the per-user, per-channel acknowledgement row (migration 047). See
// docs/architecture/community-services.md section S4; permissions.CanReadContent is the predicate every
// content path resolves it into.
type NSFWService struct {
	st    nsfwStore
	perms *PermissionService
}

// NewNSFWService creates an NSFWService.
func NewNSFWService(st nsfwStore, perms *PermissionService) *NSFWService {
	return &NSFWService{st: st, perms: perms}
}

// checkVisible asserts the caller may see channelID (permissions.CanViewChannel): acknowledge and revoke ask
// no more than other visibility-gated surfaces. An invisible channel is ErrNotFound.
func (s *NSFWService) checkVisible(ctx context.Context, userID, channelID int64) error {
	ch, err := s.st.GetChannel(ctx, channelID)
	if err != nil || ch == nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		// A thread's label and consent are its parent's; acknowledgement rows are keyed by the parent only.
		return fmt.Errorf("acknowledge the thread's parent channel%.0w", ErrBadRequest)
	}
	sub, err := channelSubject(ctx, s.st, s.perms, userID, ch, false)
	if err != nil {
		return fmt.Errorf("check channel visibility: %w", err)
	}
	if permissions.CanViewChannel(sub) != nil {
		return fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	return nil
}

// nsfwAcknowledgeRaceHook runs in Acknowledge between checkVisible and the atomic insert.
// Test-only: lets a test unlabel the channel in that window.
var nsfwAcknowledgeRaceHook func()

// Acknowledge records userID's consent to channelID's labelled content. Idempotent. ErrNotFound on an
// invisible channel, ErrNotNSFW on an unlabelled one. The label check and insert are ONE writer transaction
// (db.AcknowledgeNSFW), so a relabel cannot make this trust stale consent and "already acknowledged" cannot
// be confused with "not labelled".
func (s *NSFWService) Acknowledge(ctx context.Context, userID, channelID int64) error {
	if err := s.checkVisible(ctx, userID, channelID); err != nil {
		return err
	}
	if nsfwAcknowledgeRaceHook != nil {
		nsfwAcknowledgeRaceHook()
	}
	labelled, err := s.st.AcknowledgeNSFW(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("%w: failed to record acknowledgement: %w", ErrInternal, err)
	}
	if !labelled {
		return ErrNotNSFW
	}
	return nil
}

// Revoke deletes userID's acknowledgement, effective on the next read. Idempotent: revoking a missing row
// succeeds silently. Still requires visibility (ErrNotFound).
func (s *NSFWService) Revoke(ctx context.Context, userID, channelID int64) error {
	if err := s.checkVisible(ctx, userID, channelID); err != nil {
		return err
	}
	if err := s.st.RevokeNSFW(ctx, userID, channelID); err != nil {
		return fmt.Errorf("%w: failed to remove acknowledgement: %w", ErrInternal, err)
	}
	return nil
}
