package service

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

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

type twoFactor struct {
	*authCommon
	st        twoFactorStore
	partial   *auth.PartialAuthStore
	pending   *auth.PendingTOTPStore
	usedCodes *auth.UsedTOTPCodeStore
	totpKey   []byte
}

// consumeRecoveryCode spends the recovery code matching canonical, if held. matched is
// false for no match or a code another verification spent first; remaining is -1 when
// the count could not be read after a successful spend.
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

// RegenerateRecoveryCodes confirms the password and replaces the recovery codes; the old
// set is invalid once the new one is stored (one transaction). Requires 2FA.
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

func (s *twoFactor) issueRecoveryCodes(ctx context.Context, userID int64) ([]string, error) {
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

func (s *twoFactor) challengeUser(ctx context.Context, challengeUserID int64) (*db.User, error) {
	user, err := s.st.GetUserByID(ctx, challengeUserID)
	if err != nil {
		// GetUserByID answers (nil, nil) for an unknown user, so an error is a store fault:
		// report the outage and record no attempt.
		slog.Error("verify-totp: GetUserByID failed", "err", err, "user_id", challengeUserID)
		return nil, ErrTOTPUnavailable
	}
	if user == nil || user.TOTPSecret == nil {
		return nil, ErrTOTPChallengeInvalid
	}

	// A ban can land inside the partial-token window, so the second factor refuses banned users as login does.
	if auth.IsEffectivelyBanned(user) {
		return nil, ErrBanned
	}
	return user, nil
}

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

// EnableTOTP confirms the password and stages a pending secret. Recovery code hashes are
// stored now so they exist when ConfirmTOTP turns the factor on; staging again replaces both.
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

// ConfirmTOTP verifies code against the pending secret, persists it and revokes the caller's other
// sessions.
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

	// Once the secret update committed, revoking other sessions must not be aborted by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp enable")

	slog.Info("totp enabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_enabled", "user", user.ID,
		"two-factor authentication enrolled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS enabled, so answer 200 with a warning, as ChangePassword does.
		res.Warning = "two-factor authentication enabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}

// VerifyTOTP completes a challenge Login started, issuing the session bound to the login
// request's device and IP.
func (s *AuthService) VerifyTOTP(ctx context.Context, partialToken, code string) (*AuthResult, error) {
	code = strings.TrimSpace(code)
	challenge, ok := s.partial.Lookup(ctx, partialToken)
	if !ok {
		return nil, ErrTOTPChallengeInvalid
	}

	// Refuse an exhausted per-user budget before touching the store: the read-only Check
	// charges nothing, so rotating source IPs cannot drive reads and decryptions past the cap.
	totpRateLimitKey := auth.Key("totp_fail", challenge.UserID)
	if !s.limiter.Check(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
		return nil, ErrTooManyAttempts
	}

	user, err := s.challengeUser(ctx, challenge.UserID)
	if err != nil {
		return nil, err
	}

	// Record the attempt atomically up-front, not a read-only Check now and Allow on failure:
	// that TOCTOU lets concurrent requests reusing one valid partial token all pass before any
	// failure is recorded, defeating the per-user cap (the only cross-IP defence). Success
	// resets the counter. Deliberately NOT auth.ScaledLimit (shared-NAT multiplier would give
	// a distributed attacker more guesses). After the store read so an outage consumes none.
	// A recovery code is up to ten bcrypt hashes, so it takes an admission slot first (a
	// refusal charges nothing); a TOTP code is an HMAC and needs none.
	canonical, isRecovery := auth.NormalizeRecoveryCode(code)
	// Only a TOTP code needs the stored secret, so an unreadable one still lets a recovery
	// code through; it fails before Allow, charging nothing.
	secret, err := s.unsealTOTPSecret(user, isRecovery)
	if err != nil {
		return nil, err
	}
	release := func() {}
	if isRecovery {
		if release, err = s.acquireAdmission(ctx); err != nil {
			return nil, err
		}
		defer release()
	}
	if !s.limiter.Allow(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
		return nil, ErrTooManyAttempts
	}

	// A recovery code is spent by the conditional update that consumed it, not the replay
	// window, so Unmark below applies to TOTP codes only.
	var recoveryRemaining *int
	if isRecovery {
		remaining, matched, err := s.consumeRecoveryCode(ctx, user.ID, canonical)
		release()
		if err != nil {
			return nil, ErrTOTPUnavailable
		}
		if !matched {
			s.partial.RegisterFailure(ctx, partialToken, partialAuthMaxFailures)
			return nil, ErrTOTPCodeInvalid
		}
		recoveryRemaining = &remaining
	} else if !auth.VerifyTOTPCodeOnce(ctx, secret, code, time.Now().UTC(), user.ID, s.usedCodes) {
		s.partial.RegisterFailure(ctx, partialToken, partialAuthMaxFailures)
		return nil, ErrTOTPCodeInvalid
	}

	s.limiter.Reset(ctx, totpRateLimitKey)

	claimed, ok := s.partial.Consume(ctx, partialToken)
	if !ok {
		// The claim lost: a concurrent verify consumed the challenge (or it expired). Release the
		// code so a Restore by a winner whose issueSession failed is not stuck behind this mark.
		// A spent recovery code stays spent, or a racing verifier would get a second use.
		if recoveryRemaining == nil {
			s.usedCodes.Unmark(ctx, user.ID, code)
		}
		return nil, ErrTOTPChallengeInvalid
	}

	token, err := issueSession(ctx, s.st, user.ID, challenge.Device, challenge.IP)
	if err != nil {
		// The second factor was verified; a store fault must not discard it. The claim is atomic and first, so two
		// verifies never both reach issueSession. Put the challenge
		// back under the same token and release the code so a retry completes without another
		// password step; code first, then token, so a retry never finds a live token with a dead code.
		if recoveryRemaining == nil {
			s.usedCodes.Unmark(ctx, user.ID, code)
		}
		s.partial.Restore(ctx, partialToken, claimed)
		slog.Error("verify-totp: session issue failed", "err", err, "user_id", user.ID)
		return nil, sessionIssueError(err)
	}

	detail := "two-factor verification completed from " + challenge.IP
	if recoveryRemaining != nil {
		detail = "two-factor verification completed with a recovery code from " + challenge.IP
	}
	slog.Info("totp verified", "user_id", user.ID, "ip", challenge.IP, "recovery_code", recoveryRemaining != nil)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "totp_verified", "user", user.ID, detail)
	return &AuthResult{Token: token, User: user, RecoveryCodesRemaining: recoveryRemaining}, nil
}

// DisableTOTP confirms the password, refuses while the server requires 2FA, clears the
// secret and revokes the caller's other sessions.
func (s *AuthService) DisableTOTP(ctx context.Context, p Principal, password string) (*TOTPChangeResult, error) {
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

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		slog.Error("totp disable: reading require_2fa failed", "err", err, "user_id", user.ID)
		return nil, ErrAuthPolicyUnavailable
	}
	if require2FA {
		return nil, ErrTOTPRequiredByServer
	}

	s.pending.Delete(ctx, user.ID)
	if err := s.twoFactor.st.UpdateUserTOTPSecret(ctx, user.ID, nil); err != nil {
		slog.Error("totp disable: clearing the secret failed", "err", err, "user_id", user.ID)
		return nil, ErrTOTPDisableFailed
	}
	// Recovery codes mean nothing without 2FA; a leftover set is still a credential.
	if err := s.twoFactor.st.DeleteRecoveryCodes(ctx, user.ID); err != nil {
		slog.Warn("recovery codes: deleting after 2FA disable failed", "user_id", user.ID, "error", err)
	}

	// Once the secret update committed, revoking other sessions must not be aborted by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp disable")

	slog.Info("totp disabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_disabled", "user", user.ID,
		"two-factor authentication disabled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS disabled, so answer 200 with a warning, as ChangePassword does.
		res.Warning = "two-factor authentication disabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}

func (s *AuthService) require2FAEnabled(ctx context.Context) (bool, error) {
	return getBooleanSetting(ctx, s.st, "require_2fa", false)
}
