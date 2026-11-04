package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// registrationQueueStore is what the approval-mode queue reads and writes.
type registrationQueueStore interface {
	db.Auditor
	ListPendingUsers(ctx context.Context, limit, offset int) ([]db.PendingUser, error)
	ApprovePendingUser(ctx context.Context, userID int64) error
	DenyPendingUser(ctx context.Context, userID int64) error
}

// registrationQueue is UserService's part for approval-mode applications.
type registrationQueue struct {
	st registrationQueueStore
	// welcome greets an approved applicant; nil greets nobody.
	welcome *WelcomeService
}

// ListPendingRegistrations is the approval queue, oldest first.
func (s *registrationQueue) ListPendingRegistrations(ctx context.Context, limit, offset int) ([]db.PendingUser, error) {
	pending, err := s.st.ListPendingUsers(ctx, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list pending registrations: %w", ErrInternal, err)
	}
	return pending, nil
}

// ApproveRegistration unlocks an approval-mode application so the account can
// sign in. ErrNotFound when the id is not pending.
func (s *registrationQueue) ApproveRegistration(ctx context.Context, actorID, userID int64) error {
	if err := s.st.ApprovePendingUser(ctx, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: no pending registration with that id", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to approve registration: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "registration_approve", "user", userID, "application approved")
	slog.Info("registration approved", "actor_id", actorID, "user_id", userID)
	// The account is usable now: greet it, best effort.
	s.welcome.Greet(ctx, userID)
	return nil
}

// DenyRegistration refuses an application: the row is anonymised, locked for
// good and its username released. Only a pending row is touched.
func (s *registrationQueue) DenyRegistration(ctx context.Context, actorID, userID int64) error {
	if err := s.st.DenyPendingUser(ctx, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: no pending registration with that id", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to deny registration: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "registration_deny", "user", userID, "application denied")
	slog.Info("registration denied", "actor_id", actorID, "user_id", userID)
	return nil
}
