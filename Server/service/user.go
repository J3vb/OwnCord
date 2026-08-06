package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/owncord/server/db"
	"github.com/owncord/server/telemetry"
)

// UserService handles user profile and session operations.
type UserService struct {
	st Store
}

// NewUserService creates a UserService.
func NewUserService(st Store) *UserService {
	return &UserService{st: st}
}

// AvatarFileURL is the server-relative path an uploaded avatar is served from.
// It is the ordinary attachment route: the upload handler writes an attachment
// row and points users.avatar here, and handleServeFile admits an unlinked
// attachment that some user's avatar names. Defined once because three places
// have to agree on the spelling — the upload response, the stored column, and
// the file route's authorization probe, which matches the column *by string*.
func AvatarFileURL(fileID string) string {
	return "/api/v1/files/" + fileID
}

// ─── Profile field bounds ───────────────────────────────────────────────────

const (
	// MaxDisplayNameLen bounds users.display_name. 32 matches the username
	// cap: a nickname that could not fit where a username fits would render
	// clipped in exactly the places the fallback puts the username.
	MaxDisplayNameLen = 32
	// MaxAboutLen bounds users.about — long enough for a paragraph, short
	// enough that the popup's two-line section stays a section.
	MaxAboutLen = 300
	// MaxCustomStatusLen bounds users.custom_status: one line under a name.
	MaxCustomStatusLen = 128
)

// ProfilePatch is a partial update to a user's profile. A nil field means
// "leave unchanged"; a non-nil pointer to the empty string clears the nullable
// fields (display name, about). The free-text fields are sanitized and
// length-checked *here* rather than in the handler, so every transport that
// can reach a profile gets the same rules.
type ProfilePatch struct {
	Username    string
	Avatar      *string
	DisplayName *string
	About       *string
}

// nullable turns a sanitized, trimmed patch value into the column value:
// empty string clears the column, anything else is stored as-is.
func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// cleanText strips HTML and trims a free-text profile field. Both the profile
// PATCH and the presence path run values through it before any bound check, so
// a payload cannot buy length with markup that is about to be stripped anyway.
//
// Uses sanitizeToFixpoint (message.go), not a bare sanitizer.Sanitize call:
// display name, about, custom status, and DM group names all render through
// the client's textContent-only path (same as message content), so a plain
// sanitizer.Sanitize call would persist and display literal &#39;/&gt;/&amp;
// entities for ordinary punctuation instead of the characters typed — the
// exact bug sanitizeToFixpoint fixes for message content.
func cleanText(v string) string {
	return strings.TrimSpace(sanitizeToFixpoint(v))
}

// resolveOptional picks the column value for one nullable text field: the
// sanitized patch when it was supplied, the existing row otherwise.
func resolveOptional(patch *string, existing *string) *string {
	if patch == nil {
		return existing
	}
	return nullable(cleanText(*patch))
}

// UpdateProfile applies a ProfilePatch: username and avatar as before, plus
// the nullable display name and about text. Returns the updated user for
// response building.
func (s *UserService) UpdateProfile(ctx context.Context, userID int64, patch ProfilePatch) (*db.User, error) {
	ctx, span := telemetry.GlobalTracer("service/user").Start(ctx, "UserService.UpdateProfile",
		telemetry.Int64("user_id", userID),
	)
	start := time.Now()
	defer func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", "UpdateProfile"))
		span.End()
	}()

	if patch.DisplayName != nil && utf8.RuneCountInString(cleanText(*patch.DisplayName)) > MaxDisplayNameLen {
		return nil, fmt.Errorf("%w: display_name must be at most %d characters", ErrBadRequest, MaxDisplayNameLen)
	}
	if patch.About != nil && utf8.RuneCountInString(cleanText(*patch.About)) > MaxAboutLen {
		return nil, fmt.Errorf("%w: about must be at most %d characters", ErrBadRequest, MaxAboutLen)
	}

	// The update writes every column, so a partial patch has to be merged
	// against the current row first — otherwise setting only a display name
	// would silently clear the about text.
	current, err := s.st.GetUserByID(ctx, userID)
	if err != nil || current == nil {
		return nil, fmt.Errorf("%w: user not found", ErrNotFound)
	}
	avatar := current.Avatar
	if patch.Avatar != nil {
		avatar = nullable(*patch.Avatar)
	}
	displayName := resolveOptional(patch.DisplayName, current.DisplayName)
	about := resolveOptional(patch.About, current.About)

	if err := s.st.UpdateUserProfile(ctx, userID, patch.Username, avatar, displayName, about); err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("%w: username is already taken", ErrConflict)
		}
		return nil, fmt.Errorf("%w: failed to update profile: %v", ErrInternal, err)
	}
	user, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch updated user: %v", ErrInternal, err)
	}
	// Audit rows must survive a request canceled after the write committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "profile_update", "user", userID,
		fmt.Sprintf("username=%s", patch.Username))
	slog.Info("profile updated", "user_id", userID, "username", patch.Username)
	return user, nil
}

