package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// RegistrationPolicy reports whether registration is permitted. It runs before
// the transport reads any credential: a closed server refuses even a malformed
// body with the policy's 403.
func (s *AuthService) RegistrationPolicy(ctx context.Context) error {
	mode, err := registrationModeSetting(ctx, s.st)
	if err != nil {
		slog.Error("registration policy: reading registration_mode failed", "err", err)
		return ErrRegistrationPolicyUnavailable
	}
	if mode == RegistrationClosed {
		return ErrRegistrationClosed
	}

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		slog.Error("registration policy: reading require_2fa failed", "err", err)
		return ErrRegistrationPolicyUnavailable
	}
	if require2FA {
		return ErrRegistrationRequires2FA
	}
	return nil
}

// Per-mode abuse limits for the invite-free modes: accounts or applications per
// address per day, and the approval-queue cap.
const (
	inviteFreeRegistrationsPerIPPerDay = 5
	maxPendingRegistrations            = 100
)

// admitRegistration runs the mode's gates before any bcrypt work. In the
// invite-free modes it reserves one of the address's daily registrations;
// refund hands it back, and Register calls it unless the account or application
// committed, so a busy server, a taken username or a full queue costs the
// address nothing. refund is never nil.
func (s *AuthService) admitRegistration(ctx context.Context, in RegisterInput) (mode RegistrationMode, refund func(), err error) {
	noRefund := func() {}
	mode, err = registrationModeSetting(ctx, s.st)
	if err != nil {
		slog.Error("register: reading registration_mode failed", "err", err)
		return "", noRefund, ErrRegistrationPolicyUnavailable
	}
	switch mode {
	case RegistrationClosed:
		return "", noRefund, ErrRegistrationClosed
	case RegistrationInvite:
		if strings.TrimSpace(in.InviteCode) == "" {
			// Same answer as a bad code, so the response reveals nothing new.
			slog.WarnContext(ctx, "registration refused", "cause", "invite required",
				"ip", in.IP, "username", in.Username)
			return "", noRefund, ErrRegistrationRejected
		}
		return mode, noRefund, nil
	case RegistrationApproval, RegistrationOpen:
	}
	if mode == RegistrationApproval {
		pending, err := s.st.CountPendingUsers(ctx)
		if err != nil {
			slog.Error("register: counting pending applications failed", "err", err)
			return "", noRefund, ErrRegistrationPolicyUnavailable
		}
		if pending >= maxPendingRegistrations {
			return "", noRefund, ErrRegistrationQueueFull
		}
	}
	refund, ok := s.limiter.Reserve("register_ip:"+clientip.RateKey(in.IP), inviteFreeRegistrationsPerIPPerDay, 24*time.Hour)
	if !ok {
		return "", noRefund, ErrRegistrationRateLimited
	}
	return mode, refund, nil
}

// createRegisteredAccount persists an application (no session) or an account with
// its first session, minted through newSessionToken so the token exists only once
// the row committed.
func (s *AuthService) createRegisteredAccount(ctx context.Context, mode RegistrationMode, in RegisterInput, hash string) (uid int64, token string, err error) {
	role := int(permissions.MemberRoleID)
	switch mode {
	case RegistrationApproval:
		// The insert re-checks the cap: admitRegistration's count is only the cheap
		// pre-bcrypt refusal.
		uid, err = s.st.CreatePendingUser(ctx, in.Username, hash, role, maxPendingRegistrations)
		if errors.Is(err, db.ErrPendingQueueFull) {
			return 0, "", ErrRegistrationQueueFull
		}
	case RegistrationOpen:
		token, err = newSessionToken(func(tokenHash string) (err error) {
			uid, err = s.st.CreateUserWithSession(ctx, in.Username, hash, role, tokenHash, in.Device, in.IP)
			return err
		})
	case RegistrationInvite, RegistrationClosed:
		// Closed never reaches here; invite mode spends the code and commits with the session.
		token, err = newSessionToken(func(tokenHash string) (err error) {
			uid, err = s.st.CreateUserWithInvite(ctx, in.Username, hash, role, in.InviteCode, tokenHash, in.Device, in.IP)
			return err
		})
	}
	return uid, token, err
}

