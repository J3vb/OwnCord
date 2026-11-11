package service

import (
	"errors"
	"time"
)

const (
	loginFailureThreshold = 9

	loginFailureWindow = 15 * time.Minute

	loginLockoutDuration = 15 * time.Minute

	loginUserFailureThreshold = 9

	loginUserFailureWindow = 15 * time.Minute

	loginUserLockoutDuration = 15 * time.Minute

	deleteAccountFailureThreshold = 3

	deleteAccountFailureWindow = 15 * time.Minute

	deleteAccountLockoutDuration = 15 * time.Minute

	totpFailureRateLimit = 10

	totpFailureWindow = 15 * time.Minute

	partialAuthMaxFailures = 5

	partialAuthStoreTTL = 10 * time.Minute

	pendingTOTPStoreTTL = 10 * time.Minute
)

const (
	// PwConfirmFailureThreshold is the wrong attempts before per-user lockout.
	PwConfirmFailureThreshold = 3

	// PwConfirmFailureWindow is the sliding window for those failures.
	PwConfirmFailureWindow = 15 * time.Minute

	// PwConfirmLockoutDuration is how long the lockout lasts.
	PwConfirmLockoutDuration = 15 * time.Minute
)

var (
	// ErrUnauthorized is a credential or challenge that does not authenticate (401).
	// Deliberately generic so every failed login looks the same (enumeration guard).
	ErrUnauthorized = errors.New("unauthorized")
	// ErrInvalidInput is a password-confirmation refusal (400 INVALID_INPUT).
	ErrInvalidInput = errors.New("invalid input")
)

// authError is one refusal of the auth slice. Error() is the exact public message
// (tests pin it byte for byte); Is matches the value and its category sentinel.
type authError struct {
	kind error
	msg  string
}

func (e *authError) Error() string        { return e.msg }
func (e *authError) Is(target error) bool { return target == e.kind }

// Every refusal is returned bare, never wrapped: the transport echoes Error() to the
// client and the cause is logged instead.
var (
	ErrRegistrationPolicyUnavailable = &authError{ErrInternal, "failed to load registration policy"}
	ErrRegistrationClosed            = &authError{ErrForbidden, "registration is currently closed"}
	// ErrAccountPending is an approval-mode application trying to sign in before an admin approved it.
	ErrAccountPending = &authError{ErrForbidden, "account is awaiting approval"}
	// ErrRegistrationRateLimited and ErrRegistrationQueueFull are the per-mode abuse limits;
	// rate-limit category so the client backs off.
	ErrRegistrationRateLimited = &authError{ErrRateLimited, "too many registrations from this address, try again later"}
	ErrRegistrationQueueFull   = &authError{ErrRateLimited, "registration queue is full, try again later"}
	ErrRegistrationRequires2FA = &authError{ErrForbidden, "registration is unavailable while two-factor authentication is required"}
	ErrPasswordHash            = &authError{ErrInternal, "failed to process registration"}
	// ErrRegistrationRejected is the generic register refusal shared by an unknown, used-up or
	// expired invite and a taken username so the response reveals neither (400 INVALID_CREDENTIALS).
	ErrRegistrationRejected = &authError{ErrBadRequest, "invalid invite or credentials"}
	ErrRegistrationFailed   = &authError{ErrInternal, "registration failed — please try again"}
	ErrSessionIssue         = &authError{ErrInternal, "failed to create session"}
	ErrRegisteredUserFetch  = &authError{ErrInternal, "registration succeeded but user fetch failed"}

	ErrLockedOut             = &authError{ErrRateLimited, "account temporarily locked due to too many failed attempts"}
	ErrLoginUnavailable      = &authError{ErrInternal, "login temporarily unavailable"}
	ErrInvalidCredentials    = &authError{ErrUnauthorized, "invalid credentials"}
	ErrBanned                = &authError{ErrForbidden, "your account has been suspended"}
	ErrAuthPolicyUnavailable = &authError{ErrInternal, "failed to load authentication policy"}
	ErrTOTPChallengeStart    = &authError{ErrInternal, "failed to start two-factor challenge"}
	ErrRequire2FA            = &authError{ErrForbidden, "two-factor authentication must be enabled on this account before login"}

	ErrLogoutFailed = &authError{ErrInternal, "failed to logout"}

	// ErrLoginSessionRequired refuses an account-security change made with an API token
	// (403 LOGIN_SESSION_REQUIRED).
	ErrLoginSessionRequired = &authError{ErrForbidden, "this action requires a login session"}

	ErrTooManyAttempts = &authError{ErrRateLimited, "too many failed attempts, try again later"}
	// ErrAuthBusy is the admission refusal: the process-wide budget for expensive auth work
	// is exhausted, so no bcrypt ran and no attempt was consumed. 429 with code AUTH_BUSY.
	ErrAuthBusy                   = &authError{ErrRateLimited, "too many authentication attempts in progress, try again later"}
	ErrPasswordRequired           = &authError{ErrInvalidInput, "password is required"}
	ErrIncorrectPassword          = &authError{ErrInvalidInput, "incorrect password"}
	ErrPasswordConfirmationFailed = &authError{ErrInvalidInput, "password confirmation failed"}

	ErrLastAdmin           = &authError{ErrForbidden, "cannot delete the last admin account"}
	ErrDeleteAccountFailed = &authError{ErrInternal, "failed to delete account"}

	ErrTOTPChallengeInvalid = &authError{ErrUnauthorized, "invalid or expired two-factor challenge"}
	ErrTOTPSecretUnreadable = &authError{ErrInternal, "failed to verify two-factor code"}
	// ErrTOTPUnavailable is a store fault loading the challenged user: an outage, so no attempt is charged.
	ErrTOTPUnavailable = &authError{ErrInternal, "two-factor verification temporarily unavailable"}
	ErrTOTPCodeInvalid = &authError{ErrUnauthorized, "invalid two-factor code"}
	// ErrTOTPAlreadyEnabled is written as 409 TOTP_ALREADY_ENABLED.
	ErrTOTPAlreadyEnabled   = &authError{ErrConflict, "disable 2FA before re-enabling"}
	ErrTOTPSecretGenerate   = &authError{ErrInternal, "failed to generate two-factor secret"}
	ErrNoPendingTOTP        = &authError{ErrBadRequest, "no pending two-factor enrollment found"}
	ErrTOTPEnableFailed     = &authError{ErrInternal, "failed to enable two-factor authentication"}
	ErrTOTPRequiredByServer = &authError{ErrForbidden, "two-factor authentication is required for this server"}
	ErrTOTPDisableFailed    = &authError{ErrInternal, "failed to disable two-factor authentication"}
	// ErrTOTPEnrollmentStage is a persister fault staging an enrolment: no secret is staged.
	ErrTOTPEnrollmentStage = &authError{ErrInternal, "failed to stage two-factor enrolment"}

	ErrRecoveryCodesRequireTOTP = &authError{ErrConflict, "enable two-factor authentication before requesting recovery codes"}
	ErrRecoveryCodesFailed      = &authError{ErrInternal, "failed to issue recovery codes"}
)
