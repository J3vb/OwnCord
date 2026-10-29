package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const (
	// nicknameRateLimit and nicknameRateWindow cap how many nicknames one
	// actor may change. The budget is spent only after authorization, so a
	// caller without authority cannot burn it.
	nicknameRateLimit  = 10
	nicknameRateWindow = time.Minute
)

// SetNickname sets (or, with a nil or empty name, clears) another member's
// nickname, users.display_name. Order: a human actor, a positive
// target that is not the actor, the name through the same pipeline as the
// member's own edit (cleanVisibleBounded), MANAGE_NICKNAMES (Administrator
// bypasses the bit, never the hierarchy), the target exists and is not a
// pending account, the actor strictly outranks it, the name is not another
// account's username, the per-actor limiter, and then the write,
// which re-checks bit and rank inside its transaction.
// Authorization comes before existence so a caller without the bit sees
// Forbidden for an unknown id, never NotFound.
//
// The returned user is the committed row, for the transport to broadcast.
func (s *ModerationService) SetNickname(ctx context.Context, actorID, targetID int64, name *string) (*db.User, error) {
	if err := requireHumanActor(actorID); err != nil {
		return nil, err
	}
	if targetID <= 0 {
		return nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, fmt.Errorf("%w: change your own nickname from your profile", ErrBadRequest)
	}
	cleaned := ""
	if name != nil {
		var err error
		cleaned, err = cleanVisibleBounded(*name, MaxDisplayNameLen, "display_name")
		if err != nil {
			return nil, err
		}
	}

	actorRole, err := s.requirePerm(ctx, actorID, permissions.ManageNicknames)
	if err != nil {
		return nil, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.PendingApproval() {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, err
	}
	if err := s.checkNicknameCollision(ctx, target, cleaned); err != nil {
		return nil, err
	}
	if s.limiter != nil && !s.limiter.Allow(auth.Key("nickname_change", actorID), nicknameRateLimit, nicknameRateWindow) {
		return nil, ErrRateLimited
	}
	if s.users == nil {
		return nil, fmt.Errorf("%w: nickname change unavailable", ErrInternal)
	}

	user, err := s.users.setDisplayNameAsModerator(ctx, actorID, targetID, nullable(cleaned))
	if err != nil {
		switch {
		case errors.Is(err, db.ErrOutranked):
			// The concurrent-change case: the actor lost the bit or the target
			// was promoted since the check above. Refused, not applied.
			return nil, fmt.Errorf("%w: cannot change the nickname of this member", ErrForbidden)
		case errors.Is(err, db.ErrNotFound):
			return nil, fmt.Errorf("%w: user not found", ErrNotFound)
		default:
			return nil, fmt.Errorf("%w: failed to change nickname: %w", ErrInternal, err)
		}
	}
	return user, nil
}

// checkNicknameCollision applies the self edit's username collision rule to a
// moderator's change; an unchanged name is not re-checked.
func (s *ModerationService) checkNicknameCollision(ctx context.Context, target *db.User, cleaned string) error {
	if s.users == nil || !displayNameChanged(target.DisplayName, cleaned) {
		return nil
	}
	return s.users.checkDisplayNameCollision(ctx, target.ID, cleaned)
}
