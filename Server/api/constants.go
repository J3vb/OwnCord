package api

import (
	"regexp"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

// The auth rate multiplier (security.auth_rate_limit_multiplier) lives in
// auth/ratescale.go so the route mounts here and the login-failure accounting in
// service.AuthService read one value; these wrappers keep the mount sites and
// constants_test.go unchanged.

func setAuthRateScale(m float64) { auth.SetRateScale(m) }

func scaledAuthLimit(n int) int { return auth.ScaledLimit(n) }

const (
	registerRateLimitPerMinute = 3

	loginRateLimitPerMinute = 5

	verifyTOTPRateLimitPerMinute = 10

	// sensitiveEndpointRateLimitPerMinute is the rate limit applied to destructive
	// or sensitive endpoints (account deletion, TOTP enable/confirm/disable).
	sensitiveEndpointRateLimitPerMinute = 5

	searchRateLimitPerMinute = 30

	// mediaRateLimitPerMinute covers the gallery's pages and month counts;
	// a fast scroll asks for a page every few seconds.
	mediaRateLimitPerMinute = 120

	// ownUploadsRateLimitPerMinute covers the signed-in user's storage figure,
	// upload list and removals on the My uploads page; one limit for all three,
	// since paging and removing interleave.
	ownUploadsRateLimitPerMinute = 120

	livekitProxyRateLimitPerMinute = 30

	clientUpdateRateLimitPerMinute = 30

	// wsUpgradeRateLimitPerMinute is per IP, before any auth. A client
	// reconnects with backoff, so one a second is ample; shared-NAT communities
	// raise it with the auth rate multiplier.
	wsUpgradeRateLimitPerMinute = 60

	// The picker debounces at 300ms, so continuous typing stays under
	// gifRateLimitPerMinute; it exists to bound abuse of the operator's Klipy
	// quota.
	gifRateLimitPerMinute = 30

	// externalRateLimitPerMinute is per IP: a GIF picker page asks for 20
	// images and a busy channel a few dozen, each an outbound fetch.
	externalRateLimitPerMinute = 300

	// gifFavoritesRateLimitPerMinute is looser than the proxy's because there is
	// no upstream call.
	gifFavoritesRateLimitPerMinute = 300

	ownModerationRateLimitPerMinute = 30

	profilePasswordRateLimitPerMinute = 5

	profileUpdateRateLimitPerMinute = 10

	uploadRateLimitPerMinute = 10

	// maxConcurrentUploadsPerUser caps one user's in-flight uploads. Each can
	// live up to transferMaxLifetime and holds a storage reservation of up to
	// the per-file cap, so without this bound one member could reserve enough
	// headroom to push every other user into the low-disk refusal. It matches
	// the desktop client's MAX_ATTACHMENTS
	// (Client/src/components/MessageInput.ts), which starts every upload at
	// once; change the two together.
	maxConcurrentUploadsPerUser = 10

	// emojiUploadRateLimitPerMinute (per MANAGE_SERVER holder) is lower than the
	// attachment limit: every accepted upload fans an emoji_update out to every
	// connected session.
	emojiUploadRateLimitPerMinute = 10

	// stickerUploadRateLimitPerMinute is lower for the same reason as the emoji
	// limit.
	stickerUploadRateLimitPerMinute = 10
)

const (
	hstsMaxAgeSeconds = 31536000
)

// bodyCapExemptPrefixes are the route prefixes excluded from the global 1 MiB
// body cap because they enforce their own, larger envelope. A route with a
// documented cap above 1 MiB that is missing here is unreachable at its own
// limit: MaxBytesReader wrappers delegate reads, so the innermost (global) limit
// errors first.
var bodyCapExemptPrefixes = []string{
	"/api/v1/uploads",
	// 16 MiB plugin envelope enforced by the handler's own MaxBytesReader.
	"/api/v1/admin/plugins/install",
	// 3 MiB avatar envelope: route-scoped MaxBodySize(avatarMaxBodySize)
	// plus the handler's re-wrap enforce it.
	"/api/v1/users/me/avatar",
	// 5 MiB banner envelope, enforced the same way with
	// bannerMaxBodySize.
	"/api/v1/users/me/banner",
}

// bodyCapExemptPattern names the one upload route with an id mid-path, which a
// prefix cannot: POST /api/v1/dms/{id}/icon. It covers only that route (POST,
// escaped path), which enforces the avatar envelope itself. WAF rules 1004 and
// 900006 in waf.go mirror it.
var bodyCapExemptPattern = regexp.MustCompile(`^/api/v1/dms/[0-9]+/icon$`)

const (
	defaultMaxBodySize = config.MaxMessageBytes

	// uploadMaxBodySize is the request body size limit for file uploads
	// (100 MiB) when upload.max_size_mb is below 100 (0 disables uploads);
	// from 100 up, the per-file cap plus the multipart margin sets it
	// (uploadBodyCap).
	uploadMaxBodySize = 100 << 20

	// uploadMultipartMargin is the room uploadBodyCap leaves for the
	// multipart boundary and part headers around a file at the per-file cap.
	uploadMultipartMargin = 1 << 20

	maxUploadFilenameLength = 255

	// transferProgressTimeout is the gap without any byte read or written after
	// which a transfer is abandoned. The global 30 s ReadTimeout/WriteTimeout
	// bound the WHOLE request, so a slow-uplink upload (25 MB at 1 Mbit/s is
	// about 200 s) would be cut mid-body and a download truncated with no error.
	// The progress wrappers in upload_handler.go push the deadline out on every
	// chunk, so a moving transfer survives until transferMaxLifetime and a
	// stalled peer does not.
	transferProgressTimeout = 30 * time.Second

	// transferMaxLifetime caps a transfer's total lifetime however steadily it
	// progresses: a peer trickling a byte per transferProgressTimeout would
	// otherwise hold its storage reservation, connection and goroutine
	// indefinitely. 10 minutes matches the client tunnel's 600 s data-copy
	// bound.
	transferMaxLifetime = 10 * time.Minute

	// shutdownTransferGrace is how long an in-flight transfer may keep going
	// once server shutdown begins. It fits inside the 30 s HTTP drain budget
	// (httpDrainBudget in internal/app/lifecycle.go), so a short transfer
	// still finishes while a trickling one cannot hold the drain past it.
	shutdownTransferGrace = 20 * time.Second

	maxAvatarURLLen = 512

	// maxEmojiFileBytes is the largest custom-emoji image accepted (512 KiB); an
	// emoji renders at 22px inline and 48px jumbo, so more is wasted data.
	maxEmojiFileBytes = 512 << 10

	// maxEmojiDimension caps an emoji's width and height in pixels. Discord
	// normalizes to 128px; matching it means an emoji uploaded for OwnCord
	// looks the same as the one it was copied from, jumbo included.
	maxEmojiDimension = 128

	// emojiMaxBodySize bounds the whole multipart request: the image cap plus
	// form framing, generous enough that a legitimate upload never trips it.
	emojiMaxBodySize = 1 << 20

	// emojiMultipartMemoryLimit is above maxEmojiFileBytes so a valid emoji
	// never spills to disk.
	emojiMultipartMemoryLimit = 1 << 20

	maxStickerFileBytes = 512 << 10

	// maxStickerDimension caps a sticker's width and height in pixels. A
	// sticker renders at 160px in a message, so 320px covers high-density
	// screens without letting a full-size picture through.
	maxStickerDimension = 320

	// stickerMaxBodySize bounds the whole multipart request: the image cap plus
	// form framing.
	stickerMaxBodySize = 1 << 20

	// stickerMultipartMemoryLimit is above maxStickerFileBytes so a valid
	// sticker never spills to disk.
	stickerMultipartMemoryLimit = 1 << 20

	stickerPatchMaxBodySize = 4 << 10

	// maxAvatarFileBytes is the largest avatar image accepted (2 MiB). Avatars
	// render at 40-64px, so the room is for animated GIF/WebP, which the client
	// uploads as-is; the cap stops it being used as free file hosting.
	maxAvatarFileBytes = 2 << 20

	// maxGroupIconFileBytes is the largest group DM icon accepted (1 MiB); icons
	// are always still, so it keeps the earlier avatar cap.
	maxGroupIconFileBytes = 1 << 20

	// maxAvatarDimension caps an avatar's stored width and height. It exceeds
	// any rendered size so retina screens have pixels to spare, while a 6000px
	// camera JPEG is refused rather than shipped to every client.
	maxAvatarDimension = 1024

	// avatarMaxBodySize bounds the whole multipart avatar (and group icon)
	// request: image cap plus form framing.
	avatarMaxBodySize = maxAvatarFileBytes + 1<<20

	// avatarMultipartMemoryLimit is above maxAvatarFileBytes so a valid avatar
	// never spills to disk.
	avatarMultipartMemoryLimit = avatarMaxBodySize

	// avatarUploadRateLimitPerMinute is the maximum avatar uploads per user per
	// minute. Lower than the attachment limit: every accepted upload fans a
	// user_update out to every connected session and orphans the previous file.
	avatarUploadRateLimitPerMinute = 5

	// maxBannerFileBytes (4 MiB) and maxBannerWidth by maxBannerHeight are the
	// largest banner image accepted. The client crops a still to 5:2 and scales
	// it down; an animated one goes up as-is, which is the room above 1 MiB.
	maxBannerFileBytes = 4 << 20
	maxBannerWidth     = 1920
	maxBannerHeight    = 960

	// bannerMaxBodySize and bannerMultipartMemoryLimit mirror the avatar's.
	bannerMaxBodySize          = maxBannerFileBytes + 1<<20
	bannerMultipartMemoryLimit = bannerMaxBodySize

	maxBannerColorLen = 7

	// bannerUploadRateLimitPerMinute is the avatar's rate: every accepted banner
	// fans a user_update out to every connected session.
	bannerUploadRateLimitPerMinute = avatarUploadRateLimitPerMinute

	// maxUserNoteLen is the rune cap on a private profile note (migration 069).
	maxUserNoteLen = service.MaxUserNoteRunes

	// userNoteMaxBody bounds a note PUT body. maxUserNoteLen*4 bytes is the raw
	// bound the service enforces; JSON escaping can take up to six bytes per
	// raw byte (\u00XX), plus room for the JSON envelope.
	userNoteMaxBody = maxUserNoteLen*4*6 + 512

	// userNoteRateLimitPerMinute is the maximum note writes per client per
	// minute. The client debounces at 600 ms, so steady typing stays under it.
	userNoteRateLimitPerMinute = 30

	// maxRequestIDLen bounds a client-supplied X-Request-Id: chi's RequestID
	// adopts the header verbatim, it reaches every log record and the echoed
	// header, and the admin ring buffer retains 2000 records, so an unbounded id
	// becomes long-lived heap. 128 bytes fits common correlation-id formats
	// (UUID, 32-hex, W3C traceparent, chi's "host/prefix-000001").
	maxRequestIDLen = 128

	// maxLoggedPathLen bounds the request path attached to a log record: the URL
	// is client-controlled and net/http accepts up to ~1 MiB, so an unbounded
	// path fills the ring buffer like an unbounded request id. Well past the
	// longest real route.
	maxLoggedPathLen = 256
)
