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
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ─── Collaborators and shapes ────────────────────────────────────────────────

// AuthBroadcaster is how the auth slice tells connected WebSocket clients that
// an account is gone. Satisfied by *ws.Hub, which already implements
// BroadcastMemberBan for the admin ban path that self-deletion mirrors. A nil
// broadcaster sends nothing and other clients converge on their next
// reconnect.
type AuthBroadcaster interface {
	BroadcastMemberBan(userID int64)
}

// Principal is the authenticated caller api.AuthMiddleware resolved for a
// request. Session is nil for an API-token principal.
type Principal struct {
	User    *db.User
	Session *db.Session
}

// RegisterInput is a validated registration: the transport has already
// trimmed, sanitized and format-checked Username, checked Password strength
// and trimmed InviteCode. Device and IP describe the request that will own
// the issued session.
type RegisterInput struct {
	Username   string
	Password   string
	InviteCode string
	Device     string
	IP         string
}

// LoginInput is one login attempt. Username is trimmed; Password is not —
// passwords may carry leading or trailing whitespace on purpose.
type LoginInput struct {
	Username string
	Password string
	Device   string
	IP       string
}

// AuthResult is a successful register, login or second-factor step. Either a
// session was issued (Token and User) or a two-factor challenge was started
// (PartialToken with Requires2FA) — never both.
type AuthResult struct {
	Token        string
	PartialToken string
	Requires2FA  bool
	User         *db.User
	// PendingApproval is an approval-mode registration: the application is
	// recorded, no session is issued, and an admin decides (B4-1).
	PendingApproval bool
	// RecoveryCodesRemaining is set when an emergency recovery code, not a
	// TOTP code, completed the second step: how many the account has left,
	// so the client can prompt for regeneration (nil otherwise).
	RecoveryCodesRemaining *int
}

// TOTPEnrollment is what EnableTOTP hands the caller: the otpauth URI for
// the authenticator app and the emergency recovery codes (BPR-046), shown
// exactly once. The server keeps bcrypt hashes of the codes; the plaintext
// exists only in this value.
type TOTPEnrollment struct {
	URI           string
	RecoveryCodes []string
}

// TOTPChangeResult reports a committed 2FA enable or disable. Warning is
// non-empty when the state change committed but revoking the caller's other
// sessions failed: a partial success the transport must answer with 200 and
// the warning, never a 5xx, because the change is already durable.
type TOTPChangeResult struct {
	SessionsRevoked int64
	Warning         string
}

// ─── Limits ──────────────────────────────────────────────────────────────────
//
// Moved from api/constants.go with the orchestration that reads them (B3-2).

const (
	// loginFailureThreshold is the number of failed login attempts (within
	// loginFailureWindow) before the IP is locked out.
	loginFailureThreshold = 9

	// loginFailureWindow is the sliding window for counting login failures.
	loginFailureWindow = 15 * time.Minute

	// loginLockoutDuration is how long an IP is locked out after exceeding
	// loginFailureThreshold.
	loginLockoutDuration = 15 * time.Minute

	// loginUserFailureThreshold is the number of failed login attempts for a
	// specific username (regardless of source IP) before the account is locked.
	loginUserFailureThreshold = 9

	// loginUserFailureWindow is the sliding window for per-username login failures.
	loginUserFailureWindow = 15 * time.Minute

	// loginUserLockoutDuration is how long a username is locked after exceeding
	// loginUserFailureThreshold.
	loginUserLockoutDuration = 15 * time.Minute

	// deleteAccountFailureThreshold is the number of wrong-password attempts
	// before the per-user lockout kicks in.
	deleteAccountFailureThreshold = 3

	// deleteAccountFailureWindow is the sliding window for counting
	// delete-account password failures.
	deleteAccountFailureWindow = 15 * time.Minute

	// deleteAccountLockoutDuration is how long the account-deletion endpoint
	// is locked after exceeding deleteAccountFailureThreshold.
	deleteAccountLockoutDuration = 15 * time.Minute

	// totpFailureRateLimit is the maximum TOTP verification failures per user
	// within totpFailureWindow before the user is rate-limited.
	totpFailureRateLimit = 10

	// totpFailureWindow is the sliding window for counting per-user TOTP failures.
	totpFailureWindow = 15 * time.Minute

	// partialAuthMaxFailures is the number of failed TOTP attempts on a single
	// partial-auth challenge before it is revoked.
	partialAuthMaxFailures = 5

	// partialAuthStoreTTL is the lifetime of a partial-auth (2FA) challenge token.
	partialAuthStoreTTL = 10 * time.Minute

	// pendingTOTPStoreTTL is the lifetime of a pending TOTP enrollment secret.
	pendingTOTPStoreTTL = 10 * time.Minute
)

// The password-confirmation lockout is shared with the change-password route
// (api/profile_handler.go, the user family in B3-8), so one key space
// ("pw_confirm_fail", "pw_confirm_lock") and one budget cover every route
// that asks for the current password.
const (
	// PwConfirmFailureThreshold is the number of wrong-password attempts on
	// password-confirmation endpoints before per-user lockout kicks in.
	PwConfirmFailureThreshold = 3

	// PwConfirmFailureWindow is the sliding window for per-user password
	// confirmation failures.
	PwConfirmFailureWindow = 15 * time.Minute

	// PwConfirmLockoutDuration is how long password-confirmation endpoints are
	// locked after exceeding PwConfirmFailureThreshold.
	PwConfirmLockoutDuration = 15 * time.Minute
)

// ─── Errors ──────────────────────────────────────────────────────────────────

