package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// userStore is what UserService reads and writes. *db.DB satisfies it.
type userStore interface {
	connWritesStore
	db.Auditor
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	ListPendingUsers(ctx context.Context, limit, offset int) ([]db.PendingUser, error)
	ApprovePendingUser(ctx context.Context, userID int64) error
	DenyPendingUser(ctx context.Context, userID int64) error
	UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error
	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	UpdateUserPassword(ctx context.Context, userID int64, newPasswordHash string) error
	UpdateUserIdentityKey(ctx context.Context, id int64, key *string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	SignOutEverywhere(ctx context.Context, userID int64) (sessions, tokens int64, err error)
	DeleteSessionByID(ctx context.Context, sessionID, userID int64) error
	ListUserSessions(ctx context.Context, userID int64) ([]db.Session, error)
	MarkSessionsSeen(ctx context.Context, userID, exceptSessionID int64) (int64, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	// HasActiveTimeout is the indexed per-user lookup (FinalizeTimeoutLift;
	// PermissionService.Subject reads its mirror).
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
	GetServerStats(ctx context.Context) (*db.ServerStats, error)
	ListAllUsers(ctx context.Context, f db.UserListFilter, limit, offset int) ([]db.UserWithRole, error)
}

// UserService handles user profile and session operations.
type UserService struct {
	st           userStore
	profileLocks keyedMutex
	// batch, when set, queues the connection stamps instead of writing them; nil
	// writes each at once (tests, the admin panel's instance).
	batch *ConnWrites
	// welcome greets an approved applicant; nil greets nobody.
	welcome *WelcomeService
}

// NewUserService creates a UserService.
func NewUserService(st userStore) *UserService {
	return &UserService{st: st}
}

// keyedMutex hands out a per-key lock so unrelated keys never contend. Keyed by
// user ID for UpdateProfile's read-merge-write: PATCH /users/me can race POST
// /users/me/avatar, and the loser would commit columns merged against a pre-race
// snapshot, reverting the winner. Entries are never removed; the key space is
// bounded by distinct user IDs.
type keyedMutex struct {
	mu    syncutil.Mutex
	locks map[int64]*syncutil.Mutex
}

func (k *keyedMutex) lock(key int64) func() {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = make(map[int64]*syncutil.Mutex)
	}
	l, ok := k.locks[key]
	if !ok {
		l = &syncutil.Mutex{}
		k.locks[key] = l
	}
	k.mu.Unlock()

	l.Lock()
	return l.Unlock
}

// AvatarFileURL is the server-relative path an uploaded avatar is served from:
// the ordinary attachment route, where handleServeFile admits an unlinked
// attachment that some user's avatar names. Defined once because the upload
// response, the stored column and the file route's authorization probe (which
// matches the column by string) must agree on the spelling.
func AvatarFileURL(fileID string) string {
	return "/api/v1/files/" + fileID
}

const (
	// MaxDisplayNameLen bounds users.display_name; 32 matches the username cap so a
	// nickname fits wherever the fallback puts the username.
	MaxDisplayNameLen = 32
	// MaxAboutLen bounds users.about.
	MaxAboutLen = 300
	// MaxCustomStatusLen bounds users.custom_status.
	MaxCustomStatusLen = 128
)

// ProfilePatch is a partial update. A nil field means "leave unchanged"; a
// pointer to "" clears the nullable fields. Free text is sanitized and
// length-checked here so every transport gets the same rules.
type ProfilePatch struct {
	Username    string
	Avatar      *string
	DisplayName *string
	About       *string
	// BannerID (upload handler only) and BannerColor (#rgb or #rrggbb): "" clears.
	BannerID    *string
	BannerColor *string
}

func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// cleanText strips HTML and trims a free-text profile field; callers run it
// before any bound check so markup cannot buy length. It uses
// sanitizeToFixpoint (message.go) because these fields render through the
// client's textContent-only path, where a single sanitizer pass would show
// literal &#39;/&gt;/&amp; entities for ordinary punctuation.
func cleanText(v string) string {
	return strings.TrimSpace(sanitizeToFixpoint(v))
}

// cleanTextBounded is cleanText plus a raw-byte guard for every free-text field
// that runs through cleanText. sanitizeToFixpoint is quadratic in input length,
// so bounding only its output lets a nested-entity payload cost seconds of CPU
// (and even sanitize under maxRunes and be accepted). The byte pre-check on the
// untouched input makes rejection O(len(v)). *4 is deliberately looser than
// maxRunes: it only keeps pathological payloads away from the sanitizer, and the
// real rune-count bound still runs on the cleaned value.
func cleanTextBounded(v string, maxRunes int, fieldName string) (string, error) {
	if len(v) > maxRunes*4 {
		return "", fmt.Errorf("%w: %s must be at most %d characters", ErrBadRequest, fieldName, maxRunes)
	}
	cleaned := cleanText(v)
	if utf8.RuneCountInString(cleaned) > maxRunes {
		return "", fmt.Errorf("%w: %s must be at most %d characters", ErrBadRequest, fieldName, maxRunes)
	}
	return cleaned, nil
}

func resolveOptional(patch *string, existing *string) *string {
	if patch == nil {
		return existing
	}
	return nullable(cleanText(*patch))
}

// UpdateProfile applies a ProfilePatch and returns the updated user.
func (s *UserService) UpdateProfile(ctx context.Context, userID int64, patch ProfilePatch) (*db.User, error) {
	ctx, done := traceCall(ctx, "service/user", "UserService.UpdateProfile",
		telemetry.Int64("user_id", userID),
	)
	defer done()

	// Bound the raw bytes before cleanText: see cleanTextBounded for why. *4 still
	// admits any legitimate UTF-8 value at the rune bound. The guard lives here, not
	// only in the REST handler, because every transport reaches UpdateProfile.
	if err := checkProfileByteBounds(patch); err != nil {
		return nil, err
	}

	// Display name is single-line visible text, capped like the custom status.
	var cleanDisplayName *string
	if patch.DisplayName != nil {
		cleaned, err := cleanVisibleBounded(*patch.DisplayName, MaxDisplayNameLen, "display_name")
		if err != nil {
			return nil, err
		}
		cleanDisplayName = &cleaned
	}
	if patch.About != nil && utf8.RuneCountInString(cleanText(*patch.About)) > MaxAboutLen {
		return nil, fmt.Errorf("%w: about must be at most %d characters", ErrBadRequest, MaxAboutLen)
	}

	cleanBannerColor, err := cleanBannerPatch(patch.BannerColor)
	if err != nil {
		return nil, err
	}

	// The update writes every column, so a partial patch is merged against the
	// current row (else a display-name-only patch would clear about). That
	// read-merge-write is serialized per user: PATCH /users/me and POST
	// /users/me/avatar race for one account, and an interleaved read would make the
	// second merge revert the first call's change.
	unlock := s.profileLocks.lock(userID)
	defer unlock()

	current, err := s.st.GetUserByID(ctx, userID)
	if err != nil || current == nil {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.checkTimedOutProfileEdit(ctx, userID, current, cleanDisplayName, patch.Username); err != nil {
		return nil, err
	}
	// An empty Username means "unspecified", like a nil pointer. That lets the avatar
	// upload leave username alone without a snapshot that could be stale; PATCH
	// /users/me rejects an empty username before calling in.
	username := patch.Username
	if username == "" {
		username = current.Username
	}
	avatar := current.Avatar
	if patch.Avatar != nil {
		avatar = nullable(*patch.Avatar)
	}
	displayName := current.DisplayName
	if cleanDisplayName != nil {
		displayName = nullable(*cleanDisplayName)
	}
	about := resolveOptional(patch.About, current.About)
	bannerID, bannerColor := mergeBanner(current, patch.BannerID, cleanBannerColor)

	if err := s.st.UpdateUserProfile(ctx, userID, username, avatar, displayName, about, bannerID, bannerColor); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("%w: username is already taken", ErrConflict)
		}
		return nil, fmt.Errorf("%w: failed to update profile: %w", ErrInternal, err)
	}
	// This re-read, like the audit write, must survive a request ctx canceled after
	// the commit: otherwise a hang-up turns a successful write into ErrInternal,
	// handleUpdateProfile never broadcasts, and other clients show the stale profile.
	user, err := s.st.GetUserByID(context.WithoutCancel(ctx), userID)
	if err != nil {
		// The write committed, so a failing re-read (SQLITE_BUSY, I/O error, pool
		// exhaustion) must not be ErrInternal: handleUploadAvatar treats any error as
		// "the write never landed" and deletes the file the committed avatar now points
		// at. UpdateUserProfile writes only username, avatar, display_name, about and the
		// banner, so merging those onto the pre-write snapshot reconstructs the row.
		slog.Error("UpdateProfile post-commit re-read failed; returning locally merged row",
			"user_id", userID, "error", err)
		merged := *current
		merged.Username = username
		merged.Avatar = avatar
		merged.DisplayName = displayName
		merged.About = about
		merged.BannerID, merged.BannerColor = bannerID, bannerColor
		user = &merged
	}
	// Audit rows must survive a request canceled after the write committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "profile_update", "user", userID,
		fmt.Sprintf("username=%s", username)+displayNameAuditSuffix(current.DisplayName, displayName))
	slog.Info("profile updated", "user_id", userID, "username", username)
	return user, nil
}

