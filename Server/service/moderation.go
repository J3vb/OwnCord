package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// ModerationService handles user ban/unban operations.
type ModerationService struct {
	st    Store
	perms *PermissionService
	// erasure runs the administrator's account erasure (B4-9); nil fails
	// EraseUser closed.
	erasure *ErasureService
	// messages is used only by the report-linked removal entry point
	// (ActOnReport, kind="removal") — package-private, same package, not a
	// second copy of DeleteMessage's authorization.
	messages *MessageService
	// notifier delivers a live mod_action frame to a connected target
	// (B5-9): warning issued, timeout applied, or timeout lifted. *ws.Hub
	// implements it; wired via SetNotifier from the composition root,
	// mirroring ErasureService.SetHub. Nil is a normal no-op — a
	// disconnected target still gets the ledger row and sees a warning on
	// next connect (ready's notices) or a timeout on their next attempted
	// send (the predicates).
	notifier ModActionNotifier
	// voiceMuter applies or lifts the voice half of a timeout on a
	// currently-connected target, through the exact SFU mechanism
	// voice_mod_mute uses (decision 6: timeout's voice half defers to
	// MUTE_MEMBERS rather than adding a second path to the same effect).
	// Nil is a normal no-op — Timeout still lands for text and reactions.
	voiceMuter TimeoutVoiceMuter
}

// ModActionNotifier delivers a live mod_action frame to a connected target.
// *ws.Hub implements it.
type ModActionNotifier interface {
	NotifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time)
}

// TimeoutVoiceMuter is the minimal voice-hub surface Timeout/LiftTimeout use
// to apply or lift the voice half of a timeout, reusing voice_mod_mute's own
// SFU mechanism rather than reimplementing it. Muted with no live voice
// connection is a silent no-op. *ws.Hub implements it.
type TimeoutVoiceMuter interface {
	ApplyTimeoutMute(ctx context.Context, userID int64, muted bool)
}

// NewModerationService creates a ModerationService.
func NewModerationService(st Store, perms *PermissionService) *ModerationService {
	return &ModerationService{st: st, perms: perms}
}

// SetNotifier installs the live mod_action notifier.
func (s *ModerationService) SetNotifier(n ModActionNotifier) { s.notifier = n }

// SetVoiceMuter installs the voice-mute hook Timeout/LiftTimeout use.
func (s *ModerationService) SetVoiceMuter(v TimeoutVoiceMuter) { s.voiceMuter = v }

// notifyModAction is a nil-safe call to the installed notifier.
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

// EraseUser is the administrator-initiated account erasure (B4-9): the same
// implementation as self-deletion, gated on ADMINISTRATOR plus the
// actor-outranks-target hierarchy. An actor cannot erase itself here — that
// is the password-confirmed self-service route. The last admin-class
// account cannot be erased (Forbidden). Writes the account_deleted audit
// row with the actor; the transport broadcasts member_ban.
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

	// Authorization before existence — see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.Administrator)
	if err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
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
		default:
			slog.Error("admin erasure failed", "actor_id", actorID, "target_id", targetID, "err", err)
			return fmt.Errorf("%w: failed to erase account", ErrInternal)
		}
	}

	// Audit rows must survive a request canceled after the erasure committed.
	// The actor stays; the target is the marker's token, never the id (B4-10).
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		ActorID: actorID, Action: "account_deleted", TargetType: "user", Detail: "account erased by administrator",
		SubjectToken: s.erasure.SubjectToken(targetID),
	})

	slog.Info("account erased by administrator", "actor_id", actorID, "target_id", targetID)
	return nil
}

// roleFor loads a principal's role through the permission cache. Every failure
// is Forbidden: an unresolvable role must never authorize a moderation action.
// The which argument names the principal in the error message ("actor" or
// "target").
func (s *ModerationService) roleFor(ctx context.Context, userID int64, which string) (*db.Role, error) {
	if s.perms == nil {
		// No permission service wired — fail closed rather than allow unchecked actions.
		return nil, fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, fmt.Errorf("%w: failed to load %s role", ErrForbidden, which)
	}
	return role, nil
}