// Category sentinels the transport maps to a status and code. ErrRateLimited,
// ErrForbidden, ErrBadRequest, ErrConflict and ErrInternal are the shared set
// in message.go; these two are what auth adds.
var (
	// ErrUnauthorized is a credential or challenge that does not authenticate
	// (401). Deliberately generic: the enumeration guard depends on every
	// failed login looking the same.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrInvalidInput is a request the auth routes refuse as INVALID_INPUT
	// (400) — the password-confirmation refusals.
	ErrInvalidInput = errors.New("invalid input")
)

// authError is one refusal the auth slice can return. Error() is the exact
// public message the pre-B3-2 handler wrote — B3-1's characterization rows
// pin it byte for byte — and Is reports the category sentinel the transport
// maps to a status and code, so errors.Is matches both the named value and
// its category.
type authError struct {
	kind error
	msg  string
}

func (e *authError) Error() string        { return e.msg }
func (e *authError) Is(target error) bool { return target == e.kind }

// Every refusal below is returned bare, never wrapped around the cause: the
// transport echoes Error() to the client, and the cause (a database error, a
// decrypt failure) is logged here instead.
var (
	// Registration.
	ErrRegistrationPolicyUnavailable = &authError{ErrInternal, "failed to load registration policy"}
	ErrRegistrationClosed            = &authError{ErrForbidden, "registration is currently closed"}
	// ErrAccountPending is an approval-mode application trying to sign in
	// before an admin approved it (B4-1).
	ErrAccountPending = &authError{ErrForbidden, "account is awaiting approval"}
	// ErrRegistrationRateLimited and ErrRegistrationQueueFull are the
	// per-mode abuse limits of open and approval registration (owner
	// decision 1): a per-address creation budget and a cap on the approval
	// queue. Both share the rate-limit category, so the client backs off.
	ErrRegistrationRateLimited = &authError{ErrRateLimited, "too many registrations from this address, try again later"}
	ErrRegistrationQueueFull   = &authError{ErrRateLimited, "registration queue is full, try again later"}
	ErrRegistrationRequires2FA = &authError{ErrForbidden, "registration is unavailable while two-factor authentication is required"}
	ErrPasswordHash            = &authError{ErrInternal, "failed to process registration"}
	// ErrRegistrationRejected is the generic register refusal: an unknown,
	// used-up or expired invite and a taken username share it so the response
	// reveals neither. The transport writes it as 400 INVALID_CREDENTIALS.
	ErrRegistrationRejected = &authError{ErrBadRequest, "invalid invite or credentials"}
	ErrRegistrationFailed   = &authError{ErrInternal, "registration failed — please try again"}
	ErrSessionIssue         = &authError{ErrInternal, "failed to create session"}
	ErrRegisteredUserFetch  = &authError{ErrInternal, "registration succeeded but user fetch failed"}

	// Login.
	ErrLockedOut             = &authError{ErrRateLimited, "account temporarily locked due to too many failed attempts"}
	ErrLoginUnavailable      = &authError{ErrInternal, "login temporarily unavailable"}
	ErrInvalidCredentials    = &authError{ErrUnauthorized, "invalid credentials"}
	ErrBanned                = &authError{ErrForbidden, "your account has been suspended"}
	ErrAuthPolicyUnavailable = &authError{ErrInternal, "failed to load authentication policy"}
	ErrTOTPChallengeStart    = &authError{ErrInternal, "failed to start two-factor challenge"}
	ErrRequire2FA            = &authError{ErrForbidden, "two-factor authentication must be enabled on this account before login"}

	// Logout.
	ErrLogoutFailed = &authError{ErrInternal, "failed to logout"}

	// Password confirmation (account deletion and TOTP management).
	ErrTooManyAttempts = &authError{ErrRateLimited, "too many failed attempts, try again later"}
	// ErrAuthBusy is the B4-4 admission refusal: the process-wide budget for
	// expensive authentication work is exhausted, so this attempt ran no
	// bcrypt and consumed no lockout attempt. Same category as the lockouts
	// (429 RATE_LIMITED); a message of its own so an operator can tell load
	// from abuse.
	ErrAuthBusy                   = &authError{ErrRateLimited, "too many authentication attempts in progress, try again later"}
	ErrPasswordRequired           = &authError{ErrInvalidInput, "password is required"}
	ErrIncorrectPassword          = &authError{ErrInvalidInput, "incorrect password"}
	ErrPasswordConfirmationFailed = &authError{ErrInvalidInput, "password confirmation failed"}

	// Account deletion.
	ErrLastAdmin           = &authError{ErrForbidden, "cannot delete the last admin account"}
	ErrDeleteAccountFailed = &authError{ErrInternal, "failed to delete account"}

	// Second factor.
	ErrTOTPChallengeInvalid = &authError{ErrUnauthorized, "invalid or expired two-factor challenge"}
	ErrTOTPSecretUnreadable = &authError{ErrInternal, "failed to verify two-factor code"}
	// ErrTOTPUnavailable is a store fault while loading the challenged user
	// (OC-0377): an outage, not a bad challenge, so no attempt is charged.
	ErrTOTPUnavailable = &authError{ErrInternal, "two-factor verification temporarily unavailable"}
	ErrTOTPCodeInvalid = &authError{ErrUnauthorized, "invalid two-factor code"}
	// ErrTOTPAlreadyEnabled is written by the transport as 409
	// TOTP_ALREADY_ENABLED, not the generic CONFLICT code.
	ErrTOTPAlreadyEnabled   = &authError{ErrConflict, "disable 2FA before re-enabling"}
	ErrTOTPSecretGenerate   = &authError{ErrInternal, "failed to generate two-factor secret"}
	ErrNoPendingTOTP        = &authError{ErrBadRequest, "no pending two-factor enrollment found"}
	ErrTOTPEnableFailed     = &authError{ErrInternal, "failed to enable two-factor authentication"}
	ErrTOTPRequiredByServer = &authError{ErrForbidden, "two-factor authentication is required for this server"}
	ErrTOTPDisableFailed    = &authError{ErrInternal, "failed to disable two-factor authentication"}
	// ErrTOTPEnrollmentStage is a persister fault while staging an enrolment
	// (B4-3): the pending secret could not be made durable, so none is staged.
	ErrTOTPEnrollmentStage = &authError{ErrInternal, "failed to stage two-factor enrolment"}

	// Recovery codes (B4-3).
	ErrRecoveryCodesRequireTOTP = &authError{ErrConflict, "enable two-factor authentication before requesting recovery codes"}
	ErrRecoveryCodesFailed      = &authError{ErrInternal, "failed to issue recovery codes"}
)

