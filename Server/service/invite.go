package service

import (
	"fmt"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/store"
)

// InviteService handles invite management.
type InviteService struct {
	st store.Store
}

// NewInviteService creates an InviteService.
func NewInviteService(st store.Store) *InviteService {
	return &InviteService{st: st}
}

// maxInviteExpiryHoursVal caps invite expiry to 30 days (H-4 hardening).
const maxInviteExpiryHoursVal = 720

// MaxInviteExpiryHours returns the maximum invite expiry in hours.
func MaxInviteExpiryHours() int { return maxInviteExpiryHoursVal }

// CreateInvite creates a new invite code with optional max uses and expiry.
func (s *InviteService) CreateInvite(createdBy int64, maxUses int, expiresInHours int) (*db.Invite, error) {
	// Cap expiry.
	if expiresInHours > maxInviteExpiryHoursVal {
		expiresInHours = maxInviteExpiryHoursVal
	}

	var expiresAt *time.Time
	if expiresInHours > 0 {
		t := time.Now().Add(time.Duration(expiresInHours) * time.Hour)
		expiresAt = &t
	}

	code, err := s.st.CreateInvite(createdBy, maxUses, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create invite", ErrInternal)
	}

	invite, err := s.st.GetInvite(code)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch invite", ErrInternal)
	}
	return invite, nil
}

// ListInvites returns all invites.
func (s *InviteService) ListInvites() ([]*db.Invite, error) {
	invites, err := s.st.ListInvites()
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list invites", ErrInternal)
	}
	return invites, nil
}

// RevokeInvite revokes an invite by code.
func (s *InviteService) RevokeInvite(code string) error {
	invite, err := s.st.GetInvite(code)
	if err != nil || invite == nil {
		return fmt.Errorf("%w: invite not found", ErrNotFound)
	}
	if err := s.st.RevokeInvite(code); err != nil {
		return fmt.Errorf("%w: failed to revoke invite", ErrInternal)
	}
	return nil
}
