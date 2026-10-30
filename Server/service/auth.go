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
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// AuthBroadcaster tells connected WebSocket clients an account is gone
// (satisfied by *ws.Hub). A nil broadcaster sends nothing; clients converge on
// reconnect.
type AuthBroadcaster interface {
	BroadcastMemberBan(userID int64)
}

// SessionDisconnector is the hub's half of dropping a live socket once its
// session is gone (satisfied by *ws.Hub). Exported so the admin package can pin
// *ws.Hub to it, since service cannot import ws; a broadcaster that does not
// implement it skips the disconnect.
type SessionDisconnector interface {
	DisconnectRevokedUser(userID int64)
	DisconnectIfSessionRevoked(userID int64)
}

// Principal is the authenticated caller api.AuthMiddleware resolved for a
// request. Session is nil for an API-token principal.
type Principal struct {
	User    *db.User
	Session *db.Session
}

// RegisterInput is a validated registration: the transport already trimmed and
// format-checked Username, checked Password strength and trimmed InviteCode.
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
	// PendingApproval marks an approval-mode registration: no session is issued.
	PendingApproval bool
	// RecoveryCodesRemaining is set when a recovery code, not a TOTP code, completed
	// the second step (nil otherwise).
	RecoveryCodesRemaining *int
}

// TOTPEnrollment is what EnableTOTP hands the caller: the otpauth URI and the
// recovery codes, shown exactly once. The server keeps only bcrypt hashes.
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

const (
	loginFailureThreshold = 9

	loginFailureWindow = 15 * time.Minute

	loginLockoutDuration = 15 * time.Minute

	// loginUser* is the per-username budget, independent of source IP.
	loginUserFailureThreshold = 9

	loginUserFailureWindow = 15 * time.Minute

	loginUserLockoutDuration = 15 * time.Minute

	deleteAccountFailureThreshold = 3

	deleteAccountFailureWindow = 15 * time.Minute

	deleteAccountLockoutDuration = 15 * time.Minute

	totpFailureRateLimit = 10

	totpFailureWindow = 15 * time.Minute

	// partialAuthMaxFailures is the failed TOTP attempts one challenge survives.
	partialAuthMaxFailures = 5

	partialAuthStoreTTL = 10 * time.Minute

	pendingTOTPStoreTTL = 10 * time.Minute
)

// The password-confirmation lockout is shared with the change-password route
// (api/profile_handler.go): one key space and one budget for every route that
// asks for the current password.
const (
	// PwConfirmFailureThreshold is the wrong attempts before per-user lockout.
	PwConfirmFailureThreshold = 3

	// PwConfirmFailureWindow is the sliding window for those failures.
	PwConfirmFailureWindow = 15 * time.Minute

	// PwConfirmLockoutDuration is how long the lockout lasts.
	PwConfirmLockoutDuration = 15 * time.Minute
)

// Category sentinels the transport maps to a status and code; the rest are
// shared in message.go.
var (
	// ErrUnauthorized is a credential or challenge that does not authenticate (401).
	// Deliberately generic: the enumeration guard needs every failed login to look
	// the same.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrInvalidInput is a password-confirmation refusal (400 INVALID_INPUT).
	ErrInvalidInput = errors.New("invalid input")
)

// authError is one refusal the auth slice can return. Error() is the exact public
// message (characterization tests pin it byte for byte); Is matches both the
// named value and its category sentinel.
type authError struct {
	kind error
	msg  string
}

func (e *authError) Error() string        { return e.msg }
func (e *authError) Is(target error) bool { return target == e.kind }