// SetCustomStatus stores (or clears, with "") the custom status. It persists across
// reconnects and is cleared on logout, so it is stored, not held on the connection.
func (s *UserService) SetCustomStatus(ctx context.Context, userID int64, text string) error {
	cleaned, err := cleanVisibleBounded(text, MaxCustomStatusLen, "custom_status")
	if err != nil {
		return err
	}
	if err := s.st.UpdateUserCustomStatus(ctx, userID, nullable(cleaned)); err != nil {
		return fmt.Errorf("%w: failed to update custom status: %w", ErrInternal, err)
	}
	return nil
}

// ClearCustomStatus wipes the custom status on logout: a "right now" note left
// standing after sign-out would state something no longer true.
func (s *UserService) ClearCustomStatus(ctx context.Context, userID int64) error {
	if err := s.st.UpdateUserCustomStatus(ctx, userID, nil); err != nil {
		return fmt.Errorf("%w: failed to clear custom status: %w", ErrInternal, err)
	}
	return nil
}

// UpdateIdentityKey publishes the user's E2EE identity public key (voice E2EE
// TOFU). Last write wins; every write is audited so a rotation, which peers
// surface as a TOFU mismatch, leaves a trail.
func (s *UserService) UpdateIdentityKey(ctx context.Context, userID int64, key string) (*db.User, error) {
	if err := s.st.UpdateUserIdentityKey(ctx, userID, &key); err != nil {
		return nil, fmt.Errorf("%w: failed to update identity key: %w", ErrInternal, err)
	}
	// Detached like UpdateProfile's re-read: a canceled ctx must not turn a
	// successful rotation into ErrInternal and stop the broadcast peers pin on.
	user, err := s.st.GetUserByID(context.WithoutCancel(ctx), userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch updated user: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "identity_key_update", "user", userID, "")
	slog.Info("identity key published", "user_id", userID)
	return user, nil
}

