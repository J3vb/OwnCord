package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// minTimeoutDuration and maxTimeoutDuration bound Timeout's duration: 1 minute to 28 days.
const (
	minTimeoutDuration = time.Minute
	maxTimeoutDuration = 28 * 24 * time.Hour
)

// TimeoutDurationFromSeconds bounds a raw client duration_seconds before converting. Multiplying by
// time.Second first wraps modulo 2^64 (36028797018967568 = 3600 + 2^55 becomes exactly one hour) and passes
// the gate as a request the caller never made; checking seconds first refuses it. One helper serves the
// timeout route and ActOnReport.
func TimeoutDurationFromSeconds(seconds int64) (time.Duration, error) {
	if seconds < int64(minTimeoutDuration/time.Second) || seconds > int64(maxTimeoutDuration/time.Second) {
		return 0, fmt.Errorf("%w: duration must be between 1 minute and 28 days", ErrBadRequest)
	}
	return time.Duration(seconds) * time.Second, nil
}

// refreshTimeoutMirror reloads PermissionService's active-timeout mirror after a committed write so the next
// send sees it. Detached: the write committed. A failed reload drops the mirror, which Subject treats as
// fail-closed, so the error is only logged.
func (s *ModerationService) refreshTimeoutMirror(ctx context.Context) {
	if s.perms == nil {
		return
	}
	if err := s.perms.RefreshTimeouts(context.WithoutCancel(ctx)); err != nil {
		slog.Error("ModerationService: RefreshTimeouts", "err", err)
	}
}

// releaseSupersededMute lifts the voice mute of superseded timeouts when the replacing actor cannot moderate
// voice; no FinalizeTimeoutLift is needed since the new timeout is active.
func (s *ModerationService) releaseSupersededMute(ctx context.Context, targetID int64, supersededIDs []int64) {
	if s.voiceMuter != nil && len(supersededIDs) > 0 {
		s.voiceMuter.UnmuteForTimeout(context.WithoutCancel(ctx), targetID, supersededIDs)
	}
}

// TimeoutResult is Timeout's outcome: the ledger row id, and whether the voice half was skipped because the
// actor lacked MUTE_MEMBERS.
type TimeoutResult struct {
	ID           int64
	VoiceSkipped bool
}

// Timeout time-boxes a restriction on targetID: same order as Warn, duration 1 minute..28 days, ledger row
// with expires_at. The voice half applies through voiceMuter ONLY when the actor holds MUTE_MEMBERS;
// otherwise text and reactions are still restricted and VoiceSkipped is true.
func (s *ModerationService) Timeout(ctx context.Context, actorID, targetID int64, reason string, duration time.Duration, reportID *int64) (*TimeoutResult, error) {
	if err := requireHumanActor(actorID); err != nil {
		return nil, err
	}
	if targetID <= 0 {
		return nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, fmt.Errorf("%w: cannot time out yourself", ErrBadRequest)
	}
	if duration < minTimeoutDuration || duration > maxTimeoutDuration {
		return nil, fmt.Errorf("%w: duration must be between 1 minute and 28 days", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return nil, err
	}

	// Authorization before existence, see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers)
	if err != nil {
		return nil, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, err
	}

	expires := time.Now().Add(duration)
	id, supersededIDs, err := s.st.TimeoutUser(ctx, targetID, actorID, reportID, reason, expires)
	if err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return nil, fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return nil, fmt.Errorf("%w: failed to time out user: %w", ErrInternal, err)
	}
	s.refreshTimeoutMirror(ctx)

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_timeout", "user", targetID,
		fmt.Sprintf("timeout issued, expires %s", expires.UTC().Format(time.RFC3339)))

	voiceSkipped := !s.applyTimeoutVoiceHalf(ctx, actorID, targetID, id, supersededIDs)

	s.notifyModAction(targetID, id, "timeout", reason, &expires)

	slog.Info("user timed out", "actor_id", actorID, "target_id", targetID, "expires_at", expires, "voice_skipped", voiceSkipped)
	return &TimeoutResult{ID: id, VoiceSkipped: voiceSkipped}, nil
}

// applyTimeoutVoiceHalf is Timeout's voice half. Eligibility is the actor's CanModerateVoice in the TARGET's
// CURRENT voice channel, not a bare MUTE_MEMBERS bit (which bypassed channel deny, room visibility and DM
// membership). "Applied" requires the muter to report success.
func (s *ModerationService) applyTimeoutVoiceHalf(ctx context.Context, actorID, targetID, actionID int64, supersededIDs []int64) bool {
	auth, ok := s.actorCanModerateVoiceFor(ctx, actorID, targetID)
	if !ok || s.voiceMuter == nil {
		s.releaseSupersededMute(ctx, targetID, supersededIDs)
		return false
	}
	if timeoutPreMuteHook != nil {
		timeoutPreMuteHook()
	}
	applied, _ := s.voiceMuter.MuteForTimeout(context.WithoutCancel(ctx), targetID, auth.channelID, actionID, auth.joinedAt, supersededIDs)
	return applied
}

