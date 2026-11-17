package service

import (
	"context"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

type inviteStore interface {
	db.Auditor
	CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresAt *time.Time) (string, error)
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
	GetInviteByID(ctx context.Context, id int64) (*db.Invite, error)
	ListInvites(ctx context.Context, dead bool, beforeID int64, limit int) ([]*db.Invite, error)
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

const maxInviteExpiryHoursVal = 720

// MaxInviteExpiryHours returns the maximum invite expiry in hours.
func MaxInviteExpiryHours() int { return maxInviteExpiryHoursVal }

// CreateInvite creates a new invite code with optional max uses and expiry.
func (s *InviteService) CreateInvite(ctx context.Context, createdBy int64, maxUses int, expiresInHours int) (*db.Invite, error) {
	ctx, done := traceCall(ctx, "service/invite", "InviteService.CreateInvite",
		telemetry.Int64("created_by", createdBy),
	)
	defer done()

	if expiresInHours > maxInviteExpiryHoursVal {
		expiresInHours = maxInviteExpiryHoursVal
	}
	// A negative count or expiry silently meant "unlimited"/"never expires"; reject it.
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

	// Committed from here on: a request canceled during the read-back must neither fail the creation nor skip
	// its audit row.
	tailCtx := context.WithoutCancel(ctx)
	invite, err := s.st.GetInvite(tailCtx, code)
	if err != nil || invite == nil {
		return nil, fmt.Errorf("%w: failed to retrieve invite: %w", ErrInternal, err)
	}
	// The row names the invite by id, never by code; the code is the credential.
	db.WriteAudit(tailCtx, s.st, createdBy, "invite_create", "invite", invite.ID,
		fmt.Sprintf("max_uses=%d expires_in_hours=%d", maxUses, expiresInHours))
	return invite, nil
}

// Invite list bounds: every live invite is returned (up to the cap) and never pushed out by dead ones,
// which are paged.
const (
	InviteLiveListCap     = 500
	InviteDeadPageDefault = 50
	InviteDeadPageMax     = 200
)

// Invite list selectors for ListInvites.
const (
	InviteStateAll  = ""
	InviteStateLive = "live"
	InviteStateDead = "dead"
)

// ListInvites returns live invites first (newest id first), then dead ones. state selects both
// (InviteStateAll, the first page of each), only live or only dead; beforeID continues a single list past
// the last id of its previous page and is ignored for InviteStateAll. deadLimit bounds the dead rows and is
// clamped to [1, InviteDeadPageMax]; zero means InviteDeadPageDefault.
func (s *InviteService) ListInvites(ctx context.Context, state string, beforeID int64, deadLimit int) ([]*db.Invite, error) {
	if state != InviteStateAll && state != InviteStateLive && state != InviteStateDead {
		return nil, fmt.Errorf("%w: state must be live or dead", ErrBadRequest)
	}
	if beforeID < 0 || deadLimit < 0 {
		return nil, fmt.Errorf("%w: before and limit must not be negative", ErrBadRequest)
	}
	if deadLimit == 0 {
		deadLimit = InviteDeadPageDefault
	}
	deadLimit = min(deadLimit, InviteDeadPageMax)
	if state == InviteStateAll {
		beforeID = 0
	}

	out := make([]*db.Invite, 0)
	if state != InviteStateDead {
		live, err := s.st.ListInvites(ctx, false, beforeID, InviteLiveListCap)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to list invites: %w", ErrInternal, err)
		}
		out = append(out, live...)
	}
	if state != InviteStateLive {
		dead, err := s.st.ListInvites(ctx, true, beforeID, deadLimit)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to list invites: %w", ErrInternal, err)
		}
		out = append(out, dead...)
	}
	return out, nil
}

// ListInviteRedemptions returns who redeemed an invite, newest first, so an owner can
// trace a leaked invite. The invite is resolved by code first; an unknown code is ErrNotFound.
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

// RevokeInviteByID revokes an invite by its id on behalf of actorID. Revoking an already revoked invite
// succeeds again.
func (s *InviteService) RevokeInviteByID(ctx context.Context, actorID int64, id int64) error {
	invite, err := s.st.GetInviteByID(ctx, id)
	if err != nil {
		return fmt.Errorf("%w: failed to load invite: %w", ErrInternal, err)
	}
	if invite == nil {
		return fmt.Errorf("%w: invite not found", ErrNotFound)
	}
	return s.RevokeInvite(ctx, actorID, invite.Code)
}
