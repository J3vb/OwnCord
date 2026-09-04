package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
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

// The owner-issued recovery credential (B4-6, BPR-045; owner decision 3):
// short-lived, single-use, issued by the server owner only after verifying
// the person out of band. It is redeemed through the same public route as
// the kit and told apart by shape.
const (
	recoveryAssistTTL = 15 * time.Minute
	// Issuance budgets, per owner and per target account.
	recoveryAssistIssueLimit  = 5
	recoveryAssistTargetLimit = 3
	recoveryAssistIssueWindow = time.Hour
)

// RecoveryVerifications is the fixed wording an issuance must record: how
// the owner verified the person. Nothing free-form is accepted, so nothing
// content-bearing can reach the audit log (BPR-045's safe audit record).
var RecoveryVerifications = []string{"in_person", "voice_call", "video_call", "trusted_contact"}

var (
	ErrRecoveryAssistOwnerOnly    = &authError{ErrForbidden, "only the server owner can issue a recovery credential"}
	ErrRecoveryAssistVerification = &authError{ErrBadRequest, "verification must be one of in_person, voice_call, video_call, trusted_contact"}
	ErrRecoveryAssistTarget       = &authError{ErrNotFound, "no such account"}
	ErrRecoveryAssistUnusable     = &authError{ErrBadRequest, "this account cannot be recovered with a credential"}
	ErrRecoveryAssistBudget       = &authError{ErrRateLimited, "too many recovery credentials issued; try again later"}
	ErrRecoveryAssistFailed       = &authError{ErrInternal, "failed to issue the recovery credential"}
)

// RecoveryAssistIssue is what the owner receives exactly once.
type RecoveryAssistIssue struct {
	Credential   string
	ExpiresAt    string
	Username     string
	Verification string
}

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

// recoveryTarget is what an attempt may redeem: the account and whichever
// credentials are live for it. An unknown account is a nil user; a spent kit
// or an expired credential reads as none.
type recoveryTarget struct {
	user   *db.User
	kit    *db.RecoveryKit
	assist *db.RecoveryAssist
}

// RecoverWithKit redeems a recovery secret from the public route — the
// account's kit (B4-5) or an owner-issued credential (B4-6), told apart by
// shape — and signs the holder in without the second factor.
func (s *AuthService) RecoverWithKit(ctx context.Context, in RecoverInput) (*AuthResult, error) {
	at := newRecoveryAttempt(in)
	if s.limiter.IsLockedOut(at.ipLock) || s.limiter.IsLockedOut(at.userLock) {
		return nil, ErrRecoveryLockedOut
	}
	target, err := s.recoveryCandidate(ctx, in)
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
	kind, newHash, err := s.recoverAdmitted(ctx, in, target, at)
	release()
	if err != nil {
		return nil, err
	}
	return s.completeRecovery(ctx, in, target, kind, newHash, at)
}

// recoverAdmitted is the admitted part of an attempt: the reservation, the
// compare and the new-password hash. It returns the matched kind and the
// hash to commit.
func (s *AuthService) recoverAdmitted(ctx context.Context, in RecoverInput, target recoveryTarget, at recoveryAttempt) (auth.RecoverySecretKind, string, error) {
	// Reserve the attempt before the compare, as login does (F3), so a
	// concurrent burst is capped at the same budget a sequential one gets;
	// the fifth failure trips the lockout (owner decision 2).
	if !s.limiter.Allow(at.ipFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) ||
		!s.limiter.Allow(at.userFail, recoveryKitFailureThreshold, recoveryKitFailureWindow) {
		s.recoveryLockout(ctx, in, target.user, at)
		return auth.RecoverySecretMalformed, "", ErrRecoveryLockedOut
	}
	kind, err := s.compareRecoverySecret(target, in.KitSecret)
	if err != nil {
		return auth.RecoverySecretMalformed, "", err
	}
	if kind == auth.RecoverySecretMalformed {
		s.recoveryLockout(ctx, in, target.user, at)
		return auth.RecoverySecretMalformed, "", ErrRecoveryKitInvalid
	}
	if auth.IsEffectivelyBanned(target.user) {
		return auth.RecoverySecretMalformed, "", ErrBanned
	}
	newHash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		return auth.RecoverySecretMalformed, "", ErrPasswordHash
	}
	return kind, newHash, nil
}

