package service

import (
	"errors"
	"time"
)

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

	// ErrLoginSessionRequired refuses an account-security change made with an
	// API token: those changes take a login session. The transport writes it as
	// 403 LOGIN_SESSION_REQUIRED.
	ErrLoginSessionRequired = &authError{ErrForbidden, "this action requires a login session"}

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
