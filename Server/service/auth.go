package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/db"
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
// request. Session is nil for an API-token principal. The account-security
// methods (two-factor changes, recovery codes and kit, account deletion)
// refuse a principal without a session with ErrLoginSessionRequired.
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

// authCoreStore is what the service itself reads and writes: registration,
// login, logout, account deletion and the require_2fa setting. *db.DB satisfies
// it. db.EntryAuditor is listed because DeleteAccount's subject-token audit
// write silently drops the token when the store lacks it.
type authCoreStore interface {
	db.Auditor
	db.EntryAuditor
	sessionCreator
	settingGetter
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetUserByUsername(ctx context.Context, username string) (*db.User, error)
	CreateUserWithInvite(ctx context.Context, username, passwordHash string, roleID int, inviteCode, sessionTokenHash, device, ip string) (int64, error)
	CreateUserWithSession(ctx context.Context, username, passwordHash string, roleID int, sessionTokenHash, device, ip string) (int64, error)
	// Approval-mode registration.
	CreatePendingUser(ctx context.Context, username, passwordHash string, roleID, maxPending int) (int64, error)
	CountPendingUsers(ctx context.Context) (int64, error)
	UpdateUserCustomStatus(ctx context.Context, userID int64, customStatus *string) error
	DeleteSession(ctx context.Context, tokenHash string) error
	GetInvite(ctx context.Context, code string) (*db.Invite, error)
}

// authStore is what NewAuthService takes: the core, each part, and the stores
// the constructor builds from it (the erasure runner and the second-factor
// persister). *db.DB satisfies it.
type authStore interface {
	authCoreStore
	twoFactorStore
	accountRecoveryStore
	ErasureStore
	// Second-factor state: the durable backend behind the auth service's
	// partial-auth, pending-enrolment and used-code stores. Stdlib types only,
	// because auth cannot import db.
	auth.SecondFactorPersister
}

// AuthService owns the auth slice's orchestration: lockout and enumeration
// guards, password and second-factor checks, session issue and revoke, audit
// writes and the member_ban broadcast on self-erasure. The second factor and
// account recovery live in embedded parts; a method that needs the core and a
// part stays here.
type AuthService struct {
	*authCommon
	*twoFactor
	*accountRecovery
	st authCoreStore
	// admissionWait bounds acquireAdmission's queue wait.
	admissionWait time.Duration
	// erasure runs DeleteAccount's erasure; UseErasure swaps in the shared runner so
	// file storage is installed once.
	erasure *ErasureService
	// welcome greets a new member once their account exists; nil greets nobody.
	welcome *WelcomeService
}

// NewAuthService wires the auth slice. limiter holds the lockouts; totpKey is the
// AES-256 key encrypting TOTP secrets at rest; broadcaster may be nil. The
// partial-login, pending-enrolment and used-code stores persist through st, so a
// restart keeps in-flight challenges and the replay window and a store fault
// fails closed.
func NewAuthService(st authStore, limiter *auth.RateLimiter, totpKey []byte, broadcaster AuthBroadcaster) *AuthService {
	common := &authCommon{limiter: limiter, broadcaster: broadcaster}
	return &AuthService{
		authCommon: common,
		twoFactor: &twoFactor{
			authCommon: common,
			st:         st,
			partial:    auth.NewPartialAuthStore(partialAuthStoreTTL).WithPersister(st),
			pending:    auth.NewPendingTOTPStore(pendingTOTPStoreTTL).WithPersister(st, totpKey),
			usedCodes:  auth.NewUsedTOTPCodeStore().WithPersister(st),
			totpKey:    totpKey,
		},
		accountRecovery: &accountRecovery{authCommon: common, st: st},
		st:              st,
		admissionWait:   auth.AdmissionWait,
		erasure:         NewErasureService(st),
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
	if p.Session == nil {
		return ErrLoginSessionRequired
	}
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