// ─── Service ─────────────────────────────────────────────────────────────────

// AuthService owns the auth slice's orchestration: the lockout and
// enumeration guards, the password and second-factor checks, session issue
// and revoke, the audit writes and the member_ban broadcast on self-erasure.
// Persistence stays in db behind Store. B3-2 moved every line here verbatim
// from api/auth_handler.go and api/totp_handler.go at 71d867cb; B3-1's
// characterization rows pin the behaviour.
type AuthService struct {
	// issueMu serializes the two-budget reservation of IssueRecoveryAssist.
	issueMu     syncutil.Mutex
	st          Store
	limiter     *auth.RateLimiter
	partial     *auth.PartialAuthStore
	pending     *auth.PendingTOTPStore
	usedCodes   *auth.UsedTOTPCodeStore
	totpKey     []byte
	broadcaster AuthBroadcaster
	// erasure runs DeleteAccount's erasure (B4-9). NewAuthService builds a
	// private one over st; the composition root swaps in the shared
	// Services.Erasure (UseErasure) so the file storage is installed once.
	erasure *ErasureService
}

// NewAuthService wires the auth slice. limiter is the shared auth rate
// limiter (lockouts are keyed inside it); totpKey is the AES-256 key that
// encrypts TOTP secrets at rest; broadcaster may be nil. The three
// second-factor stores — partial-login challenges, pending TOTP enrolments,
// used TOTP codes — are created here with the fixed TTLs the route mount
// used to own, and since B4-3 they persist through st (S-13): the database
// is authoritative, so a restart keeps an in-flight challenge, a staged
// enrolment and the replay window, and a store fault fails closed.
func NewAuthService(st Store, limiter *auth.RateLimiter, totpKey []byte, broadcaster AuthBroadcaster) *AuthService {
	return &AuthService{
		st:          st,
		limiter:     limiter,
		partial:     auth.NewPartialAuthStore(partialAuthStoreTTL).WithPersister(st),
		pending:     auth.NewPendingTOTPStore(pendingTOTPStoreTTL).WithPersister(st, totpKey),
		usedCodes:   auth.NewUsedTOTPCodeStore().WithPersister(st),
		totpKey:     totpKey,
		broadcaster: broadcaster,
		erasure:     NewErasureService(st),
	}
}

// UseErasure makes DeleteAccount run through e — the bundle's shared runner,
// which carries the upload storage — instead of the private one.
func (s *AuthService) UseErasure(e *ErasureService) {
	if e != nil {
		s.erasure = e
	}
}

// RegistrationPolicy reports whether registration is currently permitted. It
// runs before the transport reads any credential: a closed server refuses
// even a malformed body with the policy's 403.
func (s *AuthService) RegistrationPolicy(ctx context.Context) error {
	mode, err := registrationModeSetting(ctx, s.st)
	if err != nil {
		return ErrRegistrationPolicyUnavailable
	}
	if mode == RegistrationClosed {
		return ErrRegistrationClosed
	}

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		return ErrRegistrationPolicyUnavailable
	}
	if require2FA {
		return ErrRegistrationRequires2FA
	}
	return nil
}

// Per-mode abuse limits for the modes that need no invite (owner decision
// 1): one address may create this many accounts or applications per day,
// and the approval queue is capped.
const (
	inviteFreeRegistrationsPerIPPerDay = 5
	maxPendingRegistrations            = 100
)

// admitRegistration runs the mode's gates before any bcrypt work: closed
// refuses, invite mode needs a code to redeem, the invite-free modes spend
// the address budget, and approval mode needs room in the queue.
func (s *AuthService) admitRegistration(ctx context.Context, in RegisterInput) (RegistrationMode, error) {
	mode, err := registrationModeSetting(ctx, s.st)
	if err != nil {
		return "", ErrRegistrationPolicyUnavailable
	}
	switch mode {
	case RegistrationClosed:
		return "", ErrRegistrationClosed
	case RegistrationInvite:
		if strings.TrimSpace(in.InviteCode) == "" {
			// Nothing to redeem: the same answer a bad code gets, so the
			// response reveals nothing new.
			return "", ErrRegistrationRejected
		}
		return mode, nil
	case RegistrationApproval, RegistrationOpen:
		// Gated below.
	}
	// Without an invite to spend, the address is the only budget.
	if !s.limiter.Allow("register_ip:"+in.IP, inviteFreeRegistrationsPerIPPerDay, 24*time.Hour) {
		return "", ErrRegistrationRateLimited
	}
	if mode == RegistrationApproval {
		pending, err := s.st.CountPendingUsers(ctx)
		if err != nil {
			return "", ErrRegistrationPolicyUnavailable
		}
		if pending >= maxPendingRegistrations {
			return "", ErrRegistrationQueueFull
		}
	}
	return mode, nil
}

