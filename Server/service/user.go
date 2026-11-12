package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

type userStore interface {
	userCoreStore
	userSessionStore
	registrationQueueStore
}

type userCoreStore interface {
	connWritesStore
	db.Auditor
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	UpdateUserProfile(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string) error
	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	UpdateUserPassword(ctx context.Context, userID int64, newPasswordHash string) error
	UpdateUserProfileAndIdentityKey(ctx context.Context, userID int64, username string, avatar, displayName, about, bannerID, bannerColor *string, identityKey string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	RevokeUserAPITokens(ctx context.Context, userID int64) (int64, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
	GetServerStats(ctx context.Context) (*db.ServerStats, error)
	ListAllUsers(ctx context.Context, f db.UserListFilter, limit, offset int) ([]db.UserWithRole, error)
}

// UserService handles user profile and session operations.
type UserService struct {
	*userSessions
	*registrationQueue
	st           userCoreStore
	profileLocks keyedMutex
	batch        *ConnWrites
}

// NewUserService creates a UserService.
func NewUserService(st userStore) *UserService {
	return &UserService{
		userSessions:      &userSessions{st: st},
		registrationQueue: &registrationQueue{st: st},
		st:                st,
	}
}

// keyedMutex hands out a per-key lock so unrelated keys never contend. Keyed by user ID for UpdateProfile's
// read-merge-write: PATCH /users/me can race POST /users/me/avatar, and the loser would revert the winner.
// Entries are never removed; the key space is bounded by distinct user IDs.
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

// AvatarFileURL is the server-relative path an uploaded avatar is served from. Defined once because the
// upload response, the stored column and the file route's authorization probe (which matches the column by
// string) must agree.
func AvatarFileURL(fileID string) string {
	return "/api/v1/files/" + fileID
}

const (
	// MaxDisplayNameLen bounds users.display_name; 32 matches the username cap so a nickname fits wherever the
	// fallback puts the username.
	MaxDisplayNameLen = 32
	// MaxAboutLen bounds users.about.
	MaxAboutLen = 300
	// MaxCustomStatusLen bounds users.custom_status.
	MaxCustomStatusLen = 128
)

// ProfilePatch is a partial update. A nil field means "leave unchanged"; a pointer to "" clears the nullable
// fields. Free text is sanitized and length-checked here so every transport gets the same rules.
type ProfilePatch struct {
	Username    string
	Avatar      *string
	DisplayName *string
	About       *string
	BannerID    *string
	BannerColor *string
	// IdentityKey, when set, publishes an already validated E2EE identity public key in the same transaction as
	// the profile columns.
	IdentityKey *string
}

func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// cleanText strips HTML and trims a free-text profile field; callers run it before any bound check so markup
// cannot buy length. It uses sanitizeToFixpoint (message.go) because these fields render through the client's
// textContent-only path, where a single pass would show literal &#39;/&gt;/&amp;.
func cleanText(v string) string {
	return strings.TrimSpace(sanitizeToFixpoint(v))
}

// cleanTextBounded is cleanText plus a raw-byte guard: sanitizeToFixpoint is quadratic in input length, so
// bounding only its output lets a nested-entity payload cost seconds of CPU. The byte pre-check on the
// untouched input makes rejection O(len(v)). *4 is deliberately looser than maxRunes; the real rune bound
// still runs on the cleaned value.
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

	// Raw bytes are bounded before cleanText (see cleanTextBounded); the guard lives here because every
	// transport reaches UpdateProfile.
	if err := checkProfileByteBounds(patch); err != nil {
		return nil, err
	}

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

	// The update writes every column, so a partial patch is merged against the current row, serialized per user:
	// PATCH /users/me and POST /users/me/avatar race for one account, and an interleaved read would make the
	// second merge revert the first.
	unlock := s.profileLocks.lock(userID)
	defer unlock()

	current, err := s.st.GetUserByID(ctx, userID)
	if err != nil || current == nil {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	if err := s.checkTimedOutProfileEdit(ctx, userID, current, cleanDisplayName, patch.Username); err != nil {
		return nil, err
	}
	// An empty Username means "unspecified", like a nil pointer, so the avatar upload can leave username alone
	// without a stale snapshot; PATCH /users/me rejects an empty username before calling in.
	next := *current
	if patch.Username != "" {
		next.Username = patch.Username
	}
	if patch.Avatar != nil {
		next.Avatar = nullable(*patch.Avatar)
	}
	if cleanDisplayName != nil {
		next.DisplayName = nullable(*cleanDisplayName)
	}
	next.About = resolveOptional(patch.About, current.About)
	next.BannerID, next.BannerColor = mergeBanner(current, patch.BannerID, cleanBannerColor)
	if patch.IdentityKey != nil {
		next.IdentityPublicKey = patch.IdentityKey
	}

	if err := s.writeProfile(ctx, &next, patch.IdentityKey); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("%w: username is already taken", ErrConflict)
		}
		return nil, fmt.Errorf("%w: failed to update profile: %w", ErrInternal, err)
	}
	// This re-read, like the audit write, must survive a request ctx canceled after the commit: otherwise a
	// hang-up turns a successful write into ErrInternal and other clients show the stale profile.
	user, err := s.st.GetUserByID(context.WithoutCancel(ctx), userID)
	if err != nil {
		// The write committed, so a failing re-read must not be ErrInternal: handleUploadAvatar treats any error as
		// "the write never landed" and deletes the file the committed avatar points at. The write touches only the
		// columns merged into next, so next is the row.
		slog.Error("UpdateProfile post-commit re-read failed; returning locally merged row",
			"user_id", userID, "error", err)
		user = &next
	}
	s.auditProfileUpdate(ctx, current, &next, patch.IdentityKey != nil)
	return user, nil
}

