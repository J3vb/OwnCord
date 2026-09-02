package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// The recovery kit (B4-5, BPR-044; owner decision 2): a secret the account
// holder keeps offline. The server stores only an argon2id verifier; using
// the kit means "I lost my devices", so it signs the user in without the
// second factor, replaces the password, revokes every other session and
// spends the kit in one transaction. Five failed attempts lock recovery for
// 15 minutes per account and per address, audited.
const (
	recoveryKitFailureThreshold = 5
	recoveryKitFailureWindow    = 15 * time.Minute
	recoveryKitLockoutDuration  = 15 * time.Minute
)

var (
	// ErrRecoveryKitInvalid is the uniform refusal: unknown account, no kit,
	// a spent kit or a wrong secret all read the same.
	ErrRecoveryKitInvalid = &authError{ErrUnauthorized, "invalid username or recovery kit"}
	// ErrRecoveryKitMalformed is an enrolment supplying a client-generated
	// secret of the wrong shape.
	ErrRecoveryKitMalformed = &authError{ErrBadRequest, "recovery kit secret must be 32 base32 characters"}
	ErrRecoveryLockedOut    = &authError{ErrRateLimited, "recovery temporarily locked due to too many failed attempts"}
	ErrRecoveryFailed       = &authError{ErrInternal, "recovery failed — please try again"}
	ErrRecoveryKitFailed    = &authError{ErrInternal, "failed to issue the recovery kit"}
)

// RecoveryKitIssue is what enrolment hands back exactly once.
type RecoveryKitIssue struct {
	// Secret is the kit as the user must keep it, present only when the
	// server generated it; a client-generated secret is never echoed.
	Secret    string
	CreatedAt string
}

// RecoveryKitStatus is the account's own view of its kit: enough to know
// whether to enrol, never the verifier.
type RecoveryKitStatus struct {
	Enrolled  bool
	CreatedAt string
	UsedAt    *string
}

// RecoverInput is a recovery attempt from the public route.
type RecoverInput struct {
	Username    string
	KitSecret   string
	NewPassword string
	Device      string
	IP          string
}

// EnrolRecoveryKit issues the account's kit after password confirmation,
// replacing any previous one. clientSecret, when given, is a secret the
// client generated locally (the plan's contract); otherwise the server
// generates it and returns it once. Either way only the verifier is stored.
func (s *AuthService) EnrolRecoveryKit(ctx context.Context, p Principal, password, clientSecret string) (*RecoveryKitIssue, error) {
	user := p.User
	lockKey := auth.Key("pw_confirm_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrTooManyAttempts
	}
	if err := s.confirmPassword(ctx, user, password, lockKey); err != nil {
		return nil, err
	}

	var shown, canonical string
	if strings.TrimSpace(clientSecret) != "" {
		c, ok := auth.NormalizeRecoveryKitSecret(clientSecret)
		if !ok {
			return nil, ErrRecoveryKitMalformed
		}
		canonical = c
	} else {
		var err error
		shown, canonical, err = auth.GenerateRecoveryKitSecret()
		if err != nil {
			return nil, ErrRecoveryKitFailed
		}
	}

	// The verifier is argon2id: expensive on purpose, so it takes an
	// admission slot like every bcrypt site (B4-4).
	release, admitted := s.limiter.Admission().TryAcquire()
	if !admitted {
		return nil, ErrAuthBusy
	}
	verifier, err := auth.HashRecoveryKitSecret(canonical)
	release()
	if err != nil {
		return nil, ErrRecoveryKitFailed
	}
	if err := s.st.UpsertRecoveryKit(ctx, user.ID, verifier); err != nil {
		slog.Error("recovery kit: store failed", "err", err, "user_id", user.ID)
		return nil, ErrRecoveryKitFailed
	}
	kit, err := s.st.GetRecoveryKit(ctx, user.ID)
	if err != nil || kit == nil {
		return nil, ErrRecoveryKitFailed
	}
	slog.Info("recovery kit issued", "user_id", user.ID, "client_generated", shown == "")
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "recovery_kit_issued", "user", user.ID,
		"recovery kit issued")
	return &RecoveryKitIssue{Secret: shown, CreatedAt: kit.CreatedAt}, nil
}