// createRegisteredAccount persists what the mode admits: an application
// (no session), or an account with its first session, minted through
// newSessionToken so the token exists only once the row committed.
func (s *AuthService) createRegisteredAccount(ctx context.Context, mode RegistrationMode, in RegisterInput, hash string) (uid int64, token string, err error) {
	role := int(permissions.MemberRoleID)
	switch mode {
	case RegistrationApproval:
		// The cap is re-checked by the insert itself: admitRegistration's
		// count is the cheap refusal before bcrypt, this is the guarantee.
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
		// Closed never reaches here (admitRegistration refuses it); invite
		// mode spends the code and the account commits with its session.
		token, err = newSessionToken(func(tokenHash string) (err error) {
			uid, err = s.st.CreateUserWithInvite(ctx, in.Username, hash, role, in.InviteCode, tokenHash, in.Device, in.IP)
			return err
		})
	}
	return uid, token, err
}

// Register creates the account the current registration mode allows
// (B4-1): invite mode consumes the invite and issues a session, open mode
// issues a session without one, approval mode records a locked application
// and issues nothing. Closed mode never reaches here (RegistrationPolicy
// gates the route) but is refused again in case a caller skips the gate.
func (s *AuthService) Register(ctx context.Context, in RegisterInput) (*AuthResult, error) {
	mode, err := s.admitRegistration(ctx, in)
	if err != nil {
		return nil, err
	}

	// Hash password before consuming the invite so that a hashing failure
	// does not burn a valid invite code.
	// The hash is bcrypt at full cost, so it takes an admission slot like a
	// compare does (B4-4): a burst of registrations cannot grow the CPU
	// backlog past the budget, and a refusal burns nothing.
	hash, admitted, err := s.limiter.Admission().HashPassword(in.Password)
	if !admitted {
		return nil, ErrAuthBusy
	}
	if err != nil {
		return nil, ErrPasswordHash
	}

	// The session token is issued through the same path as login's, but it is
	// persisted by CreateUserWithInvite's transaction, so the account, the
	// invite use and the first session commit together: a fault at any step
	// — the session insert included — rolls the whole registration back and
	// burns nothing (OC-0376).
	uid, token, err := s.createRegisteredAccount(ctx, mode, in, hash)
	if err != nil {
		// UNIQUE constraint violation → duplicate username → 400.
		// Any other error → 500.
		switch {
		case errors.Is(err, ErrRegistrationQueueFull):
			return nil, ErrRegistrationQueueFull
		case db.IsUniqueConstraintError(err):
			return nil, ErrRegistrationRejected
		case errors.Is(err, db.ErrNotFound):
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

	user, err := s.st.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		slog.Error("failed to fetch user after registration", "user_id", uid, "error", err)
		return nil, ErrRegisteredUserFetch
	}
	return &AuthResult{Token: token, User: user}, nil
}

// Login runs the lockout gates and the constant-time password check, then
// issues a session or, for an enrolled account, starts a two-factor
// challenge.
func (s *AuthService) Login(ctx context.Context, in LoginInput) (*AuthResult, error) {
	user, err := s.authenticate(ctx, in)
	if err != nil {
		return nil, err
	}

	if auth.IsEffectivelyBanned(user) {
		slog.Warn("banned user login attempt", "username", user.Username, "user_id", user.ID, "ip", in.IP)
		db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "login_blocked_banned", "user", user.ID,
			"banned user attempted login from "+in.IP)
		return nil, ErrBanned
	}
	// An approval-mode application holds the username and the password, but
	// is not an account until an admin says so (B4-1).
	if user.PendingApproval() {
		slog.Info("pending application login attempt", "user_id", user.ID, "ip", in.IP)
		return nil, ErrAccountPending
	}

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		return nil, ErrAuthPolicyUnavailable
	}
	if user.TOTPSecret != nil {
		partialToken, err := s.partial.Issue(ctx, user.ID, in.Device, in.IP)
		if err != nil {
			slog.Error("failed to issue two-factor challenge", "user_id", user.ID, "error", err)
			return nil, ErrTOTPChallengeStart
		}
		return &AuthResult{PartialToken: partialToken, Requires2FA: true}, nil
	}
	if require2FA {
		return nil, ErrRequire2FA
	}

	// Issue session.
	token, err := issueSession(ctx, s.st, user.ID, in.Device, in.IP)
	if err != nil {
		return nil, ErrSessionIssue
	}

	// Don't set status to "online" here — the WebSocket connection in
	// serve.go does that when the user actually connects. Setting it here
	// would leave the user permanently "online" if they never open a WS
	// connection or if the client crashes before connecting.
	slog.Info("user logged in", "username", user.Username, "user_id", user.ID, "ip", in.IP)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "user_login", "user", user.ID,
		"logged in from "+in.IP)
	return &AuthResult{Token: token, User: user}, nil
}

