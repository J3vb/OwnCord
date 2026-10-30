package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ModerationService handles user ban, unban, warn, timeout and erasure operations.
type ModerationService struct {
	st    Store
	perms *PermissionService
	// erasure runs the administrator's account erasure; nil fails EraseUser closed.
	erasure *ErasureService
	// messages serves only the report-linked removal (ActOnReport, kind="removal"), not
	// a second copy of DeleteMessage's authorization.
	messages *MessageService
	// users performs the moderator nickname write under the target's profile lock;
	// nil fails SetNickname closed.
	users *UserService
	// notifier delivers a live mod_action frame (warning, timeout applied or lifted)
	// to a connected target. Nil is a no-op: a disconnected target still gets the
	// ledger row and sees it on next connect or next attempted send.
	notifier ModActionNotifier
	// permNotifier receives a committed role assignment's live fan-out. Nil is a no-op.
	permNotifier PermissionChangeNotifier
	// voiceMuter applies or lifts the voice half of a timeout through the SFU
	// mechanism voice_mod_mute uses. Nil is a no-op; Timeout still lands for text and
	// reactions.
	voiceMuter TimeoutVoiceMuter
	// limiter throttles the ban purge's authorization per actor; nil disables it.
	limiter *auth.RateLimiter
	// banPurgeSem admits one ban purge at a time server-wide (lock order: PurgeAfterBan).
	banPurgeSem chan struct{}
	// banPurgeRowCap overrides banPurgeMaxRows when positive (tests only).
	banPurgeRowCap int
}

// ModActionNotifier delivers a live mod_action frame to a connected target.
// *ws.Hub implements it.
type ModActionNotifier interface {
	NotifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time)
}

// TimeoutVoiceMuter is the voice-hub surface Timeout/LiftTimeout use for the voice
// half of a timeout, reusing voice_mod_mute's SFU mechanism. A mute with no live
// voice connection is a silent no-op. *ws.Hub implements it.
type TimeoutVoiceMuter interface {
	// MuteForTimeout mutes userID in channelID/joinedAt, the EXACT session
	// actorCanModerateVoiceFor already authorized (not a fresh re-read that could
	// resolve a different one), stamping actionID as owner atomically with the DB
	// write under a per-user lock shared with the manual voice-mute endpoint.
	// applied is false for every no-op path (no voice store, no live connection,
	// channel-switch race, or an SFU failure that rolls the DB transition back).
	// owned is true only when THIS call caused the unmuted-to-muted transition.
	// supersededIDs hands ownership from just-superseded ledger ids to actionID
	// INSIDE that same lock: transferring outside it could land between another
	// action's DB write and SFU call, so that action's rollback would miss the row.
	MuteForTimeout(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (applied, owned bool)
	// UnmuteForTimeout clears the mute owned by any of actionIDs (a lift's id or its
	// supersede chain). Session-bound: an ended or restarted session cannot be
	// cleared by a stale id. Reports whether anything was cleared.
	UnmuteForTimeout(ctx context.Context, userID int64, actionIDs []int64) bool
}

// NewModerationService creates a ModerationService.
func NewModerationService(st Store, perms *PermissionService) *ModerationService {
	return &ModerationService{st: st, perms: perms, banPurgeSem: make(chan struct{}, 1)}
}

// SetNotifier installs the live mod_action notifier.
func (s *ModerationService) SetNotifier(n ModActionNotifier) { s.notifier = n }

// SetVoiceMuter installs the voice-mute hook Timeout/LiftTimeout use.
func (s *ModerationService) SetVoiceMuter(v TimeoutVoiceMuter) { s.voiceMuter = v }

func (s *ModerationService) notifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time) {
	if s.notifier != nil {
		s.notifier.NotifyModAction(userID, actionID, kind, reason, expiresAt)
	}
}

// ErasureBroadcastsMemberBan reports whether the erasure runner sends the
// member_ban itself (a hub is installed on it); the transport sends its own
// only when it does not.
func (s *ModerationService) ErasureBroadcastsMemberBan() bool {
	return s.erasure != nil && s.erasure.BroadcastsMemberBan()
}