// RecoveryKitStatus reports whether the account holds an unspent kit — the
// state a client needs to decide whether to (re-)enrol (O8 axis A3: a lost
// enrolment response must not leave the user trusting a kit the server
// never stored).
func (s *AuthService) RecoveryKitStatus(ctx context.Context, p Principal) (*RecoveryKitStatus, error) {
	kit, err := s.st.GetRecoveryKit(ctx, p.User.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to read the recovery kit", ErrInternal)
	}
	if kit == nil {
		return &RecoveryKitStatus{}, nil
	}
	return &RecoveryKitStatus{Enrolled: kit.UsedAt == nil, CreatedAt: kit.CreatedAt, UsedAt: kit.UsedAt}, nil
}

// RecoverWithKit redeems a kit: on success the password is replaced, every
// existing session revoked, the kit spent and the audit row written in one
// transaction, and a fresh session is issued without the second factor
// (owner decision 2). Every failure — unknown account, no kit, spent kit,
// wrong secret — is the same refusal, costs the same argon2id compare, and
// counts towards the per-address and per-account lockouts.
// recoveryAttempt names the limiter keys one recovery attempt touches: the
// per-address and per-account failure budgets and their lockouts.
type recoveryAttempt struct {
	ipLock, userLock, ipFail, userFail string
}

func newRecoveryAttempt(in RecoverInput) recoveryAttempt {
	unameKey := db.LowerASCII(in.Username)
	return recoveryAttempt{
		ipLock:   "recover_lock:" + in.IP,
		userLock: "recover_user_lock:" + unameKey,
		ipFail:   "recover_fail:" + in.IP,
		userFail: "recover_user_fail:" + unameKey,
	}
}

// RecoverWithKit redeems the account's kit from the public route and signs
// the holder in without the second factor (owner decision 2).
func (s *AuthService) RecoverWithKit(ctx context.Context, in RecoverInput) (*AuthResult, error) {
	at := newRecoveryAttempt(in)
	if s.limiter.IsLockedOut(at.ipLock) || s.limiter.IsLockedOut(at.userLock) {
		return nil, ErrRecoveryLockedOut
	}
	user, kit, err := s.recoveryCandidate(ctx, in)
	if err != nil {
		return nil, err
	}

	// The expensive work — the argon2id compare and, on a match, the bcrypt
	// hash of the new password — runs under one admission slot (B4-4), taken
	// before the attempt is charged: a refusal for load costs the caller
	// nothing, so a busy server cannot lock an honest holder out.
	release, admitted := s.limiter.Admission().TryAcquire()
	if !admitted {
		return nil, ErrAuthBusy
	}
	newHash, err := s.recoverAdmitted(ctx, in, user, kit, at)
	release()
	if err != nil {
		return nil, err
	}
	return s.completeRecovery(ctx, in, user, newHash, at)
}

// recoverAdmitted is the admitted part of an attempt: the reservation, the
// compare and the new-password hash. It returns the hash to commit.
func (s *AuthService) recoverAdmitted(ctx context.Context, in RecoverInput, user *db.User, kit *db.RecoveryKit, at recoveryAttempt) (string, error) {
	// Reserve the attempt before the compare, as login does (F3), so a
	// concurrent burst is capped at the same budget a sequential one gets;
	// the fifth failure trips the lockout (owner decision 2).
	if !s.limiter.Allow(at.ipFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) ||
		!s.limiter.Allow(at.userFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) {
		s.recoveryLockout(ctx, in, user, at)
		return "", ErrRecoveryLockedOut
	}
	matched, err := s.compareRecoverySecret(kit, in.KitSecret)
	if err != nil {
		return "", err
	}
	if !matched {
		s.recoveryLockout(ctx, in, user, at)
		return "", ErrRecoveryKitInvalid
	}
	if auth.IsEffectivelyBanned(user) {
		return "", ErrBanned
	}
	newHash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		return "", ErrPasswordHash
	}
	return newHash, nil
}