// authenticate runs the lockout gates, the constant-time password compare and
// the failure accounting for one login attempt, returning the authenticated
// user or the refusal.
func (s *AuthService) authenticate(ctx context.Context, in LoginInput) (*db.User, error) {
	// Check per-IP lockout first.
	lockKey := "login_lock:" + in.IP
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrLockedOut
	}

	// BUG-110: Also check per-username lockout to prevent distributed brute force.
	// F1: canonicalize the username the same way GetUserByUsername does (COLLATE
	// NOCASE) before keying the lockout, so case variants of one account
	// (admin/Admin/ADMIN) share a single bucket instead of each getting its own.
	// NOCASE folds ASCII A-Z only, so the key must too (db.LowerASCII, not
	// strings.ToLower): two accounts that differ only in non-ASCII case are
	// two rows, and must never share a bucket (OC-0324).
	unameKey := db.LowerASCII(in.Username)
	userLockKey := "login_user_lock:" + unameKey
	if s.limiter.IsLockedOut(userLockKey) {
		return nil, ErrLockedOut
	}

	// Constant-time lookup: always attempt bcrypt compare even when user
	// does not exist to prevent timing-based username enumeration.
	user, err := s.st.GetUserByUsername(ctx, in.Username)

	// Distinguish DB errors from authentication failures. DB errors
	// should NOT increment the rate limiter — otherwise a transient
	// DB outage would lock out legitimate users.
	if err != nil && user == nil {
		// Could be a real DB error or simply "user not found".
		// GetUserByUsername returns (nil, nil) for not-found, so a
		// non-nil error here is a genuine DB failure.
		slog.Error("login: GetUserByUsername failed", "err", err, "ip", in.IP)
		return nil, ErrLoginUnavailable
	}

	failKey := "login_fail:" + in.IP
	userFailKey := "login_user_fail:" + unameKey
	// F3: atomically reserve this attempt BEFORE the bcrypt compare. The
	// read-only IsLockedOut gates above are check-then-act: N concurrent
	// requests all pass them before any failure is recorded below, so the
	// per-username cap — the only cross-IP brute-force defence — bound
	// only sequential attackers. Allow records the attempt under the
	// limiter's lock, capping a concurrent burst at the same budget a
	// sequential attacker gets. Sized at threshold+1 so the sequential
	// accepted-input set is unchanged: failures 1–10 still land, the 10th
	// still trips the lockout (via the Check below), and a correct
	// password on attempt 10 still succeeds — successful logins reset
	// both counters. The reservation sits after the DB-error return above
	// so a transient DB outage still does not consume attempts.
	// Deliberately NOT auth.ScaledLimit for the per-username budget: that cap
	// is keyed per USER and is the only cross-IP brute-force defence, so
	// scaling it with the shared-NAT multiplier would hand a distributed
	// attacker more guesses (api/constants_test.go pins this call site).
	// B4-4: take an admission slot before the attempt is reserved, so an
	// over-budget request is refused without charging the failure budgets
	// and without a bcrypt compare; the slot goes back right after the
	// compare, the only expensive step.
	release, admitted := s.limiter.Admission().TryAcquire()
	if !admitted {
		return nil, ErrAuthBusy
	}
	defer release()
	if !s.limiter.Allow(failKey, auth.ScaledLimit(loginFailureThreshold)+1, loginFailureWindow) ||
		!s.limiter.Allow(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
		return nil, ErrLockedOut
	}
	// Always run the password check — with an empty hash when the user does
	// not exist. auth.CheckPassword performs a dummy bcrypt comparison for an
	// empty hash, so bcrypt executes on every path and response time stays
	// constant, preventing timing-based username enumeration. (A `user == nil
	// || CheckPassword(...)` short-circuit would skip bcrypt entirely for
	// unknown usernames, reintroducing the timing side-channel.)
	storedHash := ""
	if user != nil {
		storedHash = user.PasswordHash
	}
	matched := auth.CheckPassword(storedHash, in.Password)
	release()
	if !matched {
		// The attempt was already recorded atomically up-front (F3); here
		// only decide the lockouts, at the same boundary as before: the
		// 10th in-window failure locks the key. Check is read-only, so
		// the reservation is not double-counted.
		if !s.limiter.Check(failKey, auth.ScaledLimit(loginFailureThreshold)+1, loginFailureWindow) {
			s.limiter.Lockout(ctx, lockKey, loginLockoutDuration)
		}
		// BUG-110: per-username lockout on threshold.
		if !s.limiter.Check(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
			s.limiter.Lockout(ctx, userLockKey, loginUserLockoutDuration)
		}
		slog.Info("login failed", "ip", in.IP, "username_len", len(in.Username))
		return nil, ErrInvalidCredentials
	}

	// Reset failure counters on success.
	s.limiter.Reset(ctx, failKey)
	s.limiter.Reset(ctx, userFailKey)
	return user, nil
}