// auditProfileUpdate records a committed profile write; audit rows must survive a request canceled after the
// commit.
func (s *UserService) auditProfileUpdate(ctx context.Context, current, next *db.User, keyWritten bool) {
	ctx = context.WithoutCancel(ctx)
	db.WriteAudit(ctx, s.st, next.ID, "profile_update", "user", next.ID,
		fmt.Sprintf("username=%s", next.Username)+displayNameAuditSuffix(current.DisplayName, next.DisplayName))
	if keyWritten {
		db.WriteAudit(ctx, s.st, next.ID, "identity_key_update", "user", next.ID, "")
		slog.Info("identity key published", "user_id", next.ID)
	}
	slog.Info("profile updated", "user_id", next.ID, "username", next.Username)
}

func (s *UserService) writeProfile(ctx context.Context, u *db.User, identityKey *string) error {
	if identityKey == nil {
		if err := s.st.UpdateUserProfile(ctx, u.ID, u.Username, u.Avatar, u.DisplayName, u.About, u.BannerID, u.BannerColor); err != nil {
			return fmt.Errorf("write profile: %w", err)
		}
		return nil
	}
	if err := s.st.UpdateUserProfileAndIdentityKey(ctx, u.ID, u.Username, u.Avatar, u.DisplayName, u.About, u.BannerID, u.BannerColor, *identityKey); err != nil {
		return fmt.Errorf("write profile and identity key: %w", err)
	}
	return nil
}

// SetCustomStatus stores (or clears, with "") the custom status.
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

// ClearCustomStatus wipes the custom status on logout: a "right now" note would otherwise outlive the
// sign-out.
func (s *UserService) ClearCustomStatus(ctx context.Context, userID int64) error {
	if err := s.st.UpdateUserCustomStatus(ctx, userID, nil); err != nil {
		return fmt.Errorf("%w: failed to clear custom status: %w", ErrInternal, err)
	}
	return nil
}

// ChangePasswordResult reports a completed password change. RevokeFailed means the password committed but
// other sessions, or the API tokens the caller asked to revoke, could not be revoked: surface a warning,
// never a 5xx, since the old password is dead and a "failed" answer would send the user retrying with it and
// tripping the lockout.
type ChangePasswordResult struct {
	SessionsRevoked int64
	TokensRevoked   int64
	RevokeFailed    bool
}