// ChangePasswordResult reports a completed password change. RevokeFailed means
// the password committed but other sessions could not be revoked: surface it as a
// warning, never a 5xx, since the old password is already dead and a "failed"
// answer would walk the user into retrying with it and tripping the lockout.
type ChangePasswordResult struct {
	SessionsRevoked int64
	RevokeFailed    bool
}

// ChangePassword updates the user's password and revokes other sessions.
func (s *UserService) ChangePassword(ctx context.Context, userID int64, newPasswordHash string, keepSessionID int64) (ChangePasswordResult, error) {
	if err := s.st.UpdateUserPassword(ctx, userID, newPasswordHash); err != nil {
		return ChangePasswordResult{}, fmt.Errorf("%w: failed to update password: %w", ErrInternal, err)
	}

	// The password is committed: every path below reports success and audits, even
	// on a canceled ctx, as revocation and audit are the security tail of the change.
	tailCtx := context.WithoutCancel(ctx)

	var res ChangePasswordResult
	revoked, err := s.st.DeleteOtherSessions(tailCtx, userID, keepSessionID)
	res.SessionsRevoked = revoked
	if err != nil {
		slog.Error("UserService.ChangePassword DeleteOtherSessions", "err", err, "user_id", userID)
		// One immediate retry covers transient write-lock contention; add backoff only if
		// logs show it.
		if revokedRetry, retryErr := s.st.DeleteOtherSessions(tailCtx, userID, keepSessionID); retryErr == nil {
			res.SessionsRevoked += revokedRetry
		} else {
			res.RevokeFailed = true
		}
	}
	db.WriteAudit(tailCtx, s.st, userID, "password_change", "user", userID, "password changed")
	slog.Info("password changed", "user_id", userID,
		"sessions_revoked", res.SessionsRevoked, "revoke_failed", res.RevokeFailed)
	return res, nil
}