// EraseUser is the administrator-initiated account erasure, the same
// implementation as self-deletion, gated on ERASE_ACCOUNTS (ADMINISTRATOR implies
// it) plus actor-outranks-target. An actor cannot erase itself here (that is the
// password-confirmed self-service route) and the last admin-class account is
// Forbidden. The transport broadcasts member_ban.
func (s *ModerationService) EraseUser(ctx context.Context, actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot erase your own account via the admin panel", ErrBadRequest)
	}
	if s.erasure == nil {
		return fmt.Errorf("%w: erasure unavailable", ErrInternal)
	}

	// Authorization before existence, see BanUser.
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return err
	}
	if !permissions.CanEraseAccounts(actorRole.Permissions) {
		return fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(permissions.EraseAccounts))
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	if err := s.erasure.Erase(ctx, targetID); err != nil {
		switch {
		case errors.Is(err, db.ErrLastAdmin):
			return fmt.Errorf("%w: cannot erase the last admin account", ErrForbidden)
		case errors.Is(err, db.ErrNotFound):
			return fmt.Errorf("%w: user not found", ErrNotFound)
		case errors.Is(err, ErrErasureFilesPending):
			// The account is gone; the journal finishes the files.
			slog.Warn("admin erasure: files pending", "actor_id", actorID, "target_id", targetID, "err", err)
		case errors.Is(err, ErrErasureInProgress):
			// The erasure is committed to; the maintenance loop finishes it.
			slog.Info("admin erasure: in progress", "actor_id", actorID, "target_id", targetID)
		default:
			slog.Error("admin erasure failed", "actor_id", actorID, "target_id", targetID, "err", err)
			return fmt.Errorf("%w: failed to erase account", ErrInternal)
		}
	}

	// Audit rows must survive a request canceled after the erasure committed. The
	// target is the marker's token, never the id.
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		ActorID: actorID, Action: "account_deleted", TargetType: "user", Detail: "account erased by administrator",
		SubjectToken: s.erasure.SubjectToken(targetID),
	})

	slog.Info("account erased by administrator", "actor_id", actorID, "target_id", targetID)
	return nil
}

// roleFor loads a principal's role through the permission cache. Every failure is
// Forbidden: an unresolvable role must never authorize a moderation action.
// which names the principal in the error ("actor" or "target").
func (s *ModerationService) roleFor(ctx context.Context, userID int64, which string) (*db.Role, error) {
	if s.perms == nil {
		// Fail closed rather than allow unchecked actions.
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load %s role", ErrForbidden, which)
	}
	return role.Effective(), nil
}

// requirePerm verifies the actor holds perm (or the Administrator bypass) and
// returns the actor's role. It takes no target and runs before any target lookup,
// so an unauthorized actor always sees Forbidden, never NotFound, and cannot
// enumerate user ids.
func (s *ModerationService) requirePerm(ctx context.Context, actorID, perm int64) (*db.Role, error) {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return nil, err
	}
	if !permissions.HasServerPerm(actorRole.Permissions, perm) {
		return nil, fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(perm))
	}
	return actorRole, nil
}

func (s *ModerationService) requireBanPermission(ctx context.Context, actorID int64) error {
	_, err := s.requirePerm(ctx, actorID, permissions.BanMembers)
	return err
}

// requireOutranks enforces that the actor strictly outranks the target so a user
// cannot moderate a peer or higher-ranked user (e.g. the owner). Runs after the
// permission and existence checks.
func (s *ModerationService) requireOutranks(ctx context.Context, actorID, targetID int64) error {
	actorRole, err := s.roleFor(ctx, actorID, "actor")
	if err != nil {
		return err
	}
	return s.requireOutranksRole(ctx, actorRole, targetID)
}

// requireOutranksRole is requireOutranks with the actor's role already loaded.
func (s *ModerationService) requireOutranksRole(ctx context.Context, actorRole *db.Role, targetID int64) error {
	targetRole, err := s.roleFor(ctx, targetID, "target")
	if err != nil {
		return err
	}
	if actorRole.Position <= targetRole.Position {
		return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
	}
	return nil
}