// recoveryCandidate looks up the account and its live credentials.
func (s *AuthService) recoveryCandidate(ctx context.Context, in RecoverInput) (recoveryTarget, error) {
	user, err := s.st.GetUserByUsername(ctx, in.Username)
	if err != nil {
		slog.Error("recovery: GetUserByUsername failed", "err", err, "ip", in.IP)
		return recoveryTarget{}, ErrRecoveryFailed
	}
	if user == nil {
		return recoveryTarget{}, nil
	}
	kit, err := s.st.GetRecoveryKit(ctx, user.ID)
	if err != nil {
		slog.Error("recovery: GetRecoveryKit failed", "err", err, "user_id", user.ID)
		return recoveryTarget{}, ErrRecoveryFailed
	}
	if kit != nil && kit.UsedAt != nil {
		kit = nil
	}
	assist, err := s.st.GetRecoveryAssist(ctx, user.ID)
	if err != nil {
		slog.Error("recovery: GetRecoveryAssist failed", "err", err, "user_id", user.ID)
		return recoveryTarget{}, ErrRecoveryFailed
	}
	if assist != nil && !assist.Live(time.Now()) {
		assist = nil
	}
	return recoveryTarget{user: user, kit: kit, assist: assist}, nil
}

// compareRecoverySecret runs the one argon2id compare every attempt costs,
// whatever the input and whatever exists: a malformed secret still compares
// (its canonical form is empty), and the verifier is the one the secret's
// shape selects — the kit's or the owner-issued credential's — or, when the
// account holds no live credential of that kind, a verifier nobody holds.
// So the answer is no at the same price, and neither the account nor its
// credentials can be told apart by timing. It returns the kind that
// matched, or Malformed. The caller holds the admission slot.
func (s *AuthService) compareRecoverySecret(target recoveryTarget, secret string) (auth.RecoverySecretKind, error) {
	canonical, kind := auth.NormalizeRecoverySecret(secret)
	verifier, err := auth.DummyRecoveryKitVerifier()
	if err != nil {
		return auth.RecoverySecretMalformed, ErrRecoveryFailed
	}
	held := false
	switch {
	case kind == auth.RecoverySecretKit && target.kit != nil:
		verifier, held = target.kit.Verifier, true
	case kind == auth.RecoverySecretAssist && target.assist != nil:
		verifier, held = target.assist.Verifier, true
	}
	matched := auth.VerifyRecoveryKitSecret(verifier, canonical)
	if !matched || !held || kind == auth.RecoverySecretMalformed {
		return auth.RecoverySecretMalformed, nil
	}
	return kind, nil
}