// VerifyTOTP completes a challenge Login started and issues the session,
// bound to the login request's device and IP rather than this one's.
func (s *AuthService) VerifyTOTP(ctx context.Context, partialToken, code string) (*AuthResult, error) {
	code = strings.TrimSpace(code)
	challenge, ok := s.partial.Lookup(ctx, partialToken)
	if !ok {
		return nil, ErrTOTPChallengeInvalid
	}

	// Refuse an exhausted per-user budget before touching the store: the
	// read-only Check costs nothing and charges nothing, so rotating source
	// IPs cannot drive user reads and secret decryptions past the cap
	// (Codex P2 on PR #1454). The atomic Allow below still records the
	// attempt only once the store read succeeded (OC-0377).
	totpRateLimitKey := auth.Key("totp_fail", challenge.UserID)
	if !s.limiter.Check(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
		return nil, ErrTooManyAttempts
	}

	user, secret, err := s.challengeSecret(ctx, challenge.UserID)
	if err != nil {
		return nil, err
	}

	// Atomically record this attempt and reject once the per-user failure cap
	// is reached. Recording up-front — rather than a read-only Check now and
	// Allow only on failure — closes a TOCTOU where many concurrent requests
	// reusing one valid partial token all pass the read-only check before any
	// failure is recorded, defeating the per-user brute-force cap (the only
	// cross-IP defence). A successful verification resets the counter below,
	// so legitimate retries are not penalised.
	// Deliberately NOT auth.ScaledLimit: this cap is keyed per USER, and it
	// is the only cross-IP brute-force defence on TOTP codes. The
	// multiplier exists for shared-NAT per-IP limits; scaling a per-user
	// threshold with it would hand a distributed attacker more guesses.
	// Mirrors loginUserFailureThreshold staying unscaled in authenticate.
	// The reservation sits after the store read above, as in authenticate,
	// so an outage does not consume attempts (OC-0377); it still precedes
	// the code compare, the check-then-act the up-front record closes.
	// An emergency recovery code is matched against up to ten bcrypt hashes,
	// so it takes an admission slot before the attempt is reserved (B4-4): a
	// refusal charges nothing. A TOTP code is an HMAC and needs no slot.
	canonical, isRecovery := auth.NormalizeRecoveryCode(code)
	release := func() {}
	if isRecovery {
		var admitted bool
		if release, admitted = s.limiter.Admission().TryAcquire(); !admitted {
			return nil, ErrAuthBusy
		}
		defer release()
	}
	if !s.limiter.Allow(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
		return nil, ErrTooManyAttempts
	}

	// An emergency recovery code (B4-3) stands in for the TOTP code: it has a
	// different shape, so the input routes itself. A recovery code is spent
	// by the conditional update that consumed it, not by the replay window,
	// so the Unmark below applies to TOTP codes only.
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
		// The attempt was already recorded atomically up-front via
		// limiter.Allow; only the per-partial-token counter is advanced here.
		s.partial.RegisterFailure(ctx, partialToken, partialAuthMaxFailures)
		return nil, ErrTOTPCodeInvalid
	}

	s.limiter.Reset(ctx, totpRateLimitKey)

	claimed, ok := s.partial.Consume(ctx, partialToken)
	if !ok {
		// The claim lost: a concurrent verify consumed the challenge (or it
		// expired) after this request marked its code. Release the code —
		// if the winner is mid-recovery (Consume → issueSession failed →
		// Restore), the restored token must not be stuck behind this mark
		// until the authenticator rolls over (Codex P2 on PR #1454). A spent
		// recovery code stays spent: the account holds nine more, and
		// un-spending one would hand a racing verifier a second use.
		if recoveryRemaining == nil {
			s.usedCodes.Unmark(ctx, user.ID, code)
		}
		return nil, ErrTOTPChallengeInvalid
	}

	token, err := issueSession(ctx, s.st, user.ID, challenge.Device, challenge.IP)
	if err != nil {
		// The second factor was verified; a store fault must not discard it
		// (OC-0378). The claim stays atomic and first — two concurrent
		// verifies can never both reach issueSession — so on failure put the
		// challenge back under the same token (the client still holds it) and
		// release the accepted code: the retry completes the login without
		// another password step. Code first, then token, so a concurrent
		// retry never finds a live token with a dead code.
		if recoveryRemaining == nil {
			s.usedCodes.Unmark(ctx, user.ID, code)
		}
		s.partial.Restore(ctx, partialToken, claimed)
		return nil, ErrSessionIssue
	}

	detail := "two-factor verification completed from " + challenge.IP
	if recoveryRemaining != nil {
		detail = "two-factor verification completed with a recovery code from " + challenge.IP
	}
	slog.Info("totp verified", "user_id", user.ID, "ip", challenge.IP, "recovery_code", recoveryRemaining != nil)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "totp_verified", "user", user.ID, detail)
	return &AuthResult{Token: token, User: user, RecoveryCodesRemaining: recoveryRemaining}, nil
}

