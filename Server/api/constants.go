package api

import "time"

// ─── Rate limits ────────────────────────────────────────────────────────────
//
// Each constant defines either a request cap or a sliding-window duration used
// by the per-endpoint rate limiters.

const (
	// registerRateLimitPerMinute is the maximum registration attempts per IP per minute.
	registerRateLimitPerMinute = 3

	// loginRateLimitPerMinute is the maximum login attempts per IP per minute.
	loginRateLimitPerMinute = 60

	// verifyTOTPRateLimitPerMinute is the maximum TOTP verification attempts per IP per minute.
	verifyTOTPRateLimitPerMinute = 10

	// sensitiveEndpointRateLimitPerMinute is the rate limit applied to destructive
	// or sensitive endpoints (account deletion, TOTP enable/confirm/disable).
	sensitiveEndpointRateLimitPerMinute = 5

	// searchRateLimitPerMinute is the maximum full-text search requests per IP per minute.
	searchRateLimitPerMinute = 30

	// livekitProxyRateLimitPerMinute is the maximum LiveKit proxy requests per IP per minute.
	livekitProxyRateLimitPerMinute = 30

	// loginFailureThreshold is the number of failed login attempts (within
	// loginFailureWindow) before the IP is locked out.
	loginFailureThreshold = 9

	// loginFailureWindow is the sliding window for counting login failures.
	loginFailureWindow = 15 * time.Minute

	// loginLockoutDuration is how long an IP is locked out after exceeding
	// loginFailureThreshold.
	loginLockoutDuration = 15 * time.Minute

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

	// profilePasswordRateLimitPerMinute is the maximum password change attempts
	// per IP per minute.
	profilePasswordRateLimitPerMinute = 5

	// loginUserFailureThreshold is the number of failed login attempts for a
	// specific username (regardless of source IP) before the account is locked.
	loginUserFailureThreshold = 9

	// loginUserFailureWindow is the sliding window for per-username login failures.
	loginUserFailureWindow = 15 * time.Minute

	// loginUserLockoutDuration is how long a username is locked after exceeding
	// loginUserFailureThreshold.
	loginUserLockoutDuration = 15 * time.Minute

	// pwConfirmFailureThreshold is the number of wrong-password attempts on
	// password-confirmation endpoints before per-user lockout kicks in.
	pwConfirmFailureThreshold = 3

	// pwConfirmFailureWindow is the sliding window for per-user password
	// confirmation failures.
	pwConfirmFailureWindow = 15 * time.Minute

	// pwConfirmLockoutDuration is how long password-confirmation endpoints are
	// locked after exceeding pwConfirmFailureThreshold.
	pwConfirmLockoutDuration = 15 * time.Minute

	// uploadRateLimitPerMinute is the maximum file uploads per user per minute.
	uploadRateLimitPerMinute = 10
)

// ─── Timeouts & TTLs ────────────────────────────────────────────────────────

const (
	// partialAuthStoreTTL is the lifetime of a partial-auth (2FA) challenge token.
	partialAuthStoreTTL = 10 * time.Minute

	// pendingTOTPStoreTTL is the lifetime of a pending TOTP enrollment secret.
	pendingTOTPStoreTTL = 10 * time.Minute

	// rateLimiterCleanupInterval is how often stale rate-limiter entries are reaped.
	rateLimiterCleanupInterval = 5 * time.Minute

	// rateLimiterCleanupMaxWindow is the maximum window considered when pruning
	// stale rate-limiter entries.
	rateLimiterCleanupMaxWindow = 15 * time.Minute

	// hstsMaxAgeSeconds is the max-age value for the Strict-Transport-Security header.
	hstsMaxAgeSeconds = 31536000

	// fileCacheMaxAgeSeconds is the max-age value for the Cache-Control header on served files.
	fileCacheMaxAgeSeconds = 31536000
)

// ─── Size limits ────────────────────────────────────────────────────────────

const (
	// defaultMaxBodySize is the default request body size limit (1 MiB).
	defaultMaxBodySize = 1 << 20

	// uploadMaxBodySize is the request body size limit for file uploads (100 MiB).
	uploadMaxBodySize = 100 << 20

	// multipartMemoryLimit is the in-memory limit for multipart form parsing;
	// data beyond this is spilled to disk.
	multipartMemoryLimit = 10 << 20

	// maxUploadFilenameLength is the maximum length of an upload filename
	// (filesystem-safe limit).
	maxUploadFilenameLength = 255
)
