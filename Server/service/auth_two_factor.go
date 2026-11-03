package service

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// twoFactorStore is what the second-factor and recovery-code paths read and
// write. *db.DB satisfies it.
type twoFactorStore interface {
	db.Auditor
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	ReplaceRecoveryCodes(ctx context.Context, userID int64, codeHashes []string) error
	ListUnusedRecoveryCodes(ctx context.Context, userID int64) (ids []int64, hashes []string, err error)
	MarkRecoveryCodeUsed(ctx context.Context, id int64) (consumed bool, err error)
	CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error)
	DeleteRecoveryCodes(ctx context.Context, userID int64) error
}

// twoFactor owns TOTP enrolment and verification state and the recovery codes
// that stand in for a TOTP code. The partial-login, pending-enrolment and
// used-code stores persist through the same store the service holds.
type twoFactor struct {
	*authCommon
	st        twoFactorStore
	partial   *auth.PartialAuthStore
	pending   *auth.PendingTOTPStore
	usedCodes *auth.UsedTOTPCodeStore
	totpKey   []byte
}

// consumeRecoveryCode spends the recovery code matching canonical, if the user
// holds one. matched is false for no match or a code another verification spent
// first; remaining is -1 when the count could not be read after a successful
// spend (the code is gone either way).
func (s *twoFactor) consumeRecoveryCode(ctx context.Context, userID int64, canonical string) (remaining int, matched bool, err error) {
	ids, hashes, err := s.st.ListUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		slog.Error("recovery codes: listing failed", "user_id", userID, "error", err)
		return 0, false, err
	}
	idx := auth.MatchRecoveryCode(canonical, hashes)
	if idx < 0 {
		return 0, false, nil
	}
	consumed, err := s.st.MarkRecoveryCodeUsed(ctx, ids[idx])
	if err != nil {
		slog.Error("recovery codes: consuming failed", "user_id", userID, "error", err)
		return 0, false, err
	}
	if !consumed {
		return 0, false, nil
	}
	left, err := s.st.CountUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		slog.Warn("recovery codes: counting the remainder failed", "user_id", userID, "error", err)
		return -1, true, nil
	}
	return left, true, nil
}

// RegenerateRecoveryCodes confirms the password and replaces the recovery codes;
// the old set is invalid the moment the new one is stored (one transaction).
// Requires 2FA: the codes stand in for a TOTP code.
func (s *twoFactor) RegenerateRecoveryCodes(ctx context.Context, p Principal, password string) ([]string, error) {
	if p.Session == nil {
		return nil, ErrLoginSessionRequired
	}
	user := p.User

	lockKey := auth.Key("pw_confirm_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrTooManyAttempts
	}
	if err := s.confirmPassword(ctx, user, password, lockKey); err != nil {
		return nil, err
	}
	if user.TOTPSecret == nil || *user.TOTPSecret == "" {
		return nil, ErrRecoveryCodesRequireTOTP
	}

	codes, err := s.issueRecoveryCodes(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	slog.Info("recovery codes regenerated", "user_id", user.ID)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "recovery_codes_regenerated", "user", user.ID,
		"emergency recovery codes regenerated")
	return codes, nil
}

// issueRecoveryCodes generates a set and stores its hashes, replacing any
// previous set.
func (s *twoFactor) issueRecoveryCodes(ctx context.Context, userID int64) ([]string, error) {
	// Ten bcrypt hashes: one admission slot.
	release, admitted := s.limiter.Admission().TryAcquire()
	if !admitted {
		return nil, ErrAuthBusy
	}
	codes, hashes, err := auth.GenerateRecoveryCodes()
	release()
	if err != nil {
		slog.Error("recovery codes: generation failed", "user_id", userID, "error", err)
		return nil, ErrRecoveryCodesFailed
	}
	if err := s.st.ReplaceRecoveryCodes(ctx, userID, hashes); err != nil {
		slog.Error("recovery codes: storing failed", "user_id", userID, "error", err)
		return nil, ErrRecoveryCodesFailed
	}
	return codes, nil
}