// Every refusal below is returned bare, never wrapped around the cause: the
// transport echoes Error() to the client, and the cause is logged here instead.
var (
	// Registration.
	ErrRegistrationPolicyUnavailable = &authError{ErrInternal, "failed to load registration policy"}
	ErrRegistrationClosed            = &authError{ErrForbidden, "registration is currently closed"}
	// ErrAccountPending is an approval-mode application trying to sign in
	// before an admin approved it.
	ErrAccountPending = &authError{ErrForbidden, "account is awaiting approval"}
	// ErrRegistrationRateLimited and ErrRegistrationQueueFull are the per-mode abuse
	// limits (per-address budget, approval-queue cap); both are rate-limit category
	// so the client backs off.
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
	// ErrAuthBusy is the admission refusal: the process-wide budget for expensive
	// authentication work is exhausted, so no bcrypt ran and no lockout attempt was
	// consumed. Same category as the lockouts (429) but its own code, AUTH_BUSY, tells
	// load from abuse.
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
	// ErrTOTPUnavailable is a store fault while loading the challenged user:
	// an outage, not a bad challenge, so no attempt is charged.
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
	// ErrTOTPEnrollmentStage is a persister fault while staging an enrolment:
	// the pending secret could not be made durable, so none is staged.
	ErrTOTPEnrollmentStage = &authError{ErrInternal, "failed to stage two-factor enrolment"}

	// Recovery codes.
	ErrRecoveryCodesRequireTOTP = &authError{ErrConflict, "enable two-factor authentication before requesting recovery codes"}
	ErrRecoveryCodesFailed      = &authError{ErrInternal, "failed to issue recovery codes"}
)

