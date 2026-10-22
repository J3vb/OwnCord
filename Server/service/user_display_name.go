package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// displayNameChanged reports whether setting a display name to next changes
// what the row holds, treating nil and "" as the same "unset".
func displayNameChanged(current *string, next string) bool {
	return derefString(current) != next
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// checkDisplayNameEdit applies the self-edit rules for a display name patch
// (WP 6.4b). next is the cleaned patch value, nil when the patch leaves the
// field alone. Resending the current value is always allowed. A real change is
// refused while a moderator timeout is active (read once, fail closed), so a
// moderator's nickname reset cannot be undone by the member mid-timeout, and
// when it equals another account's username.
func (s *UserService) checkDisplayNameEdit(ctx context.Context, userID int64, current *db.User, next *string) error {
	if next == nil || !displayNameChanged(current.DisplayName, *next) {
		return nil
	}
	timedOut, err := s.st.HasActiveTimeout(ctx, userID)
	if err != nil {
		return fmt.Errorf("%w: failed to check timeout: %w", ErrInternal, err)
	}
	if timedOut {
		return fmt.Errorf("%w: you cannot change your display name while timed out", ErrTimedOut)
	}
	return s.checkDisplayNameCollision(ctx, userID, *next)
}

// checkDisplayNameCollision refuses a non-empty display name that equals,
// ignoring case, another account's username (the same NOCASE rule username
// uniqueness uses). The account's own username stays allowed. The caller has
// already established that the value changes.
func (s *UserService) checkDisplayNameCollision(ctx context.Context, userID int64, cleaned string) error {
	if cleaned == "" {
		return nil
	}
	other, err := s.st.GetUserByUsername(ctx, cleaned)
	if err != nil {
		return fmt.Errorf("%w: failed to check display name: %w", ErrInternal, err)
	}
	if other != nil && other.ID != userID {
		return fmt.Errorf("%w: display_name matches another member's username", ErrBadRequest)
	}
	return nil
}

// displayNameAuditSuffix is the profile_update audit detail fragment for a
// display name change, empty when the value is unchanged.
func displayNameAuditSuffix(old, next *string) string {
	if !displayNameChanged(old, derefString(next)) {
		return ""
	}
	return fmt.Sprintf(" display_name %s -> %s", quoteNickname(old), quoteNickname(next))
}
