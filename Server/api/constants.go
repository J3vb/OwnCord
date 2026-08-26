package api

import (
	"math"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// ─── Rate limits ────────────────────────────────────────────────────────────
//
// Each constant defines either a request cap or a sliding-window duration used
// by the per-endpoint rate limiters.

// authRateScaleBits holds the security.auth_rate_limit_multiplier as float
// bits. It scales the per-IP auth request caps and failure thresholds for
// deployments where many users share one IP (office/school NAT) — the
// compiled-in constants below assume roughly one person per address. Atomic
// because tests construct multiple routers concurrently. Set via
// setAuthRateScale in NewRouter; reads happen at mount time and on the login
// failure-count path.
var authRateScaleBits atomic.Uint64

func init() { authRateScaleBits.Store(math.Float64bits(1.0)) }

// setAuthRateScale clamps and installs the auth rate multiplier. Zero or
// negative (unset config) means 1.0.
func setAuthRateScale(m float64) {
	if m <= 0 {
		m = 1.0
	}
	m = math.Min(math.Max(m, 0.1), 100)
	authRateScaleBits.Store(math.Float64bits(m))
}

// scaledAuthLimit applies the auth rate multiplier to a compiled-in limit,
// never returning less than 1.
func scaledAuthLimit(n int) int {
	scaled := int(math.Round(float64(n) * math.Float64frombits(authRateScaleBits.Load())))
	if scaled < 1 {
		return 1
	}
	return scaled
}

const (
	// registerRateLimitPerMinute is the maximum registration attempts per IP per minute.
	registerRateLimitPerMinute = 3

	// loginRateLimitPerMinute is the maximum login attempts per IP per minute.
	loginRateLimitPerMinute = 5

	// verifyTOTPRateLimitPerMinute is the maximum TOTP verification attempts per IP per minute.
	verifyTOTPRateLimitPerMinute = 10

	// sensitiveEndpointRateLimitPerMinute is the rate limit applied to destructive
	// or sensitive endpoints (account deletion, TOTP enable/confirm/disable).
	sensitiveEndpointRateLimitPerMinute = 5

	// searchRateLimitPerMinute is the maximum full-text search requests per IP per minute.
	searchRateLimitPerMinute = 30

	// livekitProxyRateLimitPerMinute is the maximum LiveKit proxy requests per IP per minute.
	livekitProxyRateLimitPerMinute = 30

	// clientUpdateRateLimitPerMinute is the maximum client-update checks per IP per minute.
	clientUpdateRateLimitPerMinute = 30

	// gifRateLimitPerMinute is the maximum GIF proxy requests per IP per minute.
	// The picker debounces at 300ms, so a user typing continuously for a minute
	// stays under this; it exists to bound abuse of the operator's Klipy quota.
	gifRateLimitPerMinute = 30

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

	// profileUpdateRateLimitPerMinute is the maximum profile update attempts
	// per user per minute.
	profileUpdateRateLimitPerMinute = 10

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

	// emojiUploadRateLimitPerMinute is the maximum custom-emoji uploads per
	// MANAGE_SERVER holder per minute. Lower than the attachment limit: every
	// accepted upload fans an emoji_update out to every connected session.
	emojiUploadRateLimitPerMinute = 10
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
	// stale rate-limiter entries. It must cover the LARGEST window any caller
	// passes to Allow: slow mode (service/message_crud.go) uses windows up to
	// admin's maxSlowModeSeconds (21600 s = 6 h), and a shorter horizon makes
	// the reaper silently reset long slow modes after ~15 minutes.
	rateLimiterCleanupMaxWindow = 6 * time.Hour

	// hstsMaxAgeSeconds is the max-age value for the Strict-Transport-Security header.
	hstsMaxAgeSeconds = 31536000
)

// bodyCapExemptPrefixes are the route prefixes excluded from the global 1 MiB
// body cap because they enforce their own, larger envelope at the route or
// handler level. A route with a documented cap above 1 MiB that is missing
// here is unreachable at its own limit: MaxBytesReader wrappers merely
// delegate reads, so the innermost (global) limit errors first.
var bodyCapExemptPrefixes = []string{
	"/api/v1/uploads",
	// 16 MiB plugin envelope enforced by the handler's own MaxBytesReader.
	"/api/v1/admin/plugins/install",
	// 2 MiB avatar envelope: route-scoped MaxBodySize(avatarMaxBodySize)
	// plus the handler's re-wrap enforce it.
	"/api/v1/users/me/avatar",
}

// ─── Size limits ────────────────────────────────────────────────────────────

const (
	// defaultMaxBodySize is the default request body size limit (1 MiB).
	defaultMaxBodySize = config.MaxMessageBytes

	// uploadMaxBodySize is the request body size limit for file uploads (100 MiB).
	uploadMaxBodySize = 100 << 20

	// multipartMemoryLimit is the in-memory limit for multipart form parsing;
	// data beyond this is spilled to disk.
	multipartMemoryLimit = 10 << 20

	// maxUploadFilenameLength is the maximum length of an upload filename
	// (filesystem-safe limit).
	maxUploadFilenameLength = 255

	// maxAvatarURLLen is the maximum length of a user avatar URL.
	maxAvatarURLLen = 512

	// maxEmojiFileBytes is the largest custom-emoji image accepted (512 KiB).
	// An emoji renders at 22px inline and 48px jumbo, so anything approaching
	// this is already far more data than the pixels can use.
	maxEmojiFileBytes = 512 << 10

	// maxEmojiDimension caps an emoji's width and height in pixels. Discord
	// normalizes to 128px; matching it means an emoji uploaded for OwnCord
	// looks the same as the one it was copied from, jumbo included.
	maxEmojiDimension = 128

	// emojiMaxBodySize bounds the whole multipart request. The image cap plus
	// the form's own framing (boundaries, headers, the shortcode field) —
	// generous enough that a legitimate 512 KiB upload never trips it.
	emojiMaxBodySize = 1 << 20

	// emojiMultipartMemoryLimit is the in-memory limit for parsing an emoji
	// upload. Above maxEmojiFileBytes, so a valid emoji never spills to disk.
	emojiMultipartMemoryLimit = 1 << 20

	// maxAvatarFileBytes is the largest avatar image accepted (1 MiB). An
	// avatar renders at 40px in a message row and 64px in the profile popup,
	// so this is already generous; the client downscales before uploading and
	// the cap is what stops it being used as free file hosting.
	maxAvatarFileBytes = 1 << 20

	// maxAvatarDimension caps an avatar's stored width and height. Bigger than
	// any surface renders it, so a retina display still has pixels to spare
	// while a 6000px camera JPEG is refused rather than shipped to every
	// client that sees the user post.
	maxAvatarDimension = 1024

	// avatarMaxBodySize bounds the whole multipart avatar request: the image
	// cap plus room for the form's boundaries and headers.
	avatarMaxBodySize = 2 << 20

	// avatarMultipartMemoryLimit is the in-memory limit for parsing an avatar
	// upload. Above maxAvatarFileBytes, so a valid avatar never spills to disk.
	avatarMultipartMemoryLimit = 2 << 20

	// avatarUploadRateLimitPerMinute is the maximum avatar uploads per user per
	// minute. Lower than the attachment limit: every accepted upload fans a
	// user_update out to every connected session and orphans the previous file.
	avatarUploadRateLimitPerMinute = 5

	// maxRequestIDLen bounds a client-supplied X-Request-Id. chi's
	// middleware.RequestID adopts that header verbatim, and the value then
	// reaches every log record for the request (logctx, requestLogger,
	// recoverer) and the echoed response header — while the admin ring buffer
	// retains 2000 records, so an unbounded id becomes long-lived heap.
	// 128 bytes fits every common correlation-id format (UUID, 32-hex,
	// W3C traceparent, chi's own "host/prefix-000001").
	maxRequestIDLen = 128

	// maxLoggedPathLen bounds the request path attached to a log record. The
	// URL is client-controlled and net/http accepts one up to MaxHeaderBytes
	// (~1 MiB), so an unbounded path fills the ring buffer the same way an
	// unbounded request id does. Well past the longest real route.
	maxLoggedPathLen = 256
)