// authStore is what AuthService reads and writes. *db.DB satisfies it.
type authStore interface {
	ErasureStore
	auth.SecondFactorPersister
	db.Auditor
	sessionCreator
	settingGetter
	ReplaceRecoveryCodes(ctx context.Context, userID int64, codeHashes []string) error
	ListUnusedRecoveryCodes(ctx context.Context, userID int64) (ids []int64, hashes []string, err error)
	MarkRecoveryCodeUsed(ctx context.Context, id int64) (consumed bool, err error)
	CountUnusedRecoveryCodes(ctx context.Context, userID int64) (int, error)
	DeleteRecoveryCodes(ctx context.Context, userID int64) error
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error)
	CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error)
	// Recovery kit.
	UpsertRecoveryKit(ctx context.Context, userID int64, verifier string) error
	GetRecoveryKit(ctx context.Context, userID int64) (*db.RecoveryKit, error)
	RedeemRecoveryKit(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Owner-issued recovery credential.
	UpsertRecoveryAssist(ctx context.Context, userID int64, verifier string, issuedBy int64, verification string, expiresAt time.Time) error
	GetRecoveryAssist(ctx context.Context, userID int64) (*db.RecoveryAssist, error)
	RedeemRecoveryAssist(ctx context.Context, userID int64, verifier, newPasswordHash, auditAction, auditDetail string) (int64, error)
	// Approval-mode registration.
	CreatePendingUser(ctx context.Context, username, passwordHash string, roleID, maxPending int) (int64, error)
	CountPendingUsers(ctx context.Context) (int64, error)

	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	UpdateUserTOTPSecret(ctx context.Context, id int64, secret *string) error
	DeleteSession(ctx context.Context, tokenHash string) error
	DeleteOtherSessions(ctx context.Context, userID, keepSessionID int64) (int64, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
}

// AuthService owns the auth slice's orchestration: lockout and enumeration
// guards, password and second-factor checks, session issue and revoke, audit
// writes and the member_ban broadcast on self-erasure.
type AuthService struct {
	// issueMu serializes the two-budget reservation of IssueRecoveryAssist.
	issueMu     syncutil.Mutex
	st          authStore
	limiter     *auth.RateLimiter
	partial     *auth.PartialAuthStore
	pending     *auth.PendingTOTPStore
	usedCodes   *auth.UsedTOTPCodeStore
	totpKey     []byte
	broadcaster AuthBroadcaster
	// erasure runs DeleteAccount's erasure; UseErasure swaps in the shared runner so
	// file storage is installed once.
	erasure *ErasureService
	// admissionWait bounds acquireAdmission's queue wait.
	admissionWait time.Duration
	// welcome greets a new member once their account exists; nil greets nobody.
	welcome *WelcomeService
}

// NewAuthService wires the auth slice. limiter holds the lockouts; totpKey is the
// AES-256 key encrypting TOTP secrets at rest; broadcaster may be nil. The
// partial-login, pending-enrolment and used-code stores persist through st, so a
// restart keeps in-flight challenges and the replay window and a store fault
// fails closed.
func NewAuthService(st authStore, limiter *auth.RateLimiter, totpKey []byte, broadcaster AuthBroadcaster) *AuthService {
	return &AuthService{
		st:            st,
		limiter:       limiter,
		partial:       auth.NewPartialAuthStore(partialAuthStoreTTL).WithPersister(st),
		pending:       auth.NewPendingTOTPStore(pendingTOTPStoreTTL).WithPersister(st, totpKey),
		usedCodes:     auth.NewUsedTOTPCodeStore().WithPersister(st),
		totpKey:       totpKey,
		broadcaster:   broadcaster,
		erasure:       NewErasureService(st),
		admissionWait: auth.AdmissionWait,
	}
}

// UseErasure makes DeleteAccount run through the bundle's shared runner (which
// carries upload storage). A nil e is a no-op; wireAuth decides whether that is
// worth logging.
func (s *AuthService) UseErasure(e *ErasureService) {
	if e != nil {
		s.erasure = e
	}
}

// UseWelcome makes Register greet each new member through w; nil greets nobody.
func (s *AuthService) UseWelcome(w *WelcomeService) {
	s.welcome = w
}

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

// admitRegistration runs the mode's gates before any bcrypt work.
func (s *AuthService) admitRegistration(ctx context.Context, in RegisterInput) (RegistrationMode, error) {
	mode, err := registrationModeSetting(ctx, s.st)
	if err != nil {
		slog.Error("register: reading registration_mode failed", "err", err)
		return "", ErrRegistrationPolicyUnavailable
	}
	switch mode {
	case RegistrationClosed:
		return "", ErrRegistrationClosed
	case RegistrationInvite:
		if strings.TrimSpace(in.InviteCode) == "" {
			// Same answer as a bad code, so the response reveals nothing new.
			slog.WarnContext(ctx, "registration refused", "cause", "invite required",
				"ip", in.IP, "username", in.Username)
			return "", ErrRegistrationRejected
		}
		return mode, nil
	case RegistrationApproval, RegistrationOpen:
	}
	if !s.limiter.Allow("register_ip:"+clientip.RateKey(in.IP), inviteFreeRegistrationsPerIPPerDay, 24*time.Hour) {
		return "", ErrRegistrationRateLimited
	}
	if mode == RegistrationApproval {
		pending, err := s.st.CountPendingUsers(ctx)
		if err != nil {
			slog.Error("register: counting pending applications failed", "err", err)
			return "", ErrRegistrationPolicyUnavailable
		}
		if pending >= maxPendingRegistrations {
			return "", ErrRegistrationQueueFull
		}
	}
	return mode, nil
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
	mode, err := s.admitRegistration(ctx, in)
	if err != nil {
		return nil, err
	}

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

// Login runs the lockout gates and constant-time password check, then issues a
// session or, for an enrolled account, starts a two-factor challenge.
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
	if err := refuseSystemAccount(user, in.IP); err != nil {
		return nil, err
	}
	// An approval-mode application is not an account until an admin approves it.
	if user.PendingApproval() {
		slog.Info("pending application login attempt", "user_id", user.ID, "ip", in.IP)
		return nil, ErrAccountPending
	}

	require2FA, err := s.require2FAEnabled(ctx)
	if err != nil {
		slog.Error("login: reading require_2fa failed", "err", err, "user_id", user.ID)
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

	token, err := issueSession(ctx, s.st, user.ID, in.Device, in.IP)
	if err != nil {
		slog.Error("login: session issue failed", "err", err, "user_id", user.ID)
		return nil, sessionIssueError(err)
	}

	// No "online" status here: the WebSocket connection (serve.go) sets it on
	// connect, otherwise a client that never connects stays "online" forever.
	slog.Info("user logged in", "username", user.Username, "user_id", user.ID, "ip", in.IP)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, user.ID, "user_login", "user", user.ID,
		"logged in from "+in.IP)
	return &AuthResult{Token: token, User: user}, nil
}

// authenticate runs the lockout gates, constant-time compare and failure
// accounting for one login attempt.
func (s *AuthService) authenticate(ctx context.Context, in LoginInput) (*db.User, error) {
	lockKey := "login_lock:" + clientip.RateKey(in.IP)
	if s.limiter.IsLockedOut(lockKey) {
		return nil, ErrLockedOut
	}

	// Per-username lockout stops distributed brute force. The key is canonicalised
	// like GetUserByUsername (COLLATE NOCASE folds ASCII A-Z only), so case variants
	// of one account share a bucket; db.LowerASCII, not strings.ToLower, because
	// accounts differing only in non-ASCII case are separate rows.
	unameKey := db.LowerASCII(in.Username)
	userLockKey := "login_user_lock:" + unameKey
	// An address that signed in to this account recently is exempt from the
	// per-username lockout and budget (see loginVouchWindow).
	successKey := loginVouchKey(unameKey, in.IP)
	successVouched := s.loginVouched(successKey)
	if s.limiter.IsLockedOut(userLockKey) && !successVouched {
		return nil, ErrLockedOut
	}

	// Take an admission slot before reserving the attempt, so an over-budget request
	// is refused without charging the budgets or running bcrypt. A burst queues, so
	// the account is read once admitted: a change made during the wait is what the
	// compare sees.
	release, err := s.acquireAdmission(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	// Constant-time: bcrypt runs even when the user does not exist, preventing
	// username enumeration by timing.
	user, err := s.st.GetUserByUsername(ctx, in.Username)

	// A DB error must not touch the rate limiter, or a transient outage would lock
	// out legitimate users.
	if err != nil && user == nil {
		// GetUserByUsername returns (nil, nil) for not-found, so an error is a real failure.
		slog.Error("login: GetUserByUsername failed", "err", err, "ip", in.IP)
		return nil, ErrLoginUnavailable
	}

	failKey := "login_fail:" + clientip.RateKey(in.IP)
	userFailKey := "login_user_fail:" + unameKey
	// Reserve this attempt atomically BEFORE the bcrypt compare: the IsLockedOut
	// gates above are check-then-act, so N concurrent requests would all pass them
	// and the per-username cap (the only cross-IP defence) would bind only
	// sequential attackers. Allow records under the limiter's lock. The budget is
	// threshold+1 so sequential behaviour is unchanged: the 10th failure trips the
	// lockout via Check below and a correct 10th password still succeeds. It sits
	// after the DB-error return so an outage consumes no attempts. The per-username
	// budget is deliberately NOT auth.ScaledLimit: scaling the only cross-IP defence
	// by the shared-NAT multiplier would hand a distributed attacker more guesses
	// (api/constants_test.go pins this call site).
	if !s.limiter.Allow(failKey, auth.ScaledLimit(loginFailureThreshold)+1, loginFailureWindow) {
		return nil, ErrLockedOut
	}
	// A vouched address skips the per-username reservation; the per-IP budget still
	// bounds it.
	if !successVouched && !s.limiter.Allow(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
		return nil, ErrLockedOut
	}
	// Always run the check, with an empty hash for an unknown user:
	// auth.CheckPassword does a dummy bcrypt comparison then, so response time stays
	// constant. A `user == nil || CheckPassword(...)` short-circuit would reintroduce
	// the timing side-channel.
	storedHash := ""
	if user != nil {
		storedHash = user.PasswordHash
	}
	matched := auth.CheckPassword(storedHash, in.Password)
	release()
	if !matched {
		// The attempt was already recorded up-front; only decide the lockouts here.
		// Check is read-only, so the reservation is not double-counted.
		if !s.limiter.Check(failKey, auth.ScaledLimit(loginFailureThreshold)+1, loginFailureWindow) {
			s.limiter.Lockout(ctx, lockKey, loginLockoutDuration)
		}
		if !s.limiter.Check(userFailKey, loginUserFailureThreshold+1, loginUserFailureWindow) {
			s.limiter.Lockout(ctx, userLockKey, loginUserLockoutDuration)
		}
		slog.Info("login failed", "ip", in.IP, "username_len", len(in.Username))
		return nil, ErrInvalidCredentials
	}

	// Success resets the counters and vouches for this address.
	s.limiter.Reset(ctx, failKey)
	s.limiter.Reset(ctx, userFailKey)
	s.recordLoginVouch(ctx, successKey)
	return user, nil
}

// VerifyTOTP completes a challenge Login started and issues the session, bound
// to the login request's device and IP rather than this one's.
func (s *AuthService) VerifyTOTP(ctx context.Context, partialToken, code string) (*AuthResult, error) {
	code = strings.TrimSpace(code)
	challenge, ok := s.partial.Lookup(ctx, partialToken)
	if !ok {
		return nil, ErrTOTPChallengeInvalid
	}

	// Refuse an exhausted per-user budget before touching the store: the read-only
	// Check charges nothing, so rotating source IPs cannot drive user reads and
	// secret decryptions past the cap.
	totpRateLimitKey := auth.Key("totp_fail", challenge.UserID)
	if !s.limiter.Check(totpRateLimitKey, totpFailureRateLimit, totpFailureWindow) {
		return nil, ErrTooManyAttempts
	}

	user, secret, err := s.challengeSecret(ctx, challenge.UserID)
	if err != nil {
		return nil, err
	}

	// Record the attempt atomically up-front rather than a read-only Check now and
	// Allow on failure: that would be a TOCTOU where many concurrent requests
	// reusing one valid partial token all pass before any failure is recorded,
	// defeating the per-user cap (the only cross-IP defence). Success resets the
	// counter below, so legitimate retries are not penalised. Deliberately NOT
	// auth.ScaledLimit: the multiplier is for shared-NAT per-IP limits, and scaling a
	// per-user threshold would hand a distributed attacker more guesses (as in
	// authenticate). The reservation sits after the store read so an outage consumes
	// no attempts, and before the code compare. A recovery code is matched against
	// up to ten bcrypt hashes, so it takes an admission slot first (a refusal charges
	// nothing, and it queues like login); a TOTP code is an HMAC and needs none.
	canonical, isRecovery := auth.NormalizeRecoveryCode(code)
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

	// A recovery code has a different shape, so the input routes itself. It is spent
	// by the conditional update that consumed it, not the replay window, so Unmark
	// below applies to TOTP codes only.
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
		// The attempt was already recorded up-front; only the per-challenge counter
		// advances here.
		s.partial.RegisterFailure(ctx, partialToken, partialAuthMaxFailures)
		return nil, ErrTOTPCodeInvalid
	}

	s.limiter.Reset(ctx, totpRateLimitKey)

	claimed, ok := s.partial.Consume(ctx, partialToken)
	if !ok {
		// The claim lost: a concurrent verify consumed the challenge (or it expired)
		// after this request marked its code. Release the code so a Restore by a winner
		// whose issueSession failed is not stuck behind this mark. A spent recovery code
		// stays spent: un-spending it would hand a racing verifier a second use.
		if recoveryRemaining == nil {
			s.usedCodes.Unmark(ctx, user.ID, code)
		}
		return nil, ErrTOTPChallengeInvalid
	}

	token, err := issueSession(ctx, s.st, user.ID, challenge.Device, challenge.IP)
	if err != nil {
		// The second factor was verified; a store fault must not discard it. The claim
		// is atomic and first, so two verifies never both reach issueSession. Put the
		// challenge back under the same token and release the code so the retry
		// completes the login without another password step; code first, then token, so
		// a retry never finds a live token with a dead code.
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

// consumeRecoveryCode spends the recovery code matching canonical, if the user
// holds one. matched is false for no match or a code another verification spent
// first; remaining is -1 when the count could not be read after a successful
// spend (the code is gone either way).
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

// RegenerateRecoveryCodes confirms the password and replaces the recovery codes;
// the old set is invalid the moment the new one is stored (one transaction).
// Requires 2FA: the codes stand in for a TOTP code.
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

// challengeSecret resolves the user behind a partial-auth challenge and returns
// their decrypted TOTP secret.
func (s *AuthService) challengeSecret(ctx context.Context, challengeUserID int64) (*db.User, string, error) {
	user, err := s.st.GetUserByID(ctx, challengeUserID)
	if err != nil {
		// GetUserByID answers (nil, nil) for an unknown user, so an error is a store
		// fault: report the outage and record no attempt.
		slog.Error("verify-totp: GetUserByID failed", "err", err, "user_id", challengeUserID)
		return nil, "", ErrTOTPUnavailable
	}
	if user == nil || user.TOTPSecret == nil {
		return nil, "", ErrTOTPChallengeInvalid
	}

	// A ban can land inside the partial-token window, so the second factor refuses
	// banned users as the login path does.
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

// Logout revokes p.Session and clears the custom status. p.Session must be
// non-nil: the transport answers an API-token principal with 401 first.
func (s *AuthService) Logout(ctx context.Context, p Principal) error {
	sess := p.Session
	if sess == nil {
		return errors.New("logout: principal has no session")
	}

	// The client clears its token optimistically, so the revocation must survive a
	// dropped connection.
	if err := s.st.DeleteSession(context.WithoutCancel(ctx), sess.TokenHash); err != nil {
		slog.Error("logout: session delete failed", "err", err, "user_id", sess.UserID)
		return ErrLogoutFailed
	}

	// Logout clears the custom status (a "right now" note that would go stale),
	// unlike the presence status, which is a preference and survives.
	if err := s.st.UpdateUserCustomStatus(context.WithoutCancel(ctx), sess.UserID, nil); err != nil {
		slog.Warn("failed to clear custom status on logout", "user_id", sess.UserID, "err", err)
	}

	slog.Info("user logged out", "user_id", sess.UserID)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, sess.UserID, "user_logout", "user", sess.UserID, "")
	return nil
}

// DeleteAccount confirms the password, erases the account (every data class
// hard-deleted in one transaction, files removed via a resumable journal) and
// broadcasts member_ban. Lockout mirrors login: 3 failures, 15-min lock. ip is
// only logged and audited; the username is never logged.
//
// A message sent over an already-authenticated socket cannot outlive the
// erasure: the writer connection serialises it before the transaction (which
// deletes it) or after (messages.user_id has no users row, so the foreign-key
// check fails). The member_ban broadcast then disconnects the socket.
func (s *AuthService) DeleteAccount(ctx context.Context, p Principal, password, ip string) error {
	user := p.User

	// Per-user lockout against password brute force on this destructive endpoint.
	lockKey := auth.Key("delete_lock", user.ID)
	if s.limiter.IsLockedOut(lockKey) {
		return ErrTooManyAttempts
	}

	if password == "" {
		return ErrPasswordRequired
	}

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
		case errors.Is(err, ErrErasureInProgress):
			// The erasure is committed to; the maintenance loop finishes it.
			slog.Info("DeleteAccount: erasure in progress", "user_id", user.ID)
		default:
			slog.Error("DeleteAccount failed", "err", err, "user_id", user.ID)
			return ErrDeleteAccountFailed
		}
	}

	slog.Info("account deleted", "user_id", user.ID, "ip", ip)
	// Unlinked from the start: no id, no IP, the deletion marker's token on both
	// sides (the subject is the actor too).
	token := s.erasure.SubjectToken(user.ID)
	db.WriteAuditEntry(context.WithoutCancel(ctx), s.st, db.AuditEntry{
		Action: "account_deleted", TargetType: "user", Detail: "account self-erased", SubjectToken: token, ActorToken: token,
	})

	// Broadcast the event an admin ban sends so connected clients drop the user
	// immediately. With the hub installed on the runner the erasure already did this.
	if s.broadcaster != nil && !s.erasure.BroadcastsMemberBan() {
		s.broadcaster.BroadcastMemberBan(user.ID)
	}
	return nil
}

// EnableTOTP confirms the password and stages a pending secret. The recovery
// code hashes are stored now so they exist the moment ConfirmTOTP turns the
// factor on; staging again replaces both.
func (s *AuthService) EnableTOTP(ctx context.Context, p Principal, password string) (*TOTPEnrollment, error) {
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
func (s *AuthService) ConfirmTOTP(ctx context.Context, p Principal, password, code string) (*TOTPChangeResult, error) {
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

// DisableTOTP confirms the password, refuses while the server requires 2FA,
// clears the secret and revokes the caller's other sessions.
func (s *AuthService) DisableTOTP(ctx context.Context, p Principal, password string) (*TOTPChangeResult, error) {
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
	if err := s.st.UpdateUserTOTPSecret(ctx, user.ID, nil); err != nil {
		slog.Error("totp disable: clearing the secret failed", "err", err, "user_id", user.ID)
		return nil, ErrTOTPDisableFailed
	}
	// Recovery codes mean nothing without 2FA; a leftover set is still a credential.
	if err := s.st.DeleteRecoveryCodes(ctx, user.ID); err != nil {
		slog.Warn("recovery codes: deleting after 2FA disable failed", "user_id", user.ID, "error", err)
	}

	// Once the secret update committed, revoking other sessions must not be aborted
	// by a dead request.
	tailCtx := context.WithoutCancel(ctx)
	revoked, revokeFailed := s.revokeOtherSessionsAfterAuthChange(tailCtx, user.ID, keepSessionID(p), "totp disable")

	slog.Info("totp disabled", "user_id", user.ID)
	db.WriteAudit(tailCtx, s.st, user.ID, "totp_disabled", "user", user.ID,
		"two-factor authentication disabled")

	res := &TOTPChangeResult{SessionsRevoked: revoked}
	if revokeFailed {
		// Partial success: 2FA IS disabled. A 5xx would be a lie, so mirror
		// ChangePassword (api/profile_handler.go): 200 with an explicit warning.
		res.Warning = "two-factor authentication disabled, but other sessions could not be revoked; revoke them from the sessions list"
	}
	return res, nil
}

// confirmPassword is the password step the TOTP routes share: a missing or wrong
// password counts against the pw_confirm budget and trips the lockout; a correct
// one resets it.
func (s *AuthService) confirmPassword(ctx context.Context, user *db.User, password, lockKey string) error {
	failKey := auth.Key("pw_confirm_fail", user.ID)
	if err := s.requirePasswordConfirmation(user, password); err != nil {
		if errors.Is(err, ErrAuthBusy) {
			// Refused before any compare ran: not an attempt.
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

// newSessionToken generates a bearer token and hands its hash to persist (the
// session row insert). The token is returned only once persist succeeded.
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

// sessionIssueError maps a failed session issue; sign-in is refused while an
// account deletion is being completed.
func sessionIssueError(err error) error {
	if errors.Is(err, db.ErrAccountErasing) {
		return ErrBanned
	}
	return ErrSessionIssue
}

// sessionCreator writes a new session row.
type sessionCreator interface {
	CreateSession(ctx context.Context, userID int64, tokenHash, device, ip string) (int64, error)
}

func issueSession(ctx context.Context, st sessionCreator, userID int64, device, ip string) (string, error) {
	return newSessionToken(func(tokenHash string) error {
		_, err := st.CreateSession(ctx, userID, tokenHash, device, ip)
		return err
	})
}

func (s *AuthService) require2FAEnabled(ctx context.Context) (bool, error) {
	return getBooleanSetting(ctx, s.st, "require_2fa", false)
}

// requirePasswordConfirmation checks the password inside one admission slot;
// ErrAuthBusy means no compare ran.
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