// requirePerm verifies the actor holds perm (or the Administrator bypass) and
// returns the actor's role for follow-up hierarchy checks. It deliberately
// takes no target: it runs before any target lookup so an actor without
// authority always sees Forbidden and never NotFound — these paths cannot be
// used to enumerate user ids.
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

// requireBanPermission verifies the actor holds BAN_MEMBERS. See requirePerm.
func (s *ModerationService) requireBanPermission(ctx context.Context, actorID int64) error {
	_, err := s.requirePerm(ctx, actorID, permissions.BanMembers)
	return err
}

// requireOutranks enforces the role hierarchy: the actor must strictly
// outrank the target so a user cannot moderate a peer or a higher-ranked user
// (e.g. the owner) — mirroring the position-based hierarchy used elsewhere.
// Runs after the permission and existence checks, so only callers that already
// hold authority reach it.
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

// reasonMaxRunes bounds the moderator-action ledger's free-text reason (S6
// storage exhaustion, and the same shape the audit detail denylist expects
// of every free-text field): 500 runes, no control characters. Applies to
// warning and timeout, whose reason is shown to the TARGET — the audit row
// itself never carries it (a fixed phrase instead; see Warn).
const reasonMaxRunes = 500

// validateActionReason is warning/timeout's shared reason-shape rule.
func validateActionReason(reason string) error {
	if len([]rune(reason)) > reasonMaxRunes {
		return fmt.Errorf("%w: reason is too long", ErrBadRequest)
	}
	if hasControlChar(reason) {
		return fmt.Errorf("%w: reason contains control characters", ErrBadRequest)
	}
	return nil
}

// minTimeoutDuration and maxTimeoutDuration bound Timeout's duration
// (decision 6): 1 minute to 28 days.
const (
	minTimeoutDuration = time.Minute
	maxTimeoutDuration = 28 * 24 * time.Hour
)

// requireHumanActor is workstream 10's absence-proof guard, repeated at the
// top of every ModerationService action method before any other check: no
// plugin capability or automated caller can pass a non-positive actor id and
// have it land on the ledger (Server/db's recordModerationAction/
// recordLedgerRow repeat the same guard at the transaction, since that is
// the one place every kind funnels through — this is the service-boundary
// half). Deliberately NOT a schema CHECK (docs: erasure sets actor_id to 0
// for an erased moderator, and a constraint would forbid that transition).
func requireHumanActor(actorID int64) error {
	if actorID <= 0 {
		return fmt.Errorf("%w: a moderation action requires a human actor", ErrForbidden)
	}
	return nil
}

// Warn issues a warning (decision 6): MODERATE_MEMBERS, target exists, not
// self, requireOutranks, then the ledger row — its entire effect — then the
// audit row. The audit detail is a fixed phrase, never the reason text: the
// reason is shown to the target (ready's notices), the audit log is a
// different, operator-facing surface. reportID links a report-linked
// warning (ActOnReport). A live target gets a mod_action frame.
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

	// Authorization before existence — see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers)
	if err != nil {
		return 0, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return 0, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return 0, err
	}

	id, err := s.st.WarnUser(ctx, targetID, actorID, reportID, reason)
	if err != nil {
		if errors.Is(err, db.ErrOutranked) {
			// The concurrent-role-change case: refused, not sanctioned.
			return 0, fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return 0, fmt.Errorf("%w: failed to warn user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the warning committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_warn", "user", targetID, "warning issued")
	s.notifyModAction(targetID, id, "warning", reason, nil)

	slog.Info("user warned", "actor_id", actorID, "target_id", targetID)
	return id, nil
}

// TimeoutResult is Timeout's outcome: the ledger row id, and whether the
// voice half was skipped because the actor lacked MUTE_MEMBERS (decision 6
// — timeout defers to it rather than granting a mute a MUTE_MEMBERS-less
// moderator could not perform on their own).
type TimeoutResult struct {
	ID           int64
	VoiceSkipped bool
}

// Timeout time-boxes a restriction on targetID (decision 6): same order as
// Warn, duration bounded 1 minute..28 days, the ledger row with expires_at
// — its effect, read back through the predicates (Subject.TimedOut) rather
// than a scattered per-handler check. The voice half applies the existing
// server-mute mechanism through voiceMuter ONLY when the actor holds
// MUTE_MEMBERS; otherwise text and reactions are still restricted and
// VoiceSkipped is true. A live target gets a mod_action frame.
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

	// Authorization before existence — see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.ModerateMembers)
	if err != nil {
		return nil, err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, err
	}

	expires := time.Now().Add(duration)
	id, err := s.st.TimeoutUser(ctx, targetID, actorID, reportID, reason, expires)
	if err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return nil, fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return nil, fmt.Errorf("%w: failed to time out user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the timeout committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_timeout", "user", targetID,
		fmt.Sprintf("timeout issued, expires %s", expires.UTC().Format(time.RFC3339)))

	// The voice half defers to MUTE_MEMBERS (decision 6): a server-scoped
	// check with no channel to resolve a Subject for, mirroring
	// requirePerm's own residue row.
	voiceSkipped := !permissions.HasServerPerm(actorRole.Permissions, permissions.MuteMembers)
	if !voiceSkipped && s.voiceMuter != nil {
		s.voiceMuter.ApplyTimeoutMute(context.WithoutCancel(ctx), targetID, true)
	}

	s.notifyModAction(targetID, id, "timeout", reason, &expires)

	slog.Info("user timed out", "actor_id", actorID, "target_id", targetID, "expires_at", expires, "voice_skipped", voiceSkipped)
	return &TimeoutResult{ID: id, VoiceSkipped: voiceSkipped}, nil
}