// recoveryCandidate looks up the account and its live kit. An unknown
// account reads as no account; a spent kit reads as no kit.
func (s *AuthService) recoveryCandidate(ctx context.Context, in RecoverInput) (*db.User, *db.RecoveryKit, error) {
	user, err := s.st.GetUserByUsername(ctx, in.Username)
	if err != nil {
		slog.Error("recovery: GetUserByUsername failed", "err", err, "ip", in.IP)
		return nil, nil, ErrRecoveryFailed
	}
	if user == nil {
		return nil, nil, nil
	}
	kit, err := s.st.GetRecoveryKit(ctx, user.ID)
	if err != nil {
		slog.Error("recovery: GetRecoveryKit failed", "err", err, "user_id", user.ID)
		return nil, nil, ErrRecoveryFailed
	}
	if kit != nil && kit.UsedAt != nil {
		kit = nil
	}
	return user, kit, nil
}

// compareRecoverySecret runs the one argon2id compare every attempt costs,
// whatever the input and whatever exists: a malformed secret still compares
// (its canonical form is empty), and without a live kit the compare runs
// against a verifier nobody holds — so the answer is no at the same price,
// and neither the account nor the kit can be told apart by timing. The
// caller holds the admission slot.
func (s *AuthService) compareRecoverySecret(kit *db.RecoveryKit, secret string) (bool, error) {
	canonical, wellFormed := auth.NormalizeRecoveryKitSecret(secret)
	verifier, err := auth.DummyRecoveryKitVerifier()
	if err != nil {
		return false, ErrRecoveryFailed
	}
	if kit != nil {
		verifier = kit.Verifier
	}
	matched := auth.VerifyRecoveryKitSecret(verifier, canonical)
	return matched && wellFormed && kit != nil, nil
}

// completeRecovery redeems the kit in one transaction with the already
// hashed new password and signs the holder in without the second factor
// (owner decision 2): the kit is the proof of possession this path accepts.
func (s *AuthService) completeRecovery(ctx context.Context, in RecoverInput, user *db.User, newHash string, at recoveryAttempt) (*AuthResult, error) {
	revoked, err := s.st.RedeemRecoveryKit(ctx, user.ID, newHash, "recovery_kit_used",
		"account recovered with the recovery kit; every session revoked")
	if err != nil {
		if errors.Is(err, db.ErrRecoveryKitSpent) {
			// Lost the race to a concurrent redemption: the kit is spent now.
			s.recoveryLockout(ctx, in, user, at)
			return nil, ErrRecoveryKitInvalid
		}
		slog.Error("recovery: redeem failed", "err", err, "user_id", user.ID)
		return nil, ErrRecoveryFailed
	}
	s.limiter.Reset(ctx, at.ipFail)
	s.limiter.Reset(ctx, at.userFail)

	token, err := issueSession(ctx, s.st, user.ID, in.Device, in.IP)
	if err != nil {
		// The recovery committed; the user signs in with the new password.
		slog.Error("recovery: session issue failed after redeem", "err", err, "user_id", user.ID)
		return nil, ErrRecoveryFailed
	}
	fresh, err := s.st.GetUserByID(ctx, user.ID)
	if err != nil || fresh == nil {
		return nil, ErrRecoveryFailed
	}
	slog.Info("account recovered with the recovery kit", "user_id", user.ID, "ip", in.IP, "sessions_revoked", revoked)
	return &AuthResult{Token: token, User: fresh}, nil
}

// recoveryLockout records a failed attempt's consequences: when either
// budget is exhausted the matching lockout starts, and the per-account one
// is audited (owner decision 2) — content-free, the account id only.
func (s *AuthService) recoveryLockout(ctx context.Context, in RecoverInput, user *db.User, at recoveryAttempt) {
	if !s.limiter.Check(at.ipFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) {
		s.limiter.Lockout(ctx, at.ipLock, recoveryKitLockoutDuration)
	}
	if !s.limiter.Check(at.userFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) {
		s.limiter.Lockout(ctx, at.userLock, recoveryKitLockoutDuration)
		if user != nil {
			slog.Warn("recovery locked after repeated failures", "user_id", user.ID, "ip", in.IP)
			db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "recovery_kit_locked", "user", user.ID,
				"recovery locked for 15 minutes after repeated failed kit attempts")
		}
	}
}