// Warn issues a warning: MODERATE_MEMBERS, target exists, not self,
// requireOutranks, then the ledger row, then the audit row. The audit detail is
// a fixed phrase, never the reason: the reason is shown to the target, the audit
// log is operator-facing. reportID links a report-linked warning (ActOnReport).
func (s *ModerationService) Warn(ctx context.Context, actorID, targetID int64, reason string, reportID *int64) (int64, error) {
	if err := requireHumanActor(actorID); err != nil {
		return 0, err
	}
	if targetID <= 0 {
		return 0, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return 0, fmt.Errorf("%w: cannot warn yourself", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return 0, err
	}

	// Authorization before existence, see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers)
	if err != nil {
		return 0, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return 0, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return 0, err
	}

	id, err := s.st.WarnUser(ctx, targetID, actorID, reportID, reason)
	if err != nil {
		if errors.Is(err, db.ErrOutranked) {
			// A concurrent role change: refused, not sanctioned.
			return 0, fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return 0, fmt.Errorf("%w: failed to warn user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_warn", "user", targetID, "warning issued")
	s.notifyModAction(targetID, id, "warning", reason, nil)

	slog.Info("user warned", "actor_id", actorID, "target_id", targetID)
	return id, nil
}

// TimeoutResult is Timeout's outcome: the ledger row id, and whether the voice
// half was skipped because the actor lacked MUTE_MEMBERS.
type TimeoutResult struct {
	ID           int64
	VoiceSkipped bool
}

// Timeout time-boxes a restriction on targetID: same order as Warn, duration
// 1 minute..28 days, ledger row with expires_at (read back through the
// predicates, e.g. Subject.TimedOut). The voice half applies through voiceMuter
// ONLY when the actor holds MUTE_MEMBERS; otherwise text and reactions are still
// restricted and VoiceSkipped is true.
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

// applyTimeoutVoiceHalf is Timeout's voice half. Eligibility is the actor's
// CanModerateVoice in the TARGET's CURRENT voice channel, not a bare
// server-wide MUTE_MEMBERS bit (which bypassed channel deny, room visibility and
// DM membership). "Applied" requires the muter to report success: a target not in
// voice, a channel-switch race or an SFU failure must not count.
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

// voiceAuthorization is the voice session actorCanModerateVoiceFor authorized:
// channelID and joinedAt (the join-instance token JoinVoiceChannel mints), bound
// together so the later mute/unmute is scoped to that EXACT session.
type voiceAuthorization struct {
	channelID int64
	joinedAt  string
}

// timeoutPreMuteHook runs between session authorization and MuteForTimeout.
// Test-only: the race test moves the target to another session in that gap to
// prove the mute stays bound to the SAME session.
var timeoutPreMuteHook func()

// actorCanModerateVoiceFor reports whether actorID may run the voice half of a
// timeout or lift against targetID's CURRENT voice channel:
// permissions.CanModerateVoice over the actor's Subject there, so a channel
// deny, an invisible room or a non-participant DM call refuse it exactly as
// voice_mod_mute does. ok=false when the target has no live voice connection
// (skipped, not refused); on ok=true the voiceAuthorization is the exact session
// to bind the call to.
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
	// The canonical authorizer ws.voiceModTarget uses: the actor's BASE role must
	// hold MUTE_MEMBERS, not merely a channel-scoped allow override, which
	// CanModerateVoice alone would accept.
	if permissions.AuthorizeVoiceModerator(sub) != nil {
		return voiceAuthorization{}, false
	}
	return voiceAuthorization{channelID: state.ChannelID, joinedAt: state.JoinedAt}, true
}

// LiftTimeout ends targetID's active timeout early: same permission and
// hierarchy as Timeout, then the guarded UPDATE, then the voice half (if ever
// applied) is lifted. A live target gets a mod_action frame with nil expires_at.
// ErrNotFound when there is no active timeout.
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
			// A concurrent role change: refused, not applied.
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

// FinalizeTimeoutLift is the post-commit half of lifting a timeout: it clears the
// voice_states mute owned by one of liftedActionIDs (through the per-target lock
// and paired SFU call), then sends the "lifted" mod_action frame and the
// user_untimeout audit row. Ownership is session-bound, so a mute set by another
// moderator via voice_mod_mute, or one belonging to a still-active timeout, can
// never match liftedActionIDs and needs no CanModerateVoice re-check.
//
// Exported and taking the ledger's OWN ids so a caller that lifts inside its own
// transaction (an appeal overturn, via db.LiftTimeoutActionsByID) runs this same
// sequence after its commit. actorID is the human moderator, or 0 for a
// system-initiated finalize (the maintenance reconcile sweep).
//
// The repair and the notification are separate on purpose: a STALE finalize,
// whose ids lost the race to a NEWER active timeout, must still run its repair
// (it can only match its own ids) but must NOT send a "lifted" frame or audit
// row, which would tell a live client it is free while the newer timeout holds.
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
		// A newer timeout superseded liftedActionIDs and already published the current
		// state; the repair above is all this stale finalize owns.
		return
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_untimeout", "user", targetID, "timeout lifted")
	s.notifyModAction(targetID, 0, "timeout", "", nil)
}

// ActOnReportParams is the input for POST /api/v1/moderation/queue/{public_id}/act.
// The caller resolves TargetID and MessageID from the report, so ModerationService
// needs no ReportService dependency.
type ActOnReportParams struct {
	ActorID         int64
	Kind            string // "warning" | "timeout" | "kick" | "ban" | "removal"
	Reason          string
	DurationSeconds int64 // timeout only
	TargetID        int64 // warning/timeout/kick/ban: the report's subject
	MessageID       int64 // removal: the reported message
	ReportID        int64
}

// ActOnReportResult is ActOnReport's outcome: enough for the act route to send
// the same transport broadcasts the direct routes send.
type ActOnReportResult struct {
	Kind string
	// TargetID is the sanctioned user; zero for removal, whose ledger target is the
	// actor, not the author (see recordLedgerRow).
	TargetID int64
	// Voice is timeout's voice outcome, "applied" or "skipped"; empty otherwise.
	Voice string
	// ChannelID and MessageID are removal's chat_bulk_deleted broadcast inputs; zero
	// otherwise.
	ChannelID int64
	MessageID int64
}

// ActOnReport dispatches a report-linked moderator action across all five kinds,
// each calling the same service method its direct-route sibling calls with
// report_id set on the ledger row. validateActionReason runs once up front for
// every kind, since kick and removal do not validate their own.
func (s *ModerationService) ActOnReport(ctx context.Context, p ActOnReportParams) (*ActOnReportResult, error) {
	if err := validateActionReason(p.Reason); err != nil {
		return nil, err
	}
	reportID := p.ReportID
	switch p.Kind {
	case "warning":
		if _, err := s.Warn(ctx, p.ActorID, p.TargetID, p.Reason, &reportID); err != nil {
			return nil, err
		}
		return &ActOnReportResult{Kind: p.Kind, TargetID: p.TargetID}, nil
	case "timeout":
		duration, err := TimeoutDurationFromSeconds(p.DurationSeconds)
		if err != nil {
			return nil, err
		}
		result, err := s.Timeout(ctx, p.ActorID, p.TargetID, p.Reason, duration, &reportID)
		if err != nil {
			return nil, err
		}
		voice := "applied"
		if result.VoiceSkipped {
			voice = "skipped"
		}
		return &ActOnReportResult{Kind: p.Kind, TargetID: p.TargetID, Voice: voice}, nil
	case "kick":
		if err := s.forceLogout(ctx, p.ActorID, p.TargetID, p.Reason, &reportID); err != nil {
			return nil, err
		}
		return &ActOnReportResult{Kind: p.Kind, TargetID: p.TargetID}, nil
	case "ban":
		if err := s.banUser(ctx, p.ActorID, p.TargetID, p.Reason, nil, &reportID); err != nil {
			return nil, err
		}
		return &ActOnReportResult{Kind: p.Kind, TargetID: p.TargetID}, nil
	case "removal":
		if s.messages == nil {
			return nil, fmt.Errorf("%w: message removal unavailable", ErrInternal)
		}
		delResult, err := s.messages.DeleteMessageForReport(ctx, p.ActorID, p.MessageID, p.ReportID, p.Reason)
		if err != nil {
			return nil, err
		}
		return &ActOnReportResult{Kind: p.Kind, ChannelID: delResult.ChannelID, MessageID: delResult.MessageID}, nil
	default:
		return nil, fmt.Errorf("%w: invalid kind", ErrBadRequest)
	}
}

// BanUser bans a target user; the target must exist and not be the actor.
func (s *ModerationService) BanUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time) error {
	return s.banUser(ctx, actorID, targetID, reason, expires, nil)
}