// LiftTimeout ends targetID's active timeout early (decision 6): same
// permission and hierarchy as Timeout, then the guarded UPDATE, then the
// voice half (if ever applied) is lifted through the same mechanism. A
// live target gets a mod_action frame with a nil expires_at. ErrNotFound
// when there is no active timeout to lift.
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
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	lifted, err := s.st.LiftTimeout(ctx, targetID, actorID)
	if err != nil {
		return fmt.Errorf("%w: failed to lift timeout: %w", ErrInternal, err)
	}
	if !lifted {
		return fmt.Errorf("%w: no active timeout", ErrNotFound)
	}

	if s.voiceMuter != nil {
		s.voiceMuter.ApplyTimeoutMute(context.WithoutCancel(ctx), targetID, false)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_untimeout", "user", targetID, "timeout lifted")
	s.notifyModAction(targetID, 0, "timeout", "", nil)

	slog.Info("timeout lifted", "actor_id", actorID, "target_id", targetID)
	return nil
}

// ActOnReportParams is the report-linked queue action's input (plan item 7,
// POST /api/v1/moderation/queue/{public_id}/act). TargetID and MessageID
// are resolved by the caller (the handler, through ReportService) from the
// report's subject and target: ModerationService itself needs no
// ReportService dependency to dispatch across the five kinds.
type ActOnReportParams struct {
	ActorID         int64
	Kind            string // "warning" | "timeout" | "kick" | "ban" | "removal"
	Reason          string
	DurationSeconds int64 // timeout only
	TargetID        int64 // warning/timeout/kick/ban: the report's subject
	MessageID       int64 // removal: the reported message
	ReportID        int64
}

// ActOnReport dispatches a report-linked moderator action across all five
// kinds through one call, so the queue's act route carries no per-kind
// branching of its own. Every branch sets report_id on the ledger row.
func (s *ModerationService) ActOnReport(ctx context.Context, p ActOnReportParams) error {
	reportID := p.ReportID
	switch p.Kind {
	case "warning":
		_, err := s.Warn(ctx, p.ActorID, p.TargetID, p.Reason, &reportID)
		return err
	case "timeout":
		_, err := s.Timeout(ctx, p.ActorID, p.TargetID, p.Reason, time.Duration(p.DurationSeconds)*time.Second, &reportID)
		return err
	case "kick":
		return s.forceLogout(ctx, p.ActorID, p.TargetID, &reportID)
	case "ban":
		return s.banUser(ctx, p.ActorID, p.TargetID, p.Reason, nil, &reportID)
	case "removal":
		if s.messages == nil {
			return fmt.Errorf("%w: message removal unavailable", ErrInternal)
		}
		_, err := s.messages.DeleteMessageForReport(ctx, p.ActorID, p.MessageID, p.ReportID)
		return err
	default:
		return fmt.Errorf("%w: invalid kind", ErrBadRequest)
	}
}

