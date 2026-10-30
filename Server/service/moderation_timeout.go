package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// minTimeoutDuration and maxTimeoutDuration bound Timeout's duration:
// 1 minute to 28 days.
const (
	minTimeoutDuration = time.Minute
	maxTimeoutDuration = 28 * 24 * time.Hour
)

// TimeoutDurationFromSeconds bounds a raw client `duration_seconds` before
// converting to a Duration. Multiplying by time.Second first and range-checking
// the product wraps modulo 2^64 (36028797018967568 = 3600 + 2^55 collapses to
// exactly one hour), passing the 1-minute..28-day gate as a request the caller
// never made. Checking the seconds first refuses it, and one helper serves both
// entry points (the timeout route and ActOnReport) so the check cannot drift.
func TimeoutDurationFromSeconds(seconds int64) (time.Duration, error) {
	if seconds < int64(minTimeoutDuration/time.Second) || seconds > int64(maxTimeoutDuration/time.Second) {
		return 0, fmt.Errorf("%w: duration must be between 1 minute and 28 days", ErrBadRequest)
	}
	return time.Duration(seconds) * time.Second, nil
}

// refreshTimeoutMirror reloads PermissionService's active-timeout mirror after a
// committed timeout write, before the write returns, so the next send sees it.
// Detached: the write already committed. A failed reload drops the mirror, which
// Subject treats as fail-closed, so the error is only logged.
func (s *ModerationService) refreshTimeoutMirror(ctx context.Context) {
	if s.perms == nil {
		return
	}
	if err := s.perms.RefreshTimeouts(context.WithoutCancel(ctx)); err != nil {
		slog.Error("ModerationService: RefreshTimeouts", "err", err)
	}
}

// releaseSupersededMute lifts the voice mute of superseded timeouts when the
// replacing actor cannot moderate voice: only MuteForTimeout transfers a mute,
// and no FinalizeTimeoutLift is needed because the new timeout is active.
func (s *ModerationService) releaseSupersededMute(ctx context.Context, targetID int64, supersededIDs []int64) {
	if s.voiceMuter != nil && len(supersededIDs) > 0 {
		s.voiceMuter.UnmuteForTimeout(context.WithoutCancel(ctx), targetID, supersededIDs)
	}
}