func (s *ModerationService) banUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time, reportID *int64) error {
	ctx, done := traceCall(ctx, "service/moderation", "ModerationService.BanUser",
		telemetry.Int64("actor_id", actorID),
		telemetry.Int64("target_id", targetID),
	)
	defer done()

	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return err
	}

	// Authorization before existence: an actor without ban authority learns nothing
	// about which user ids exist.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if _, err := s.st.BanUserWithAction(ctx, targetID, reason, expires, actorID, reportID); err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to ban user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the ban committed. The detail
	// is a fixed phrase, never the reason: the reason is already on users.ban_reason
	// for AdminPerimeter holders, and a second copy of free text could quote a message.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_ban", "user", targetID, "user banned")

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID)
	return nil
}

// authorizeRoleAssignment runs the AuthorizeRoleChange checks for the one role
// being assigned or removed.
func (s *ModerationService) authorizeRoleAssignment(ctx context.Context, actorID, targetID, newRoleID int64) (actorRole *db.Role, target *db.User, newRole *db.Role, err error) {
	if targetID <= 0 {
		return nil, nil, nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, nil, nil, fmt.Errorf("%w: cannot change your own role", ErrBadRequest)
	}

	// Authorization before existence, see BanUser.
	actorRole, err = s.requirePerm(ctx, actorID, permissions.ManageRoles)
	if err != nil {
		return nil, nil, nil, err
	}
	target, err = s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return nil, nil, nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, nil, nil, err
	}

	newRole, err = s.st.GetRoleByID(ctx, newRoleID)
	if err != nil || newRole == nil {
		return nil, nil, nil, fmt.Errorf("%w: role not found", ErrBadRequest)
	}
	// Administrator bypasses permission bits, never the hierarchy: only the owner can
	// grant a role at or above an admin.
	if newRole.Position >= actorRole.Position {
		return nil, nil, nil, fmt.Errorf("%w: cannot assign a role at or above your own rank", ErrForbidden)
	}
	// A role carrying an owner-grant-only bit (MOVE_MEMBERS) needs the owner, an
	// Administrator, or an actor whose own mask holds every such bit.
	if err := requireOwnerGrantOnlyAssign(actorRole, newRole.Permissions); err != nil {
		return nil, nil, nil, err
	}
	return actorRole, target, newRole, nil
}