// ListPendingRegistrations is the approval queue, oldest first.
func (s *UserService) ListPendingRegistrations(ctx context.Context, limit, offset int) ([]db.PendingUser, error) {
	pending, err := s.st.ListPendingUsers(ctx, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list pending registrations: %w", ErrInternal, err)
	}
	return pending, nil
}

// ApproveRegistration unlocks an approval-mode application so the account can
// sign in. ErrNotFound when the id is not pending.
func (s *UserService) ApproveRegistration(ctx context.Context, actorID, userID int64) error {
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
func (s *UserService) DenyRegistration(ctx context.Context, actorID, userID int64) error {
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

// ListSessions returns all active sessions for a user.
func (s *UserService) ListSessions(ctx context.Context, userID int64) ([]db.Session, error) {
	sessions, err := s.st.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list sessions: %w", ErrInternal, err)
	}
	return sessions, nil
}

// MarkSessionsSeen acknowledges the account's unseen logins: every other
// session's flag clears, the caller's own stays so the new device never
// acknowledges itself. An API-token principal passes 0 and acknowledges all. No
// audit row; nothing security-sensitive changes.
func (s *UserService) MarkSessionsSeen(ctx context.Context, userID, callerSessionID int64) error {
	if _, err := s.st.MarkSessionsSeen(ctx, userID, callerSessionID); err != nil {
		return fmt.Errorf("%w: failed to acknowledge sessions: %w", ErrInternal, err)
	}
	return nil
}

// RevokeSession deletes a specific session owned by the user.
func (s *UserService) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	if err := s.st.DeleteSessionByID(ctx, sessionID, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: session not found", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to revoke session: %w", ErrInternal, err)
	}
	// Audit rows must survive a request canceled after the commit.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "session_revoke", "session", sessionID, "session revoked")
	slog.Info("session revoked", "user_id", userID, "session_id", sessionID)
	return nil
}

// RevokeAllSessions is sign-out-everywhere: every session, the caller's included,
// and every API token, so a stolen credential stops working now. Returns the
// sessions revoked.
func (s *UserService) RevokeAllSessions(ctx context.Context, userID int64) (int64, error) {
	n, tokens, err := s.st.SignOutEverywhere(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("%w: failed to revoke sessions: %w", ErrInternal, err)
	}
	if n == 0 && tokens == 0 {
		// Nothing changed, so nothing to audit; a repeat cannot grow the audit log.
		slog.Debug("sign-out-everywhere found nothing to revoke", "user_id", userID)
		return 0, nil
	}
	// Audit rows must survive a request canceled after the commit. The row names the
	// account and counts, never a token or device.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "session_revoke_all", "user", userID,
		fmt.Sprintf("signed out everywhere (%d sessions, %d API tokens revoked)", n, tokens))
	slog.Info("all sessions revoked", "user_id", userID, "sessions_revoked", n, "api_tokens_revoked", tokens)
	return n, nil
}