// Register creates the account the current mode allows: invite consumes the
// invite and issues a session, open issues one without, approval records a locked
// application and issues nothing. Closed is refused again in case a caller skips
// RegistrationPolicy.
func (s *AuthService) Register(ctx context.Context, in RegisterInput) (*AuthResult, error) {
	mode, refund, err := s.admitRegistration(ctx, in)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			refund()
		}
	}()

	// Hash before consuming the invite so a hashing failure does not burn it. The
	// hash is full-cost bcrypt, so it takes an admission slot like a compare does and
	// a refusal burns nothing.
	release, err := s.acquireAdmission(ctx)
	if err != nil {
		return nil, err
	}
	hash, err := auth.HashPassword(in.Password)
	release()
	if err != nil {
		slog.Error("register: password hashing failed", "err", err)
		return nil, ErrPasswordHash
	}

	// The session is persisted by CreateUserWithInvite's transaction, so the
	// account, invite use and first session commit together; a fault at any step
	// rolls the whole registration back and burns nothing.
	uid, token, err := s.createRegisteredAccount(ctx, mode, in, hash)
	committed = err == nil
	if err != nil {
		switch {
		case errors.Is(err, ErrRegistrationQueueFull):
			return nil, ErrRegistrationQueueFull
		case db.IsUniqueConstraintError(err):
			slog.WarnContext(ctx, "registration refused", "cause", "username taken",
				"ip", in.IP, "username", in.Username)
			return nil, ErrRegistrationRejected
		case errors.Is(err, db.ErrNotFound):
			// The invite UPDATE matched no row; read it back to name why. The public answer
			// stays generic.
			slog.WarnContext(ctx, "registration refused", "cause", s.inviteRefusalCause(ctx, in.InviteCode),
				"ip", in.IP, "username", in.Username)
			return nil, ErrRegistrationRejected
		default:
			slog.Error("register: account creation failed", "err", err, "username", in.Username)
			return nil, ErrRegistrationFailed
		}
	}

	if mode == RegistrationApproval {
		slog.Info("registration application recorded", "username", in.Username, "user_id", uid, "ip", in.IP)
		db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "user_register", "user", uid,
			"application recorded, awaiting approval")
		return &AuthResult{PendingApproval: true}, nil
	}

	slog.Info("user registered", "username", in.Username, "user_id", uid, "ip", in.IP, "mode", string(mode))
	db.WriteAudit(context.WithoutCancel(ctx), s.st, uid, "user_register", "user", uid,
		"new account created ("+string(mode)+" registration)")
	// Greet is best effort on a detached context: a dropped client still gets its
	// welcome and a failure never fails the registration.
	s.welcome.Greet(ctx, uid)

	user, err := s.st.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		slog.Error("failed to fetch user after registration", "user_id", uid, "error", err)
		return nil, ErrRegisteredUserFetch
	}
	return &AuthResult{Token: token, User: user}, nil
}

// inviteRefusalCause names why the invite UPDATE matched no row, for the operator
// log only: the code is never logged, a store fault is its own cause, and a wrong
// guess here must never widen what the client is told.
func (s *AuthService) inviteRefusalCause(ctx context.Context, code string) string {
	invite, err := s.st.GetInvite(ctx, code)
	if err != nil {
		slog.WarnContext(ctx, "registration refusal: invite read-back failed", "err", err)
		return "invite lookup failed"
	}
	if invite == nil {
		return "invite unknown"
	}
	switch {
	case invite.Revoked:
		return "invite revoked"
	case invite.MaxUses != nil && invite.Uses >= *invite.MaxUses:
		return "invite exhausted"
	case invite.Expired(time.Now()):
		return "invite expired"
	default:
		// The row looked redeemable but the atomic UPDATE matched nothing: a concurrent
		// redemption won.
		return "invite exhausted"
	}
}
