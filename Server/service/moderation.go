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
)

type moderationStore interface {
	moderationCoreStore
	moderationHistoryStore
}

type moderationCoreStore interface {
	db.Auditor
	subjectStore
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	UpdateUserRole(ctx context.Context, userID, roleID int64) error
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	GetVoiceState(ctx context.Context, userID int64) (*db.VoiceState, error)
	// WarnUser/TimeoutUser write their effect as one ledger row in one transaction with the live rank guard: a
	// target promoted after the caller's check is refused (db.ErrOutranked).
	WarnUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error)
	// TimeoutUser also returns the ids it superseded, for the voice mute's ownership transfer.
	TimeoutUser(ctx context.Context, targetID, actorID int64, reportID *int64, reason string, expiresAt time.Time) (id int64, supersededIDs []int64, err error)
	// LiftTimeout returns the lifted ids for ClearServerMuteOwnedBy (ownership lives on the voice session).
	LiftTimeout(ctx context.Context, targetID, actorID int64) (liftedIDs []int64, err error)
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
	BanUserWithAction(ctx context.Context, targetID int64, reason string, expires *time.Time, actorID int64, reportID *int64) (int64, error)
	ForceLogoutWithAction(ctx context.Context, targetID, actorID int64, reportID *int64, reason string) (int64, error)
	RecordRemovalAction(ctx context.Context, targetID, actorID int64, reason string) error
	UnbanUser(ctx context.Context, id int64) error
}

// ModerationService handles user ban, unban, warn, timeout and erasure operations.
type ModerationService struct {
	*moderationHistory
	st    moderationCoreStore
	perms *PermissionService
	// erasure runs the administrator's account erasure; nil fails EraseUser closed.
	erasure *ErasureService
	// messages serves only the report-linked removal, not a second copy of DeleteMessage's authorization.
	messages *MessageService
	// users performs the moderator nickname write under the target's profile lock; nil fails SetNickname closed.
	users *UserService
	// notifier delivers a live mod_action frame to a connected target; nil is a no-op.
	notifier     ModActionNotifier
	permNotifier PermissionChangeNotifier
	// voiceMuter applies or lifts the voice half of a timeout; nil is a no-op.
	voiceMuter     TimeoutVoiceMuter
	limiter        *auth.RateLimiter
	banPurgeSem    chan struct{}
	banPurgeRowCap int
}

// ModActionNotifier delivers a live mod_action frame to a connected target.
type ModActionNotifier interface {
	NotifyModAction(userID, actionID int64, kind, reason string, expiresAt *time.Time)
}

// TimeoutVoiceMuter is the voice-hub surface Timeout/LiftTimeout use. A mute with no live voice connection is
// a silent no-op.
type TimeoutVoiceMuter interface {
	// MuteForTimeout mutes userID in the EXACT session actorCanModerateVoiceFor authorized (not a fresh re-read
	// that could resolve another), stamping actionID as owner atomically with the DB write under a per-user lock
	// shared with the manual voice-mute endpoint. applied is false for every no-op path; owned is true only when
	// THIS call caused the unmuted-to-muted transition. supersededIDs hand ownership to actionID INSIDE that
	// lock: transferring outside it could land between another action's DB write and SFU call, so its rollback
	// would miss the row.
	MuteForTimeout(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (applied, owned bool)
	// UnmuteForTimeout clears the mute owned by any of actionIDs; session-bound, so a stale id cannot clear a
	// restarted session. Reports whether anything was cleared.
	UnmuteForTimeout(ctx context.Context, userID int64, actionIDs []int64) bool
}

// NewModerationService creates a ModerationService.
func NewModerationService(st moderationStore, perms *PermissionService) *ModerationService {
	return &ModerationService{moderationHistory: &moderationHistory{st: st}, st: st, perms: perms, banPurgeSem: make(chan struct{}, 1)}
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

// ErasureBroadcastsMemberBan reports whether the erasure runner sends member_ban itself; the transport sends
// its own only when it does not.
func (s *ModerationService) ErasureBroadcastsMemberBan() bool {
	return s.erasure != nil && s.erasure.BroadcastsMemberBan()
}

// EraseUser is the administrator-initiated account erasure (same implementation as self-deletion), gated on
// ERASE_ACCOUNTS plus actor-outranks-target. An actor cannot erase itself here and the last admin-class
// account is Forbidden. The transport broadcasts member_ban.
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
			slog.Warn("admin erasure: files pending", "actor_id", actorID, "target_id", targetID, "err", err)
		case errors.Is(err, ErrErasureInProgress):
			slog.Info("admin erasure: in progress", "actor_id", actorID, "target_id", targetID)
		default:
			slog.Error("admin erasure failed", "actor_id", actorID, "target_id", targetID, "err", err)
			return fmt.Errorf("%w: failed to erase account", ErrInternal)
		}
	}

	// Audit rows must survive a request canceled after the erasure committed; the target is the marker's token,
	// never the id.
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		ActorID: actorID, Action: "account_deleted", TargetType: "user", Detail: "account erased by administrator",
		SubjectToken: s.erasure.SubjectToken(targetID),
	})

	slog.Info("account erased by administrator", "actor_id", actorID, "target_id", targetID)
	return nil
}