// challengeUser resolves the user behind a partial-auth challenge.
func (s *twoFactor) challengeUser(ctx context.Context, challengeUserID int64) (*db.User, error) {
	user, err := s.st.GetUserByID(ctx, challengeUserID)
	if err != nil {
		// GetUserByID answers (nil, nil) for an unknown user, so an error is a store
		// fault: report the outage and record no attempt.
		slog.Error("verify-totp: GetUserByID failed", "err", err, "user_id", challengeUserID)
		return nil, ErrTOTPUnavailable
	}
	if user == nil || user.TOTPSecret == nil {
		return nil, ErrTOTPChallengeInvalid
	}

	// A ban can land inside the partial-token window, so the second factor refuses
	// banned users as the login path does.
	if auth.IsEffectivelyBanned(user) {
		return nil, ErrBanned
	}
	return user, nil
}

// unsealTOTPSecret decrypts the challenged user's stored TOTP secret, or
// returns "" for a recovery code, which never uses it. A value that cannot be
// read is a store failure, never a wrong code.
func (s *twoFactor) unsealTOTPSecret(user *db.User, isRecovery bool) (string, error) {
	if isRecovery {
		return "", nil
	}
	secret, decErr := auth.DecryptTOTPSecret(s.totpKey, *user.TOTPSecret)
	if decErr != nil {
		slog.Error("failed to decrypt TOTP secret", "user_id", user.ID, "error", decErr)
		return "", ErrTOTPSecretUnreadable
	}
	return secret, nil
}

// EnableTOTP confirms the password and stages a pending secret. The recovery
// code hashes are stored now so they exist the moment ConfirmTOTP turns the
// factor on; staging again replaces both.
func (s *twoFactor) EnableTOTP(ctx context.Context, p Principal, password string) (*TOTPEnrollment, error) {
	if p.Session == nil {
		return nil, ErrLoginSessionRequired
	}
	user := p.User

	lockKey := auth.Key("pw_confirm_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrTooManyAttempts
	}

	if user.TOTPSecret != nil && *user.TOTPSecret != "" {
		return nil, ErrTOTPAlreadyEnabled
	}

	if err := s.confirmPassword(ctx, user, password, lockKey); err != nil {
		return nil, err
	}

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		slog.Error("totp enrol: secret generation failed", "err", err, "user_id", user.ID)
		return nil, ErrTOTPSecretGenerate
	}

	if err := s.pending.Put(ctx, user.ID, secret); err != nil {
		slog.Error("failed to stage two-factor enrolment", "user_id", user.ID, "error", err)
		return nil, ErrTOTPEnrollmentStage
	}
	codes, err := s.issueRecoveryCodes(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	return &TOTPEnrollment{
		URI:           auth.BuildTOTPURI(user.Username, secret, "OwnCord"),
		RecoveryCodes: codes,
	}, nil
}

// ConfirmTOTP verifies code against the pending secret, persists it and revokes
// the caller's other sessions.
func (s *twoFactor) ConfirmTOTP(ctx context.Context, p Principal, password, code string) (*TOTPChangeResult, error) {
	if p.Session == nil {
		return nil, ErrLoginSessionRequired
	}
	user := p.User

	lockKey := auth.Key("pw_confirm_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrTooManyAttempts
	}

	if err := s.confirmPassword(ctx, user, password, lockKey); err != nil {
		return nil, err
	}

	secret, ok := s.pending.Lookup(ctx, user.ID)
	if !ok {
		return nil, ErrNoPendingTOTP
	}

	if !auth.VerifyTOTPCodeOnce(ctx, secret, strings.TrimSpace(code), time.Now().UTC(), user.ID, s.usedCodes) {
		return nil, ErrTOTPCodeInvalid
	}

	encryptedSecret, encErr := auth.EncryptTOTPSecret(s.totpKey, secret)
	if encErr != nil {
		slog.Error("failed to encrypt TOTP secret", "user_id", user.ID, "error", encErr)
		return nil, ErrTOTPEnableFailed
	}

	if err := s.st.UpdateUserTOTPSecret(ctx, user.ID, &encryptedSecret); err != nil {
		slog.Error("totp confirm: storing the secret failed", "err", err, "user_id", user.ID)
		return nil, ErrTOTPEnableFailed
	}
	s.pending.Delete(ctx, user.ID)

	// Once the secret update committed, revoking other sessions must not be aborted
	// by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp enable")

	slog.Info("totp enabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_enabled", "user", user.ID,
		"two-factor authentication enrolled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS enabled. A 5xx would be a lie, so mirror
		// ChangePassword (api/profile_handler.go): 200 with an explicit warning.
		res.Warning = "two-factor authentication enabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}