// ChangePassword updates the password and revokes other sessions (and every API token when revokeTokens is
// set).
func (s *UserService) ChangePassword(ctx context.Context, userID int64, newPasswordHash string, keepSessionID int64, revokeTokens bool) (ChangePasswordResult, error) {
	if err := s.st.UpdateUserPassword(ctx, userID, newPasswordHash); err != nil {
		return ChangePasswordResult{}, fmt.Errorf("%w: failed to update password: %w", ErrInternal, err)
	}

	// The password is committed: below, report success and audit even on a canceled ctx (the security tail).
	tailCtx := context.WithoutCancel(ctx)

	var res ChangePasswordResult
	revoked, err := s.st.DeleteOtherSessions(tailCtx, userID, keepSessionID)
	res.SessionsRevoked = revoked
	if err != nil {
		slog.Error("UserService.ChangePassword DeleteOtherSessions", "err", err, "user_id", userID)
		if revokedRetry, retryErr := s.st.DeleteOtherSessions(tailCtx, userID, keepSessionID); retryErr == nil {
			res.SessionsRevoked += revokedRetry
		} else {
			res.RevokeFailed = true
		}
	}
	if revokeTokens {
		tokens, tokErr := s.st.RevokeUserAPITokens(tailCtx, userID)
		if tokErr != nil {
			slog.Error("UserService.ChangePassword RevokeUserAPITokens", "err", tokErr, "user_id", userID)
			tokens, tokErr = s.st.RevokeUserAPITokens(tailCtx, userID)
		}
		if tokErr != nil {
			res.RevokeFailed = true
		} else {
			res.TokensRevoked = tokens
		}
	}
	detail := "password changed"
	if res.TokensRevoked > 0 {
		detail = fmt.Sprintf("password changed (%d API tokens revoked)", res.TokensRevoked)
	}
	db.WriteAudit(tailCtx, s.st, userID, "password_change", "user", userID, detail)
	slog.Info("password changed", "user_id", userID,
		"sessions_revoked", res.SessionsRevoked, "api_tokens_revoked", res.TokensRevoked,
		"revoke_failed", res.RevokeFailed)
	return res, nil
}

// ServerStats returns the admin dashboard counters.
func (s *UserService) ServerStats(ctx context.Context) (*db.ServerStats, error) {
	stats, err := s.st.GetServerStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to get stats: %w", ErrInternal, err)
	}
	return stats, nil
}

// ListAll returns one page of users matching f with role names, in id order. The caller bounds limit and
// offset; this does not re-bound them.
func (s *UserService) ListAll(ctx context.Context, f db.UserListFilter, limit, offset int) ([]db.UserWithRole, error) {
	users, err := s.st.ListAllUsers(ctx, f, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list users: %w", ErrInternal, err)
	}
	return users, nil
}

// Get resolves one user; a missing row is ErrNotFound, not (nil, nil), so callers can tell 404 from 500.
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

// GetWithRoleName is Get plus the user's role display name, best-effort: a missing or unreadable role row
// comes back as "" rather than failing a user the panel must still show.
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

// StampConnect records the status this session comes online as and returns it: db.ConnectStatus(saved), so a
// saved Do Not Disturb survives a reconnect (idle/dnd/invisible survive, anything else becomes online). It
// writes even when unchanged, to refresh last_seen. With a batch the write is queued and lands within
// StampFlushInterval; the member list does not wait on it (the hub overlays live status). The SQL re-derives
// the status at write time, which would turn a legacy "offline" into online, so a committed presence_update
// drops the pending stamp (ChannelService.HandlePresenceUpdate). The caller must not cache the returned
// status unless the error is nil.
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

// StampDisconnect records that the user has no live connection left. It clears only the non-choice "online"
// and refreshes last_seen; a chosen idle/dnd/invisible stays for StampConnect (a member with no live
// connection renders offline). A batched stamp lost to a crash leaves "online", which the boot-time
// ResetAllUserStatuses clears.
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

// SetConnWrites installs the connection-stamp batch; call once at startup before the service is shared.
func (s *UserService) SetConnWrites(w *ConnWrites) { s.batch = w }