// completeRecovery redeems the matched credential in one transaction with
// the already hashed new password and signs the holder in without the
// second factor (owner decisions 2 and 3): the credential is the proof of
// possession this path accepts.
func (s *AuthService) completeRecovery(ctx context.Context, in RecoverInput, target recoveryTarget, kind auth.RecoverySecretKind, newHash string, at recoveryAttempt) (*AuthResult, error) {
	user := target.user
	var err error
	var revoked int64
	via := "kit"
	if kind == auth.RecoverySecretAssist {
		via = "owner_credential"
		// Consume exactly the credential the compare verified: one issued
		// meanwhile is a different row and stays.
		revoked, err = s.st.RedeemRecoveryAssist(ctx, user.ID, target.assist.Verifier, newHash, "recovery_assist_used",
			"account recovered with an owner-issued credential; every session revoked")
	} else {
		revoked, err = s.st.RedeemRecoveryKit(ctx, user.ID, newHash, "recovery_kit_used",
			"account recovered with the recovery kit; every session revoked")
	}
	if err != nil {
		if errors.Is(err, db.ErrRecoveryKitSpent) || errors.Is(err, db.ErrRecoveryAssistSpent) {
			// Lost the race to a concurrent redemption (or the credential
			// expired meanwhile): it is spent now.
			s.recoveryLockout(ctx, in, user, at)
			return nil, ErrRecoveryKitInvalid
		}
		slog.Error("recovery: redeem failed", "err", err, "user_id", user.ID)
		return nil, ErrRecoveryFailed
	}
	s.limiter.Reset(ctx, at.ipFail)
	s.limiter.Reset(ctx, at.userFail)
	// The database transaction revoked every session, but a WebSocket that
	// authenticated before it committed can otherwise keep issuing commands
	// until its ten-message recheck or the next 30-second sweep. Recovery is a
	// compromised-credential boundary: cut that socket off before issuing the
	// replacement session, using the same immediate path as sign-out-everywhere.
	if d, ok := s.broadcaster.(AuthSessionDisconnector); ok {
		d.DisconnectRevokedUser(user.ID)
	}

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
	slog.Info("account recovered", "via", via, "user_id", user.ID, "ip", in.IP, "sessions_revoked", revoked)
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

// IssueRecoveryAssist is the owner-only half of BPR-045 (owner decision 3):
// after verifying the person out of band — recorded as one of
// RecoveryVerifications, fixed wording so nothing content-bearing exists to
// leak — the server owner receives a 15-minute, single-use credential for
// the account, shown once. Only its argon2id verifier is stored; a later
// issuance replaces an outstanding one. Redemption is the public recovery
// route, which signs the holder in without the second factor.
func (s *AuthService) IssueRecoveryAssist(ctx context.Context, actorID, targetID int64, verification string) (*RecoveryAssistIssue, error) {
	actor, err := s.st.GetUserByID(ctx, actorID)
	if err != nil {
		slog.Error("recovery assist: GetUserByID (actor) failed", "err", err, "actor_id", actorID)
		return nil, ErrRecoveryAssistFailed
	}
	if actor == nil {
		return nil, ErrRecoveryAssistOwnerOnly
	}
	role, err := s.st.GetRoleByID(ctx, actor.RoleID)
	if err != nil {
		slog.Error("recovery assist: GetRoleByID failed", "err", err, "actor_id", actor.ID)
		return nil, ErrRecoveryAssistFailed
	}
	if role == nil || (role.ID != permissions.OwnerRoleID && role.Position < permissions.OwnerRolePosition) {
		return nil, ErrRecoveryAssistOwnerOnly
	}
	if !slices.Contains(RecoveryVerifications, verification) {
		return nil, ErrRecoveryAssistVerification
	}
	target, err := s.st.GetUserByID(ctx, targetID)
	if err != nil {
		slog.Error("recovery assist: GetUserByID failed", "err", err, "user_id", targetID)
		return nil, ErrRecoveryAssistFailed
	}
	if target == nil {
		return nil, ErrRecoveryAssistTarget
	}
	// Not for the issuer's own account (they are signed in), a banned
	// account (it cannot sign in), an application still pending, or an
	// anonymised row (the reserved "[...]" names).
	if target.ID == actor.ID || auth.IsEffectivelyBanned(target) || target.PendingApproval() || strings.HasPrefix(target.Username, "[") {
		return nil, ErrRecoveryAssistUnusable
	}
	// The argon2id hash of the credential takes an admission slot (B4-4),
	// taken before the issuance budgets are spent: a refusal for load
	// charges nothing.
	release, admitted := s.limiter.Admission().TryAcquire()
	if !admitted {
		return nil, ErrAuthBusy
	}
	defer release()
	if !s.reserveIssuance(actor.ID, target.ID) {
		return nil, ErrRecoveryAssistBudget
	}
	shown, canonical, err := auth.GenerateRecoveryAssistSecret()
	if err != nil {
		return nil, ErrRecoveryAssistFailed
	}
	verifier, err := auth.HashRecoveryKitSecret(canonical)
	if err != nil {
		return nil, ErrRecoveryAssistFailed
	}
	expires := time.Now().Add(recoveryAssistTTL)
	if err := s.st.UpsertRecoveryAssist(ctx, target.ID, verifier, actor.ID, verification, expires); err != nil {
		slog.Error("recovery assist: UpsertRecoveryAssist failed", "err", err, "user_id", target.ID)
		return nil, ErrRecoveryAssistFailed
	}
	db.WriteAudit(ctx, s.st, actor.ID, "recovery_assist_issued", "user", target.ID,
		"verification: "+verification+"; single use, expires in 15 minutes")
	slog.Info("recovery credential issued", "user_id", target.ID, "actor_id", actor.ID, "verification", verification)
	return &RecoveryAssistIssue{
		Credential:   shown,
		ExpiresAt:    expires.UTC().Format(time.RFC3339),
		Username:     target.Username,
		Verification: verification,
	}, nil
}

// reserveIssuance spends one slot of the owner's and the account's issuance
// budgets, both or neither: the peek and the spend run under one lock, so
// concurrent issuances cannot slip past either limit and a refusal on one
// budget never consumes the other.
func (s *AuthService) reserveIssuance(actorID, targetID int64) bool {
	s.issueMu.Lock()
	defer s.issueMu.Unlock()
	actorKey := fmt.Sprintf("recovery_assist_issue:%d", actorID)
	targetKey := fmt.Sprintf("recovery_assist_target:%d", targetID)
	if !s.limiter.Check(actorKey, recoveryAssistIssueLimit, recoveryAssistIssueWindow) ||
		!s.limiter.Check(targetKey, recoveryAssistTargetLimit, recoveryAssistIssueWindow) {
		return false
	}
	s.limiter.Allow(actorKey, recoveryAssistIssueLimit, recoveryAssistIssueWindow)
	s.limiter.Allow(targetKey, recoveryAssistTargetLimit, recoveryAssistIssueWindow)
	return true
}