// BanUser bans a target user. Validates the target exists and
// prevents self-banning.
func (s *ModerationService) BanUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time) error {
	return s.banUser(ctx, actorID, targetID, reason, expires, nil)
}

// BanUserWithReport is BanUser with a report link (plan item 2's
// "...WithReport variant" — BanUser's own signature is untouched, so
// admin/api.go and every other existing caller is unaffected).
func (s *ModerationService) BanUserWithReport(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time, reportID int64) error {
	return s.banUser(ctx, actorID, targetID, reason, expires, &reportID)
}

func (s *ModerationService) banUser(ctx context.Context, actorID, targetID int64, reason string, expires *time.Time, reportID *int64) error {
	ctx, span := telemetry.GlobalTracer("service/moderation").Start(ctx, "ModerationService.BanUser",
		telemetry.Int64("actor_id", actorID),
		telemetry.Int64("target_id", targetID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "BanUser"))
		span.End()
	}()

	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot ban yourself", ErrBadRequest)
	}

	// Authorization before existence: an actor without ban authority learns
	// nothing about which user ids exist.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
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

	// Audit rows must survive a request canceled after the ban committed.
	// The detail is a fixed phrase, never the reason text (B5-9 review):
	// the reason is already durable on users.ban_reason for any
	// AdminPerimeter holder to read, so the audit trail does not need a
	// second, unbounded copy of free text that could quote a message.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_ban", "user", targetID, "user banned")

	slog.Info("user banned", "actor_id", actorID, "target_id", targetID, "reason", reason)
	return nil
}

// AuthorizeRoleChange runs every ChangeUserRole precondition — MANAGE_ROLES,
// target existence, the actor-outranks-target rule, role existence, and the
// assign-below-own-rank rule — without mutating anything, and in the same
// authorization-before-existence order as every other check in this file (see
// BanUser): an actor without MANAGE_ROLES learns nothing about which user ids
// exist. It exists so a caller that also performs another mutation in the
// same request (the admin PATCH /users/{id} handler, which can ban and
// role-change in one call) can authorize the role change *before* committing
// the other mutation: checking only at ChangeUserRole time means a refused
// role change is discovered only after the ban already landed, leaving a
// "failed" request half-applied (OC-0215). It returns the validated actor
// role, target user, and target role so callers that go on to commit (like
// ChangeUserRole) don't need to re-fetch any of them.
func (s *ModerationService) AuthorizeRoleChange(ctx context.Context, actorID, targetID, newRoleID int64) (actorRole *db.Role, target *db.User, newRole *db.Role, err error) {
	if targetID <= 0 {
		return nil, nil, nil, fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return nil, nil, nil, fmt.Errorf("%w: cannot change your own role", ErrBadRequest)
	}

	// Authorization before existence — see BanUser.
	actorRole, err = s.requirePerm(ctx, actorID, permissions.ManageRoles)
	if err != nil {
		return nil, nil, nil, err
	}
	target, err = s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return nil, nil, nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return nil, nil, nil, err
	}

	newRole, err = s.st.GetRoleByID(ctx, newRoleID)
	if err != nil || newRole == nil {
		return nil, nil, nil, fmt.Errorf("%w: role not found", ErrBadRequest)
	}
	// Administrator bypasses permission bits, never the hierarchy: the owner
	// role is above every admin, so only the owner can grant it.
	if newRole.Position >= actorRole.Position {
		return nil, nil, nil, fmt.Errorf("%w: cannot assign a role at or above your own rank", ErrForbidden)
	}
	return actorRole, target, newRole, nil
}

