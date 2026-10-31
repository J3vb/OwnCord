package service

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// inviteStore is what InviteService reads and writes. *db.DB satisfies it.
type inviteStore interface {
	db.Auditor
	CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
	ListInvites(ctx context.Context) ([]*db.Invite, error)
	RevokeInvite(ctx context.Context, code string) error
	ListInviteRedemptions(ctx context.Context, inviteID int64, limit int) ([]*db.InviteRedemption, error)
}

// InviteService handles invite management.
type InviteService struct {
	st inviteStore
}

// NewInviteService creates an InviteService.
func NewInviteService(st inviteStore) *InviteService {
	return &InviteService{st: st}
}

// maxInviteExpiryHoursVal caps invite expiry to 30 days.
const maxInviteExpiryHoursVal = 720

// MaxInviteExpiryHours returns the maximum invite expiry in hours.
func MaxInviteExpiryHours() int { return maxInviteExpiryHoursVal }

// CreateInvite creates a new invite code with optional max uses and expiry.
func (s *InviteService) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresInHours int) (*db.Invite, error) {
	ctx, done := traceCall(ctx, "service/invite", "InviteService.CreateInvite",
		telemetry.Int64("created_by", createdBy),
	)
	defer done()

	// Cap expiry.
	if expiresInHours > maxInviteExpiryHoursVal {
		expiresInHours = maxInviteExpiryHoursVal
	}
	// A negative count or expiry silently meant "unlimited"/"never expires"; reject it
	// so the caller cannot create a state they did not ask for.
	if maxUses < 0 || expiresInHours < 0 {
		return nil, fmt.Errorf("%w: max_uses and expires_in_hours must not be negative", ErrBadRequest)
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
	// The row names the invite by id, never by code; the code is the
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

// ListInviteRedemptions returns who redeemed an invite, newest first, so an owner
// can trace a leaked invite to its redeemer. The invite is resolved by code first;
// an unknown code is ErrNotFound rather than an empty history.
func (s *InviteService) ListInviteRedemptions(ctx context.Context, code string) ([]*db.InviteRedemption, error) {
	invite, err := s.st.GetInvite(ctx, code)
	if err != nil || invite == nil {
		return nil, fmt.Errorf("%w: invite not found", ErrNotFound)
	}
	reds, err := s.st.ListInviteRedemptions(ctx, invite.ID, 200)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list invite redemptions: %w", ErrInternal, err)
	}
	return reds, nil
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
