package api

import (
	"regexp"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

// The auth rate multiplier (security.auth_rate_limit_multiplier) lives in
// auth/ratescale.go so route mounts and service.AuthService read one value.

func setAuthRateScale(m float64) { auth.SetRateScale(m) }

func scaledAuthLimit(n int) int { return auth.ScaledLimit(n) }

const (
	registerRateLimitPerMinute = 3

	loginRateLimitPerMinute = 5

	verifyTOTPRateLimitPerMinute = 10

	// Applies to destructive endpoints: account deletion, TOTP enable/confirm/disable.
	sensitiveEndpointRateLimitPerMinute = 5

	searchRateLimitPerMinute = 30

	mediaRateLimitPerMinute = 120

	ownUploadsRateLimitPerMinute = 120

	livekitProxyRateLimitPerMinute = 30

	clientUpdateRateLimitPerMinute = 30

	// Per IP, before any auth; shared-NAT communities raise it with the auth rate multiplier.
	wsUpgradeRateLimitPerMinute = 60

	// The picker debounces at 300ms; the limit bounds abuse of the operator's Klipy quota.
	gifRateLimitPerMinute = 30

	// Per IP: a GIF picker page asks for 20 images, each an outbound fetch.
	externalRateLimitPerMinute = 300

	// Looser than the proxy's: no upstream call.
	gifFavoritesRateLimitPerMinute = 300

	ownModerationRateLimitPerMinute = 30

	profilePasswordRateLimitPerMinute = 5

	profileUpdateRateLimitPerMinute = 10

	uploadRateLimitPerMinute = 10

	// Caps one user's in-flight uploads; each holds a storage reservation up to the
	// per-file cap, so without it one member could push everyone else into the
	// low-disk refusal. Matches MAX_ATTACHMENTS in Client/src/components/MessageInput.ts; change together.
	maxConcurrentUploadsPerUser = 10

	// Per route: each parses its multipart body into memory under a transfer deadline
	// that can run for minutes on a slow link.
	maxConcurrentImageUploadsPerUser = 2

	// Lower than the attachment limit: every accepted upload fans an emoji_update out to all sessions.
	emojiUploadRateLimitPerMinute = 10

	stickerUploadRateLimitPerMinute = 10
)

const (
	hstsMaxAgeSeconds = 31536000
)

// Route prefixes excluded from the global 1 MiB body cap because they enforce their own, larger envelope.
// A route missing here is unreachable at its own limit: the innermost (global) MaxBytesReader errors first.
// errors first.
var bodyCapExemptPrefixes = []string{
	"/api/v1/uploads",
	"/api/v1/admin/plugins/install",
	"/api/v1/users/me/avatar",
	"/api/v1/users/me/banner",
	"/admin/api/discord-imports/upload",
}

// The one upload route with an id mid-path (POST /api/v1/dms/{id}/icon), which a prefix cannot
// exempt. WAF rules 1004 and 900006 in waf.go mirror it.
// 900006 in waf.go mirror it.
var bodyCapExemptPattern = regexp.MustCompile(`^/api/v1/dms/[0-9]+/icon$`)

const (
	defaultMaxBodySize = config.MaxMessageBytes

	// Upload body limit (100 MiB) when upload.max_size_mb is below 100; from 100 up, uploadBodyCap sets it.
	uploadMaxBodySize = 100 << 20

	uploadMultipartMargin = 1 << 20

	maxUploadFilenameLength = 255

	// Bound a transfer's total lifetime however steadily it progresses: a peer trickling a byte per
	// transferProgressTimeout would otherwise hold its reservation and connection indefinitely.
	// Between the bounds it follows size at transferSlowestRate (transferLifetimeFor).
	transferMinLifetime = 10 * time.Minute
	transferMaxLifetime = 60 * time.Minute

	// The slowest link a full-size transfer is sized for: 64 KiB/s.
	transferSlowestRate = 64 << 10

	// Time to write the 408 once the read deadline has passed; both are armed to the same instant.
	transferTimedOutWriteGrace = 5 * time.Second

	// How long an in-flight transfer may continue once shutdown begins; it fits inside the 30 s HTTP drain
	// budget (httpDrainBudget), so a short transfer finishes while a trickling one cannot hold the drain.
	shutdownTransferGrace = 20 * time.Second

	maxAvatarURLLen = 512

	// Emoji render at 22px inline and 48px jumbo, so more is wasted data.
	maxEmojiFileBytes = 512 << 10

	// Discord normalizes to 128px; matching it keeps copied emoji looking the same.
	maxEmojiDimension = 128

	emojiMaxBodySize = 1 << 20

	// Above maxEmojiFileBytes so a valid emoji never spills to disk.
	emojiMultipartMemoryLimit = 1 << 20

	maxStickerFileBytes = 512 << 10

	// A sticker renders at 160px, so 320px covers high-density screens without letting a full-size picture
	// through.
	maxStickerDimension = 320

	stickerMaxBodySize = 1 << 20

	// Above maxStickerFileBytes so a valid sticker never spills to disk.
	stickerMultipartMemoryLimit = 1 << 20

	stickerPatchMaxBodySize = 4 << 10

	// Avatars render at 40-64px; the room is for animated GIF/WebP, which the client uploads as-is.
	maxAvatarFileBytes = 2 << 20

	// Icons are always still, so this keeps the earlier avatar cap.
	maxGroupIconFileBytes = 1 << 20

	// Exceeds any rendered size for retina, while a 6000px camera JPEG is refused.
	maxAvatarDimension = 1024

	avatarMaxBodySize = maxAvatarFileBytes + 1<<20

	// Above maxAvatarFileBytes so a valid avatar never spills to disk.
	avatarMultipartMemoryLimit = avatarMaxBodySize

	// Lower than the attachment limit: every accepted upload fans a user_update out and orphans the previous
	// file.
	avatarUploadRateLimitPerMinute = 5

	// The client crops a still to 5:2; an animated one goes up as-is, which is the room above 1 MiB.
	maxBannerFileBytes = 4 << 20
	maxBannerWidth     = 1920
	maxBannerHeight    = 960

	bannerMaxBodySize          = maxBannerFileBytes + 1<<20
	bannerMultipartMemoryLimit = bannerMaxBodySize

	maxBannerColorLen = 7

	// The avatar's rate: every accepted banner fans a user_update out.
	bannerUploadRateLimitPerMinute = avatarUploadRateLimitPerMinute

	maxUserNoteLen = service.MaxUserNoteRunes

	// Raw bound is maxUserNoteLen*4 bytes; JSON escaping can take up to six bytes per raw byte (\u00XX), plus
	// the envelope.
	userNoteMaxBody = maxUserNoteLen*4*6 + 512

	// The client debounces at 600 ms, so steady typing stays under it.
	userNoteRateLimitPerMinute = 30

	// Bounds a client-supplied X-Request-Id: chi adopts it verbatim, it reaches every log record, and the
	// ring buffer retains 2000 records. 128 bytes fits UUID, 32-hex, W3C traceparent.
	maxRequestIDLen = 128

	// Bounds the client-controlled request path in a log record; well past the longest real route.
	maxLoggedPathLen = 256
)