// voiceAuthorization is the session actorCanModerateVoiceFor authorized: channelID and joinedAt, bound so the
// later mute/unmute is scoped to that EXACT session.
type voiceAuthorization struct {
	channelID int64
	joinedAt  string
}

// timeoutPreMuteHook runs between session authorization and MuteForTimeout. Test-only: the race test moves
// the target to another session in that gap.
var timeoutPreMuteHook func()

// actorCanModerateVoiceFor reports whether actorID may run the voice half against targetID's CURRENT voice
// channel: permissions.CanModerateVoice over the actor's Subject there, so a channel deny, invisible room or
// non-participant DM call refuse it as voice_mod_mute does. ok=false when the target has no live voice
// connection (skipped, not refused).
func (s *ModerationService) actorCanModerateVoiceFor(ctx context.Context, actorID, targetID int64) (voiceAuthorization, bool) {
	state, err := s.st.GetVoiceState(ctx, targetID)
	if err != nil || state == nil {
		return voiceAuthorization{}, false
	}
	ch, err := s.st.GetChannel(ctx, state.ChannelID)
	if err != nil || ch == nil {
		return voiceAuthorization{}, false
	}
	sub, err := channelSubject(ctx, s.st, s.perms, actorID, ch, false)
	if err != nil {
		return voiceAuthorization{}, false
	}
	// The canonical authorizer ws.voiceModTarget uses: the actor's BASE role must hold
	// MUTE_MEMBERS, not merely a channel-scoped allow override.
	if permissions.AuthorizeVoiceModerator(sub) != nil {
		return voiceAuthorization{}, false
	}
	return voiceAuthorization{channelID: state.ChannelID, joinedAt: state.JoinedAt}, true
}

// LiftTimeout ends targetID's active timeout early: same permission and hierarchy as Timeout, then the
// guarded UPDATE, then the voice half is lifted. A live target gets a mod_action frame with nil expires_at.
// ErrNotFound when no active timeout.
func (s *ModerationService) LiftTimeout(ctx context.Context, actorID, targetID int64) error {
	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}

	actorRole, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers)
	if err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	liftedIDs, err := s.st.LiftTimeout(ctx, targetID, actorID)
	if err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to lift timeout: %w", ErrInternal, err)
	}
	if len(liftedIDs) == 0 {
		return fmt.Errorf("%w: no active timeout", ErrNotFound)
	}

	s.FinalizeTimeoutLift(ctx, targetID, liftedIDs, actorID)
	slog.Info("timeout lifted", "actor_id", actorID, "target_id", targetID)
	return nil
}

// FinalizeTimeoutLift is the post-commit half of lifting a timeout: it clears the voice_states mute owned by
// one of liftedActionIDs (per-target lock and paired SFU call), then sends the "lifted" mod_action frame and
// user_untimeout audit row. Ownership is session-bound, so another moderator's mute or a still-active
// timeout's can never match and needs no CanModerateVoice re-check. Exported and taking the ledger's OWN ids
// so a caller lifting inside its own transaction (an appeal overturn, via db.LiftTimeoutActionsByID) runs the
// same sequence after commit. actorID is the human moderator, or 0 for a system-initiated finalize (the
// maintenance reconcile sweep). Repair and notification are separate on purpose: a STALE finalize, whose ids
// lost the race to a NEWER active timeout, must still repair but must NOT send a "lifted" frame or audit row,
// which would tell a live client it is free while the newer timeout holds.
func (s *ModerationService) FinalizeTimeoutLift(ctx context.Context, targetID int64, liftedActionIDs []int64, actorID int64) {
	s.refreshTimeoutMirror(ctx)
	if s.voiceMuter != nil {
		s.voiceMuter.UnmuteForTimeout(context.WithoutCancel(ctx), targetID, liftedActionIDs)
	}
	active, err := s.st.HasActiveTimeout(context.WithoutCancel(ctx), targetID)
	if err != nil {
		slog.Error("FinalizeTimeoutLift: HasActiveTimeout", "err", err, "target_id", targetID)
		return
	}
	if active {
		// A newer timeout superseded liftedActionIDs and already published the current state.
		return
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_untimeout", "user", targetID, "timeout lifted")
	s.notifyModAction(targetID, 0, "timeout", "", nil)
}