// Warn issues a warning: MODERATE_MEMBERS, target exists, not self, requireOutranks, then the ledger and
// audit rows. The audit detail is a fixed phrase, never the reason (shown to the target; the audit log is
// operator-facing). reportID links a report-linked warning.
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

// ActOnReportParams is the input for POST /api/v1/moderation/queue/{public_id}/act.
type ActOnReportParams struct {
	ActorID         int64
	Kind            string // "warning" | "timeout" | "kick" | "ban" | "removal"
	Reason          string
	DurationSeconds int64 // timeout only
	TargetID        int64 // warning/timeout/kick/ban: the report's subject
	MessageID       int64 // removal: the reported message
	ReportID        int64
}

// ActOnReportResult is ActOnReport's outcome: enough for the act route to send the same transport
// broadcasts the direct routes send.
type ActOnReportResult struct {
	Kind string
	// TargetID is the sanctioned user; zero for removal, whose ledger target is the actor (see recordLedgerRow).
	TargetID  int64
	Voice     string
	ChannelID int64
	MessageID int64
}

// ActOnReport dispatches a report-linked moderator action across all five kinds, each calling its
// direct-route sibling with report_id set. validateActionReason runs once up front, since kick and removal do
// not validate their own.
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
	// Administrator bypasses permission bits, never the hierarchy: only the owner can grant a role at or above
	// an admin.
	if newRole.Position >= actorRole.Position {
		return nil, nil, nil, fmt.Errorf("%w: cannot assign a role at or above your own rank", ErrForbidden)
	}
	// A role with an owner-grant-only bit (MOVE_MEMBERS) needs the owner, an Administrator, or an actor holding
	// every such bit.
	if err := requireOwnerGrantOnlyAssign(actorRole, newRole.Permissions); err != nil {
		return nil, nil, nil, err
	}
	return actorRole, target, newRole, nil
}

// ChangeUserRole assigns newRoleID. It enforces MANAGE_ROLES, that the actor strictly outranks the target,
// and that the actor may not hand out a role at or above their own (else any admin could promote anyone,
// including themselves via a second account, to Owner). It returns the assigned role to avoid a re-read
// racing a role delete.
func (s *ModerationService) ChangeUserRole(ctx context.Context, actorID, targetID, newRoleID int64) (*db.Role, error) {
	_, target, newRole, err := s.AuthorizeRoleChange(ctx, actorID, targetID, newRoleID)
	if err != nil {
		return nil, err
	}

	if err := s.st.UpdateUserRole(ctx, targetID, newRoleID); err != nil {
		return nil, fmt.Errorf("%w: failed to update role: %w", ErrInternal, err)
	}
	// Drop the cached role now: a demotion would otherwise keep the old bits and rank for up to permCacheTTL.
	s.perms.InvalidateUser(targetID)

	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "role_change", "user", targetID,
		fmt.Sprintf("changed %s role to %s", target.Username, newRole.Name))

	slog.Info("role changed", "actor_id", actorID, "target_id", targetID, "new_role_id", newRoleID)
	s.roleAssigned(targetID)
	return newRole, nil
}