// SetCustomStatus stores (or clears, with an empty string) the user's custom
// status line. It is the presence path's counterpart to UpdateProfile: the
// value persists across reconnects and is cleared explicitly on logout, which
// is why it is stored rather than held on the connection.
func (s *UserService) SetCustomStatus(ctx context.Context, userID int64, text string) error {
	cleaned := cleanText(text)
	if utf8.RuneCountInString(cleaned) > MaxCustomStatusLen {
		return fmt.Errorf("%w: custom_status must be at most %d characters", ErrBadRequest, MaxCustomStatusLen)
	}
	if err := s.st.UpdateUserCustomStatus(ctx, userID, nullable(cleaned)); err != nil {
		return fmt.Errorf("%w: failed to update custom status: %v", ErrInternal, err)
	}
	return nil
}

// ClearCustomStatus wipes the custom status line. Called on logout: the text
// is a "what I am doing right now" note, and leaving it standing after the
// user signed out states something about them that is no longer true.
func (s *UserService) ClearCustomStatus(ctx context.Context, userID int64) error {
	if err := s.st.UpdateUserCustomStatus(ctx, userID, nil); err != nil {
		return fmt.Errorf("%w: failed to clear custom status: %v", ErrInternal, err)
	}
	return nil
}

// UpdateIdentityKey publishes the user's long-term E2EE identity public key
// (F3 voice E2EE TOFU). Last write wins; every write is audited so a key
// rotation — which peers surface as a TOFU mismatch — leaves a trail.
// Returns the updated user for response building.
func (s *UserService) UpdateIdentityKey(ctx context.Context, userID int64, key string) (*db.User, error) {
	if err := s.st.UpdateUserIdentityKey(ctx, userID, &key); err != nil {
		return nil, fmt.Errorf("%w: failed to update identity key", ErrInternal)
	}
	user, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch updated user", ErrInternal)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "identity_key_update", "user", userID, "")
	slog.Info("identity key published", "user_id", userID)
	return user, nil
}

// ChangePasswordResult reports a completed password change. RevokeFailed is
// set when the password committed but other sessions could not be revoked —
// a partial success the caller must surface as a warning, never as a 5xx:
// the old password is already unusable, so telling the user the change
// "failed" walks them into retrying with a dead password and tripping the
// password-confirm lockout.
type ChangePasswordResult struct {
	SessionsRevoked int64
	RevokeFailed    bool
}

// ChangePassword updates the user's password and revokes other sessions.
func (s *UserService) ChangePassword(ctx context.Context, userID int64, newPasswordHash string, keepSessionID int64) (ChangePasswordResult, error) {
	if err := s.st.UpdateUserPassword(ctx, userID, newPasswordHash); err != nil {
		return ChangePasswordResult{}, fmt.Errorf("%w: failed to update password: %v", ErrInternal, err)
	}

	// The password is committed from here on: every path below reports
	// success and writes the audit row — even if the request ctx has been
	// canceled, revocation and audit are the security tail of the change.
	tailCtx := context.WithoutCancel(ctx)

	var res ChangePasswordResult
	revoked, err := s.st.DeleteOtherSessions(tailCtx, userID, keepSessionID)
	res.SessionsRevoked = revoked
	if err != nil {
		slog.Error("UserService.ChangePassword DeleteOtherSessions", "err", err, "user_id", userID)
		// One bounded compensating retry: revocation is the security tail of
		// the change and a single immediate retry covers transient write-lock
		// contention. ponytail: one retry, add backoff only if logs show it.
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

// ListSessions returns all active sessions for a user.
func (s *UserService) ListSessions(ctx context.Context, userID int64) ([]db.Session, error) {
	sessions, err := s.st.ListUserSessions(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list sessions: %v", ErrInternal, err)
	}
	return sessions, nil
}

// RevokeSession deletes a specific session owned by the user.
func (s *UserService) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	if err := s.st.DeleteSessionByID(ctx, sessionID, userID); err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return fmt.Errorf("%w: session not found", ErrNotFound)
		}
		return fmt.Errorf("%w: failed to revoke session: %v", ErrInternal, err)
	}
	// Audit rows must survive a request canceled after the delete committed.
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "session_revoke", "session", sessionID, "session revoked")
	slog.Info("session revoked", "user_id", userID, "session_id", sessionID)
	return nil
}