// ChangeUserRole assigns newRoleID to the target. It enforces MANAGE_ROLES and
// two hierarchy rules: the actor must strictly outrank the target and may not
// hand out a role at or above their own (else any admin could promote anyone,
// including themselves via a second account, to Owner). It returns the assigned
// role so callers can use it instead of a re-read that would race a concurrent
// role delete.
func (s *ModerationService) ChangeUserRole(ctx context.Context, actorID, targetID, newRoleID int64) (*db.Role, error) {
	_, target, newRole, err := s.AuthorizeRoleChange(ctx, actorID, targetID, newRoleID)
	if err != nil {
		return nil, err
	}

	if err := s.st.UpdateUserRole(ctx, targetID, newRoleID); err != nil {
		return nil, fmt.Errorf("%w: failed to update role: %w", ErrInternal, err)
	}
	// Drop the cached role now: a demotion would otherwise keep the old bits and
	// rank for up to permCacheTTL.
	s.perms.InvalidateUser(targetID)

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_change", "user", targetID,
		fmt.Sprintf("changed %s role to %s", target.Username, newRole.Name))

	slog.Info("role changed", "actor_id", actorID, "target_id", targetID, "new_role_id", newRoleID)
	s.roleAssigned(targetID)
	return newRole, nil
}

// ForceLogout revokes every session of the target (the client's "Kick"; OwnCord is
// single-server so "remove from guild" has no referent). Gated on KICK_MEMBERS plus
// the ban hierarchy rule.
func (s *ModerationService) ForceLogout(ctx context.Context, actorID, targetID int64) error {
	return s.forceLogout(ctx, actorID, targetID, "", nil)
}

