package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
)

// checkProfileByteBounds is UpdateProfile's raw byte guard (see the
// comment at its call site), split out to keep UpdateProfile within funlen.
func checkProfileByteBounds(patch ProfilePatch) error {
	if patch.DisplayName != nil && len(*patch.DisplayName) > MaxDisplayNameLen*4 {
		return fmt.Errorf("%w: display_name must be at most %d characters", ErrBadRequest, MaxDisplayNameLen)
	}
	if patch.About != nil && len(*patch.About) > MaxAboutLen*4 {
		return fmt.Errorf("%w: about must be at most %d characters", ErrBadRequest, MaxAboutLen)
	}
	return nil
}

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

// checkTimedOutProfileEdit applies the self-edit rules for the shown name.
// next is the cleaned display name patch, nil when the patch leaves
// the field alone; username is the patch's username, "" when unspecified.
// Resending the current values is always allowed. A real change to either is
// refused while a moderator timeout is active (read once, fail closed), so a
// moderator's nickname reset cannot be undone by the member mid-timeout: with
// the nickname cleared the username is what everyone sees. A display name
// change is also refused when it equals another account's username.
func (s *UserService) checkTimedOutProfileEdit(ctx context.Context, userID int64, current *db.User, next *string, username string) error {
	nameChanged := next != nil && displayNameChanged(current.DisplayName, *next)
	usernameChanged := username != "" && username != current.Username
	if !nameChanged && !usernameChanged {
		return nil
	}
	timedOut, err := s.st.HasActiveTimeout(ctx, userID)
	if err != nil {
		return fmt.Errorf("%w: failed to check timeout: %w", ErrInternal, err)
	}
	if timedOut {
		return fmt.Errorf("%w: you cannot change your name while timed out", ErrTimedOut)
	}
	if !nameChanged {
		return nil
	}
	return s.checkDisplayNameCollision(ctx, userID, *next)
}

// checkDisplayNameCollision refuses a non-empty display name that equals,
// ignoring case, another account's username (the same NOCASE rule username
// uniqueness uses, so only ASCII letters fold). The account's own username
// stays allowed. The caller has already established that the value changes.
// Best effort, like username uniqueness before its constraint: a username
// taken between this read and the write is not caught.
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
