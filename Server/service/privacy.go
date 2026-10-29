package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

var _ PrivacyStore = (*db.DB)(nil)

var _ DMPrivacyReader = (*db.DB)(nil)

var _ groupReachabilityReader = (*db.DB)(nil)

// PrivacyStore is the data access the privacy service needs. *db.DB satisfies
// it; it is deliberately not part of Store.
type PrivacyStore interface {
	GetUserPrivacy(ctx context.Context, userID int64) (db.UserPrivacy, error)
	SetUserPrivacy(ctx context.Context, userID int64, p db.UserPrivacy) error
	UntrustedDMCallers(ctx context.Context, userID int64) ([]db.DMCaller, error)
}

// DMCaller is a user in the voice call of a 1:1 DM.
type DMCaller = db.DMCaller

// Privacy is a user's direct message privacy choices as the API sees them.
type Privacy struct {
	AllowMemberDMs  bool
	MessageRequests bool
}

// PrivacyService keeps each user's direct message privacy choices (migration
// 070). Every call is keyed by the session user.
type PrivacyService struct {
	st PrivacyStore
}

// NewPrivacyService creates a PrivacyService.
func NewPrivacyService(st PrivacyStore) *PrivacyService {
	return &PrivacyService{st: st}
}

// Get returns the user's settings, both on when none were saved.
func (s *PrivacyService) Get(ctx context.Context, userID int64) (Privacy, error) {
	p, err := s.st.GetUserPrivacy(ctx, userID)
	if err != nil {
		return Privacy{}, fmt.Errorf("get privacy: %w", err)
	}
	return Privacy(p), nil
}

// Set replaces the user's settings as a whole and returns what was stored. The
// write is one statement, so concurrent writers need no lock and the last
// write wins.
func (s *PrivacyService) Set(ctx context.Context, userID int64, p Privacy) (Privacy, error) {
	if err := s.st.SetUserPrivacy(ctx, userID, db.UserPrivacy(p)); err != nil {
		return Privacy{}, fmt.Errorf("set privacy: %w", err)
	}
	return p, nil
}

// UntrustedCallers returns the people in a 1:1 DM voice call with userID whom
// userID does not trust while their direct messages from members are off. The
// caller removes them from those calls once Set has stored the setting.
func (s *PrivacyService) UntrustedCallers(ctx context.Context, userID int64) ([]DMCaller, error) {
	callers, err := s.st.UntrustedDMCallers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("untrusted callers: %w", err)
	}
	return callers, nil
}
