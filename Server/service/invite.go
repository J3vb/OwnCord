package service

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// InviteService handles invite management.
type InviteService struct {
	st Store
}

// NewInviteService creates an InviteService.
func NewInviteService(st Store) *InviteService {
	return &InviteService{st: st}
}

// maxInviteExpiryHoursVal caps invite expiry to 30 days (H-4 hardening).
const maxInviteExpiryHoursVal = 720

// MaxInviteExpiryHours returns the maximum invite expiry in hours.
func MaxInviteExpiryHours() int { return maxInviteExpiryHoursVal }

// CreateInvite creates a new invite code with optional max uses and expiry.
func (s *InviteService) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresInHours int) (*db.Invite, error) {
	ctx, span := telemetry.GlobalTracer("service/invite").Start(ctx, "InviteService.CreateInvite",
		telemetry.Int64("created_by", createdBy),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "CreateInvite"))
		span.End()
	}()

	// Cap expiry.
	if expiresInHours > maxInviteExpiryHoursVal {
		expiresInHours = maxInviteExpiryHoursVal
	}

	var expiresAt *time.Time
	if expiresInHours > 0 {
		t := time.Now().Add(time.Duration(expiresInHours) * time.Hour)
		expiresAt = &t
	}

	code, err := s.st.CreateInvite(ctx, createdBy, maxUses, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create invite: %w", ErrInternal, err)
	}

	// The invite is committed from here on: a request canceled during the
	// read-back must neither fail the creation nor skip its audit row.
	tailCtx := context.WithoutCancel(ctx)
	invite, err := s.st.GetInvite(tailCtx, code)
	if err != nil || invite == nil {
		return nil, fmt.Errorf("%w: failed to retrieve invite: %w", ErrInternal, err)
	}
	// S-02: the row names the invite by id, never by code; the code is the
	// credential.
	db.WriteAudit(tailCtx, s.st, createdBy, "invite_create", "invite", invite.ID,
		fmt.Sprintf("max_uses=%d expires_in_hours=%d", maxUses, expiresInHours))
	return invite, nil
}

// ListInvites returns all invites.
func (s *InviteService) ListInvites(ctx context.Context) ([]*db.Invite, error) {
	invites, err := s.st.ListInvites(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list invites: %w", ErrInternal, err)
	}
	return invites, nil
}

// RevokeInvite revokes an invite by code on behalf of actorID.
func (s *InviteService) RevokeInvite(ctx context.Context, actorID int64, code string) error {
	invite, err := s.st.GetInvite(ctx, code)
	if err != nil || invite == nil {
		return fmt.Errorf("%w: invite not found", ErrNotFound)
	}
	if err := s.st.RevokeInvite(ctx, code); err != nil {
		return fmt.Errorf("%w: failed to revoke invite: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "invite_revoke", "invite", invite.ID, "")
	return nil
}