// consumeRecoveryCode spends the recovery code matching canonical, if the
// user holds one. matched is false for no match or for a code another
// verification spent first; remaining is how many the user has left, or -1
// when the count could not be read after a successful spend (the login
// still proceeds — the code is gone either way).
func (s *AuthService) consumeRecoveryCode(ctx context.Context, userID int64, canonical string) (remaining int, matched bool, err error) {
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

// RegenerateRecoveryCodes confirms the password and replaces the account's
// emergency recovery codes with a fresh set; the old set is invalid the
// moment the new one is stored (one transaction). Requires 2FA to be
// enabled — the codes stand in for a TOTP code and mean nothing without one.
func (s *AuthService) RegenerateRecoveryCodes(ctx context.Context, p Principal, password string) ([]string, error) {
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
func (s *AuthService) issueRecoveryCodes(ctx context.Context, userID int64) ([]string, error) {
	// Ten bcrypt hashes: one admission slot (B4-4), like the compare that
	// admitted the caller a moment ago.
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

// challengeSecret resolves the user behind a partial-auth challenge and
// returns their decrypted TOTP secret.
func (s *AuthService) challengeSecret(ctx context.Context, challengeUserID int64) (*db.User, string, error) {
	user, err := s.st.GetUserByID(ctx, challengeUserID)
	if err != nil {
		// GetUserByID answers (nil, nil) for an unknown user, so a non-nil
		// error is a store fault: report the outage, not a bad challenge
		// (OC-0377). VerifyTOTP records no attempt for it.
		slog.Error("verify-totp: GetUserByID failed", "err", err, "user_id", challengeUserID)
		return nil, "", ErrTOTPUnavailable
	}
	if user == nil || user.TOTPSecret == nil {
		return nil, "", ErrTOTPChallengeInvalid
	}

	// A ban can land inside the partial-token window; the login path
	// refuses banned users right after the password compare, so the
	// second factor must refuse them too.
	if auth.IsEffectivelyBanned(user) {
		return nil, "", ErrBanned
	}

	secret, decErr := auth.DecryptTOTPSecret(s.totpKey, *user.TOTPSecret)
	if decErr != nil {
		slog.Error("failed to decrypt TOTP secret", "user_id", user.ID, "error", decErr)
		return nil, "", ErrTOTPSecretUnreadable
	}

	return user, secret, nil
}

// Logout revokes p.Session server-side and clears the custom status. p.Session
// must be non-nil: the transport answers an API-token principal with 401
// before calling.
func (s *AuthService) Logout(ctx context.Context, p Principal) error {
	sess := p.Session
	if sess == nil {
		return errors.New("logout: principal has no session")
	}

	// The client clears its token optimistically — once logout reaches the
	// server, the revocation must not die with a dropped connection.
	if err := s.st.DeleteSession(context.WithoutCancel(ctx), sess.TokenHash); err != nil {
		return ErrLogoutFailed
	}

	// A custom status is a "what I am doing right now" note. Leaving it
	// standing after the user signed out states something about them that
	// is no longer true, so logout clears it — unlike the chosen presence
	// status, which is a preference and deliberately survives.
	if err := s.st.UpdateUserCustomStatus(context.WithoutCancel(ctx), sess.UserID, nil); err != nil {
		slog.Warn("failed to clear custom status on logout", "user_id", sess.UserID, "err", err)
	}

	slog.Info("user logged out", "user_id", sess.UserID)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, sess.UserID, "user_logout", "user", sess.UserID, "")
	return nil
}

// DeleteAccount confirms the password, erases the account (B4-9: every data
// class the subject holds is hard-deleted in one transaction and the
// subject's files are removed, journaled so an interruption resumes) and
// broadcasts member_ban. Progressive lockout mirrors login: 3 failures →
// 15-min lock. ip is only logged and audited; the username is never logged.
//
// A message the subject sends over an already-authenticated socket cannot
// outlive the erasure (data-lifecycle O1 A4): the writer connection
// serialises it either before the transaction, which then deletes it, or
// after, when messages.user_id no longer has a users row to reference and
// the insert fails the foreign-key check. The member_ban broadcast then
// disconnects the socket.
func (s *AuthService) DeleteAccount(ctx context.Context, p Principal, password, ip string) error {
	user := p.User

	// Per-user lockout to prevent password brute-force on this destructive endpoint.
	lockKey := auth.Key("delete_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return ErrTooManyAttempts
	}

	if password == "" {
		return ErrPasswordRequired
	}

	// Verify the supplied password matches the stored hash.
	failKey := auth.Key("delete_fail", user.ID)
	matched, admitted := s.limiter.Admission().CheckPassword(user.PasswordHash, password)
	if !admitted {
		return ErrAuthBusy
	}
	if !matched {
		if !s.limiter.Allow(failKey, deleteAccountFailureThreshold, deleteAccountFailureWindow) {
			s.limiter.Lockout(ctx, lockKey, deleteAccountLockoutDuration)
		}
		return ErrIncorrectPassword
	}
	s.limiter.Reset(ctx, failKey)

	if err := s.erasure.Erase(ctx, user.ID); err != nil {
		switch {
		case errors.Is(err, db.ErrLastAdmin):
			return ErrLastAdmin
		case errors.Is(err, ErrErasureFilesPending):
			// The account is gone; the journal finishes the files.
			slog.Warn("DeleteAccount: files pending", "user_id", user.ID, "err", err)
		default:
			slog.Error("DeleteAccount failed", "err", err, "user_id", user.ID)
			return ErrDeleteAccountFailed
		}
	}

	slog.Info("account deleted", "user_id", user.ID, "ip", ip)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "account_deleted", "user", user.ID,
		"account self-deleted from "+ip)

	// The erasure left the subject in the state an admin ban does for every
	// other client (gone from the roster, sessions revoked) — broadcast the
	// same event so connected clients drop the user immediately, and the
	// subject's own socket is disconnected.
	if s.broadcaster != nil {
		s.broadcaster.BroadcastMemberBan(user.ID)
	}
	return nil
}

// EnableTOTP confirms the password and stages a pending secret; the returned
// enrolment carries the otpauth URI for the authenticator app and the
// emergency recovery codes (B4-3), whose hashes are stored now so they are
// in place the moment ConfirmTOTP turns the second factor on. Staging again
// replaces both the pending secret and the codes.
func (s *AuthService) EnableTOTP(ctx context.Context, p Principal, password string) (*TOTPEnrollment, error) {
	user := p.User

	// BUG-111: Per-user lockout for password confirmation.
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

// ConfirmTOTP verifies code against the pending secret, persists it and
// revokes the caller's other sessions.
func (s *AuthService) ConfirmTOTP(ctx context.Context, p Principal, password, code string) (*TOTPChangeResult, error) {
	user := p.User

	// BUG-111: Per-user lockout for password confirmation.
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
		return nil, ErrTOTPEnableFailed
	}
	s.pending.Delete(ctx, user.ID)

	// Security tail of the 2FA change: once the secret update committed,
	// revoking the other sessions must not be aborted by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp enable")

	slog.Info("totp enabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_enabled", "user", user.ID,
		"two-factor authentication enrolled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS enabled; only revoking the other
		// sessions failed. A 5xx here would be a lie — the state change
		// already committed — so mirror the ChangePassword contract
		// (api/profile_handler.go) and report 200 with an explicit warning
		// instead of a silent, unqualified 204.
		res.Warning = "two-factor authentication enabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}

// DisableTOTP confirms the password, refuses while the server requires 2FA,
// clears the secret and revokes the caller's other sessions.
func (s *AuthService) DisableTOTP(ctx context.Context, p Principal, password string) (*TOTPChangeResult, error) {
	user := p.User

	// BUG-111: Per-user lockout for password confirmation.
	lockKey := auth.Key("pw_confirm_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrTooManyAttempts
	}

	if err := s.confirmPassword(ctx, user, password, lockKey); err != nil {
		return nil, err
	}

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		return nil, ErrAuthPolicyUnavailable
	}
	if require2FA {
		return nil, ErrTOTPRequiredByServer
	}

	s.pending.Delete(ctx, user.ID)
	if err := s.st.UpdateUserTOTPSecret(ctx, user.ID, nil); err != nil {
		return nil, ErrTOTPDisableFailed
	}
	// The recovery codes stand in for a TOTP code and mean nothing without
	// one; a leftover set would be inert but is a credential all the same.
	if err := s.st.DeleteRecoveryCodes(ctx, user.ID); err != nil {
		slog.Warn("recovery codes: deleting after 2FA disable failed", "user_id", user.ID, "error", err)
	}

	// Security tail of the 2FA change: once the secret update committed,
	// revoking the other sessions must not be aborted by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp disable")

	slog.Info("totp disabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_disabled", "user", user.ID,
		"two-factor authentication disabled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS disabled; only revoking the other
		// sessions failed. A 5xx here would be a lie — the state change
		// already committed — so mirror the ChangePassword contract
		// (api/profile_handler.go) and report 200 with an explicit warning
		// instead of a silent, unqualified 204.
		res.Warning = "two-factor authentication disabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}

// confirmPassword is the password-confirmation step the TOTP routes share: a
// missing or wrong password counts against the per-user pw_confirm budget
// and trips the lockout on the threshold; a correct one resets the counter.
func (s *AuthService) confirmPassword(ctx context.Context, user *db.User, password, lockKey string) error {
	failKey := auth.Key("pw_confirm_fail", user.ID)
	if err := s.requirePasswordConfirmation(user, password); err != nil {
		if errors.Is(err, ErrAuthBusy) {
			// Refused before any compare ran (B4-4): not an attempt, so not
			// a failure to count.
			return err
		}
		if !s.limiter.Allow(failKey, PwConfirmFailureThreshold, PwConfirmFailureWindow) {
			s.limiter.Lockout(ctx, lockKey, PwConfirmLockoutDuration)
		}
		return err
	}
	s.limiter.Reset(ctx, failKey)
	return nil
}

// keepSessionID is the session a 2FA state change keeps alive. BUG-108: an
// API-token principal has a nil session; keep=0 matches no row, so every
// login session is revoked — same semantics as change-password.
func keepSessionID(p Principal) int64 {
	if p.Session != nil {
		return p.Session.ID
	}
	return 0
}

// revokeOtherSessionsAfterAuthChange revokes every session for userID except
// keepSessionID as the security tail of a committed 2FA state change. It
// mirrors UserService.ChangePassword (service/user.go:262-274): a failure is
// logged and retried once (bounded compensating retry for transient write
// contention); if the retry also fails, revoked reports what did succeed and
// failed is true so the caller can report a partial success instead of
// silently claiming the other sessions were revoked when they were not.
func (s *AuthService) revokeOtherSessionsAfterAuthChange(ctx context.Context, userID, keepSessionID int64, action string) (revoked int64, failed bool) {
	revoked, err := s.st.DeleteOtherSessions(ctx, userID, keepSessionID)
	if err != nil {
		slog.Error("DeleteOtherSessions after "+action, "err", err, "user_id", userID)
		revokedRetry, retryErr := s.st.DeleteOtherSessions(ctx, userID, keepSessionID)
		if retryErr != nil {
			slog.Error("DeleteOtherSessions retry after "+action, "err", retryErr, "user_id", userID)
			return revoked, true
		}
		revoked += revokedRetry
	}
	if revoked > 0 {
		slog.Info("revoked other sessions after "+action, "user_id", userID, "revoked", revoked)
	}
	return revoked, false
}

// ─── Helpers moved from api/auth_handler.go ──────────────────────────────────

// newSessionToken generates a bearer token and hands its hash to persist,
// which stores the session row — CreateSession, or CreateUserWithInvite's
// transaction for a registration. The token is returned only once persist
// succeeded.
func newSessionToken(persist func(tokenHash string) error) (string, error) {
	token, err := auth.GenerateToken()
	if err != nil {
		return "", err
	}
	if err := persist(auth.HashToken(token)); err != nil {
		return "", err
	}
	return token, nil
}

func issueSession(ctx context.Context, st Store, userID int64, device, ip string) (string, error) {
	return newSessionToken(func(tokenHash string) error {
		_, err := st.CreateSession(ctx, userID, tokenHash, device, ip)
		return err
	})
}

func (s *AuthService) require2FAEnabled(ctx context.Context) (bool, error) {
	return getBooleanSetting(ctx, s.st, "require_2fa", false)
}

func getBooleanSetting(ctx context.Context, st Store, key string, defaultValue bool) (bool, error) {
	value, err := st.GetSetting(ctx, key)
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return defaultValue, nil
		}
		return false, err
	}
	return parseBooleanSettingValue(value)
}

func parseBooleanSettingValue(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true":
		return true, nil
	case "0", "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid boolean setting value %q", value)
	}
}

// requirePasswordConfirmation checks the confirming password inside one
// admission slot (B4-4); ErrAuthBusy means the budget refused and no compare
// ran.
func (s *AuthService) requirePasswordConfirmation(user *db.User, password string) error {
	if password == "" {
		return ErrPasswordRequired
	}
	matched, admitted := s.limiter.Admission().CheckPassword(user.PasswordHash, password)
	if !admitted {
		return ErrAuthBusy
	}
	if !matched {
		return ErrPasswordConfirmationFailed
	}
	return nil
}