// ServerStats returns the admin dashboard counters. The live connection count is
// hub state; the caller stamps it afterwards.
func (s *UserService) ServerStats(ctx context.Context) (*db.ServerStats, error) {
	stats, err := s.st.GetServerStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to get stats: %w", ErrInternal, err)
	}
	return stats, nil
}

// ListAll returns one page of users matching f with role names, in id order. The
// caller bounds limit and offset; this does not re-bound them.
func (s *UserService) ListAll(ctx context.Context, f db.UserListFilter, limit, offset int) ([]db.UserWithRole, error) {
	users, err := s.st.ListAllUsers(ctx, f, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list users: %w", ErrInternal, err)
	}
	return users, nil
}

// Get resolves one user, reporting a missing row as ErrNotFound rather than
// (nil, nil), so callers can tell 404 from 500.
func (s *UserService) Get(ctx context.Context, id int64) (*db.User, error) {
	user, err := s.st.GetUserByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch user: %w", ErrInternal, err)
	}
	if user == nil || user.IsSystemAccount() {
		return nil, fmt.Errorf("user not found%.0w", ErrNotFound)
	}
	return user, nil
}

// GetWithRoleName is Get plus the user's role display name. The name is
// best-effort: a missing or unreadable role row comes back as "" rather than
// failing a user the panel must still be able to show.
func (s *UserService) GetWithRoleName(ctx context.Context, id int64) (*db.User, string, error) {
	user, err := s.Get(ctx, id)
	if err != nil {
		return nil, "", err
	}
	roleName := ""
	if role, roleErr := s.st.GetRoleByID(ctx, user.RoleID); roleErr == nil && role != nil {
		roleName = role.Name
	}
	return user, roleName, nil
}

// StampConnect records the status this session comes online as and returns it. It
// is db.ConnectStatus(saved), not a flat "online", which made a saved Do Not
// Disturb flash back to online on every reconnect: idle/dnd/invisible survive,
// anything else becomes online. It writes even when unchanged, to refresh
// last_seen.
//
// With a batch the write is queued and lands within StampFlushInterval. The member
// list does not wait on it (the hub overlays each connection's live status), but
// a reader of the row itself may see the pre-connect value that long. The SQL
// re-derives the status at write time, which keeps a chosen idle/dnd/invisible
// committed meanwhile but would turn a legacy "offline" into online, so a
// committed presence_update drops the pending stamp
// (ChannelService.HandlePresenceUpdate); a flush already in flight can still land
// once, affecting only that legacy value.
//
// The caller must not cache the returned status unless the error is nil.
func (s *UserService) StampConnect(ctx context.Context, userID int64, savedStatus string) (string, error) {
	status := db.ConnectStatus(savedStatus)
	if s.batch != nil {
		s.batch.queueStamp(userID, true)
		return status, nil
	}
	if err := s.st.StampConnections(ctx, []int64{userID}, nil); err != nil {
		return "", fmt.Errorf("%w: failed to stamp connect status: %w", ErrInternal, err)
	}
	return status, nil
}

// StampDisconnect records that the user has no live connection left. It clears
// only the non-choice "online" and refreshes last_seen; a chosen idle/dnd/invisible
// stays for StampConnect to read back. The stale choice is handled at read time:
// a member with no live connection renders offline. A batched stamp lost to a
// crash leaves "online", which the boot-time ResetAllUserStatuses clears.
func (s *UserService) StampDisconnect(ctx context.Context, userID int64) error {
	if s.batch != nil {
		s.batch.queueStamp(userID, false)
		return nil
	}
	if err := s.st.StampConnections(ctx, nil, []int64{userID}); err != nil {
		return fmt.Errorf("%w: failed to stamp disconnect: %w", ErrInternal, err)
	}
	return nil
}

// SetConnWrites installs the batch the connection stamps queue into. Call once at
// startup, before the service is shared.
func (s *UserService) SetConnWrites(w *ConnWrites) { s.batch = w }
