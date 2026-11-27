package service

import (
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// Per-moderator budgets for warnings and timeouts, the same order as the nickname
// limit (nicknameRateLimit). Each action has its own key; the report queue's act
// path goes through the same methods, so it shares them.
const (
	modActionRateLimit  = 10
	modActionRateWindow = time.Minute
)

// reserveModAction spends one of actorID's calls of kind. The returned refund gives the
// slot back when the action is then not applied; it is a no-op when the limiter is nil.
func (s *ModerationService) reserveModAction(kind string, actorID int64) (refund func(), err error) {
	if s.limiter == nil {
		return func() {}, nil
	}
	refund, ok := s.limiter.Reserve(auth.Key(kind, actorID), modActionRateLimit, modActionRateWindow)
	if !ok {
		return nil, fmt.Errorf("%w: too many moderation actions, please slow down", ErrRateLimited)
	}
	return refund, nil
}