// forceLogout's reason is the ledger row's text; empty falls back to "all sessions
// terminated".
func (s *ModerationService) forceLogout(ctx context.Context, actorID, targetID int64, reason string, reportID *int64) error {
	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot force-logout yourself", ErrBadRequest)
	}
	if err := validateActionReason(reason); err != nil {
		return err
	}

	// Authorization before existence, see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.KickMembers)
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

	if _, err := s.st.ForceLogoutWithAction(ctx, targetID, actorID, reportID, reason); err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to log out user: %w", ErrInternal, err)
	}

	// The sessions are gone; drop the socket now rather than at the hub's 30-second
	// sweep (as profile_handler.go and recovery.go do), since kick exists for
	// immediate ejection. A notifier without this (tests, nil) is a no-op.
	if d, ok := s.notifier.(SessionDisconnector); ok {
		d.DisconnectRevokedUser(targetID)
	}

	// Audit rows must survive a request canceled after the commit. Fixed phrase,
	// never the reason, as in Ban's audit row.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "force_logout", "user", targetID,
		"all sessions terminated")

	slog.Info("force logout", "actor_id", actorID, "target_id", targetID)
	return nil
}

// UnbanUser removes a ban on a target user.
func (s *ModerationService) UnbanUser(ctx context.Context, actorID, targetID int64) error {
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}

	// Authorization before existence, see BanUser.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil || target.IsSystemAccount() {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.st.UnbanUser(ctx, targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_unban", "user", targetID, "")

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}

// ListActionsForTarget backs GET /api/v1/moderation/users/{id}/actions, gated on
// MODERATE_MEMBERS like the report queue.
func (s *ModerationService) ListActionsForTarget(ctx context.Context, actorID, targetID int64) ([]db.ModerationAction, error) {
	if _, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers); err != nil {
		return nil, err
	}
	rows, err := s.st.ListModerationActionsForTarget(ctx, targetID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// ListActionsForReport lists a report's "actions taken". It checks no permission:
// ReportService.Get already gated the read.
func (s *ModerationService) ListActionsForReport(ctx context.Context, reportID int64) ([]db.ModerationAction, error) {
	rows, err := s.st.ListModerationActionsForReport(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// OwnModerationAction is one row of GET /api/v1/users/me/moderation. Appealable
// means an appealable kind with no appeal filed yet.
type OwnModerationAction struct {
	db.OwnModerationAction
	Appealable bool
}

// ownModerationListLimit caps ListOwnActions: removal and ban rows never retire.
const ownModerationListLimit = 200

// ListOwnActions reads userID's own ledger rows from storage with no permission
// bit: the query is scoped to target_id = userID and selects nothing a member may
// not see.
func (s *ModerationService) ListOwnActions(ctx context.Context, userID int64) ([]OwnModerationAction, error) {
	rows, err := s.st.ListOwnModerationActions(ctx, userID, ownModerationListLimit)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	out := make([]OwnModerationAction, 0, len(rows))
	for _, r := range rows {
		out = append(out, OwnModerationAction{OwnModerationAction: r, Appealable: appealableKinds[r.Kind] && r.AppealID == nil})
	}
	return out, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID (own rows only).
// ErrNotFound covers a foreign, already-acknowledged or non-warning id alike, so
// the route cannot probe another user's ids.
func (s *ModerationService) AcknowledgeWarning(ctx context.Context, userID, actionID int64) error {
	if actionID <= 0 {
		return fmt.Errorf("%w: id must be positive", ErrBadRequest)
	}
	ok, err := s.st.AcknowledgeWarning(ctx, userID, actionID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInternal, err)
	}
	if !ok {
		return fmt.Errorf("%w: notice not found", ErrNotFound)
	}
	return nil
}