// ChangeUserRole assigns newRoleID to the target user. It enforces
// MANAGE_ROLES plus two hierarchy rules the admin panel previously had none
// of: the actor must strictly outrank the target, and may not hand out a role
// positioned at or above their own — otherwise any admin could promote anyone
// (including themselves via a second account) to Owner.
//
// It returns the role that was assigned so callers (the member_update
// broadcast and visibility refresh, in particular) can use it directly
// instead of re-reading it: a re-read is racing a possible concurrent role
// delete for no reason, since this call already loaded and validated the
// exact same row under the same request.
func (s *ModerationService) ChangeUserRole(ctx context.Context, actorID, targetID, newRoleID int64) (*db.Role, error) {
	_, target, newRole, err := s.AuthorizeRoleChange(ctx, actorID, targetID, newRoleID)
	if err != nil {
		return nil, err
	}

	if err := s.st.UpdateUserRole(ctx, targetID, newRoleID); err != nil {
		return nil, fmt.Errorf("%w: failed to update role: %w", ErrInternal, err)
	}
	// Drop the target's cached role immediately: without this a demotion keeps
	// granting the old bits (and the old rank) for up to permCacheTTL.
	s.perms.InvalidateUser(targetID)

	// Audit rows must survive a request canceled after the update committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_change", "user", targetID,
		fmt.Sprintf("changed %s role to %s", target.Username, newRole.Name))

	slog.Info("role changed", "actor_id", actorID, "target_id", targetID, "new_role_id", newRoleID)
	return newRole, nil
}

// ForceLogout revokes every session of the target user (the client's "Kick"
// — OwnCord is single-server, so "remove from guild" has no referent; this
// is the real meaning of kick). Gated on KICK_MEMBERS plus the same
// hierarchy rule as ban, so a moderator cannot log out an admin or the
// owner.
func (s *ModerationService) ForceLogout(ctx context.Context, actorID, targetID int64) error {
	return s.forceLogout(ctx, actorID, targetID, nil)
}

// ForceLogoutWithReport is ForceLogout with a report link (plan item 2's
// "...WithReport variant"; ForceLogout's own signature is unchanged).
func (s *ModerationService) ForceLogoutWithReport(ctx context.Context, actorID, targetID int64, reportID int64) error {
	return s.forceLogout(ctx, actorID, targetID, &reportID)
}

func (s *ModerationService) forceLogout(ctx context.Context, actorID, targetID int64, reportID *int64) error {
	if err := requireHumanActor(actorID); err != nil {
		return err
	}
	if targetID <= 0 {
		return fmt.Errorf("%w: user_id must be positive", ErrBadRequest)
	}
	if actorID == targetID {
		return fmt.Errorf("%w: cannot force-logout yourself", ErrBadRequest)
	}

	// Authorization before existence — see BanUser.
	actorRole, err := s.requirePerm(ctx, actorID, permissions.KickMembers)
	if err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranksRole(ctx, actorRole, targetID); err != nil {
		return err
	}

	if _, err := s.st.ForceLogoutWithAction(ctx, targetID, actorID, reportID); err != nil {
		if errors.Is(err, db.ErrOutranked) {
			return fmt.Errorf("%w: cannot moderate a user of equal or higher rank", ErrForbidden)
		}
		return fmt.Errorf("%w: failed to log out user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the sessions were cut.
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

	// Authorization before existence — see BanUser.
	if err := s.requireBanPermission(ctx, actorID); err != nil {
		return err
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil || target == nil {
		return fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.requireOutranks(ctx, actorID, targetID); err != nil {
		return err
	}

	if err := s.st.UnbanUser(ctx, targetID); err != nil {
		return fmt.Errorf("%w: failed to unban user: %w", ErrInternal, err)
	}

	// Audit rows must survive a request canceled after the unban committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "user_unban", "user", targetID, "")

	slog.Info("user unbanned", "actor_id", actorID, "target_id", targetID)
	return nil
}

// ListActionsForTarget is GET /api/v1/moderation/users/{id}/actions:
// MODERATE_MEMBERS gates the read, the same bit as the report queue.
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

// ListActionsForReport is the queue detail's "actions taken" list (plan
// item 7). No permission check of its own — the caller
// (ReportService.Get) has already gated the read with requireModerate,
// guardConfidentiality and guardSelfReview.
func (s *ModerationService) ListActionsForReport(ctx context.Context, reportID int64) ([]db.ModerationAction, error) {
	rows, err := s.st.ListModerationActionsForReport(ctx, reportID)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInternal, err)
	}
	return rows, nil
}

// AcknowledgeWarning marks actionID acknowledged for userID — own rows
// only (POST /api/v1/users/me/notices/{id}/ack, session auth). ErrNotFound
// covers a foreign id, an already-acknowledged one, and a non-warning id
// alike, so this route can never be used to probe another user's warning
// ids.
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
