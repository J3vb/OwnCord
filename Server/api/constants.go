package api

import (
	"regexp"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

// ─── Rate limits ────────────────────────────────────────────────────────────
//
// Each constant defines either a request cap or a sliding-window duration used
// by the per-endpoint rate limiters.

// The auth rate multiplier (security.auth_rate_limit_multiplier) lives in
// auth (auth/ratescale.go), so the route mounts here and the login
// failure accounting in service.AuthService read one value. These wrappers
// keep the mount sites and api/constants_test.go unchanged.

// setAuthRateScale clamps and installs the auth rate multiplier. Zero or
// negative (unset config) means 1.0.
func setAuthRateScale(m float64) { auth.SetRateScale(m) }

// scaledAuthLimit applies the auth rate multiplier to a compiled-in limit,
// never returning less than 1.
func scaledAuthLimit(n int) int { return auth.ScaledLimit(n) }

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

	// wsUpgradeRateLimitPerMinute is the maximum WebSocket upgrade requests per
	// IP per minute, before any auth. A client reconnects with backoff, so one
	// a second is ample; shared-NAT communities raise it with the auth rate
	// multiplier.
	wsUpgradeRateLimitPerMinute = 60

	// gifRateLimitPerMinute is the maximum GIF proxy requests per IP per minute.
	// The picker debounces at 300ms, so a user typing continuously for a minute
	// stays under this; it exists to bound abuse of the operator's Klipy quota.
	gifRateLimitPerMinute = 30

	// gifFavoritesRateLimitPerMinute bounds favorite list/add/remove per IP;
	// there is no upstream call, so it is looser than the proxy's.
	gifFavoritesRateLimitPerMinute = 300

	// ownModerationRateLimitPerMinute is the maximum GET
	// /api/v1/users/me/moderation reads per IP per minute.
	ownModerationRateLimitPerMinute = 30

	// profilePasswordRateLimitPerMinute is the maximum password change attempts
	// per IP per minute.
	profilePasswordRateLimitPerMinute = 5

	// profileUpdateRateLimitPerMinute is the maximum profile update attempts
	// per user per minute.
	profileUpdateRateLimitPerMinute = 10

	// uploadRateLimitPerMinute is the maximum file uploads per user per minute.
	uploadRateLimitPerMinute = 10

	// maxConcurrentUploadsPerUser caps how many uploads one user may have in
	// flight at once. An upload may now live up to transferMaxLifetime while
	// trickling bytes, and each one holds a storage reservation of up to the
	// per-file cap for its whole life, so without this bound one member could
	// stack up enough reserved headroom to push every other user into the
	// low-disk refusal. It matches the desktop client's MAX_ATTACHMENTS
	// (Client/src/components/MessageInput.ts), which starts every attachment's
	// upload at once, so change the two together. Ten in flight bounds that
	// member's reserved headroom to 10x the per-file cap.
	maxConcurrentUploadsPerUser = 10

	// emojiUploadRateLimitPerMinute is the maximum custom-emoji uploads per
	// MANAGE_SERVER holder per minute. Lower than the attachment limit: every
	// accepted upload fans an emoji_update out to every connected session.
	emojiUploadRateLimitPerMinute = 10

	// stickerUploadRateLimitPerMinute is the maximum custom-sticker uploads per
	// MANAGE_SERVER holder per minute, for the same reason as the emoji limit.
	stickerUploadRateLimitPerMinute = 10
)

// ─── Timeouts & TTLs ────────────────────────────────────────────────────────

const (
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
	// 3 MiB avatar envelope: route-scoped MaxBodySize(avatarMaxBodySize)
	// plus the handler's re-wrap enforce it.
	"/api/v1/users/me/avatar",
	// 5 MiB banner envelope, enforced the same way with
	// bannerMaxBodySize.
	"/api/v1/users/me/banner",
}

// bodyCapExemptPattern names the upload route that carries an id in the middle
// of its path, so a prefix cannot: POST /api/v1/dms/{id}/icon. The exemption
// covers only that route (POST, the escaped path), which enforces the avatar
// envelope itself (route-scoped MaxBodySize(avatarMaxBodySize) plus the
// handler's re-wrap). The WAF rules 1004 and 900006 in waf.go mirror it.
var bodyCapExemptPattern = regexp.MustCompile(`^/api/v1/dms/[0-9]+/icon$`)

// ─── Size limits ────────────────────────────────────────────────────────────

const (
	// defaultMaxBodySize is the default request body size limit (1 MiB).
	defaultMaxBodySize = config.MaxMessageBytes

	// uploadMaxBodySize is the request body size limit for file uploads
	// (100 MiB) when upload.max_size_mb is below 100 (0 disables uploads);
	// from 100 up, the per-file cap plus the multipart margin sets it
	// (uploadBodyCap).
	uploadMaxBodySize = 100 << 20

	// uploadMultipartMargin is the room uploadBodyCap leaves for the
	// multipart boundary and part headers around a file at the per-file cap.
	uploadMultipartMargin = 1 << 20

	// maxUploadFilenameLength is the maximum length of an upload filename
	// (filesystem-safe limit).
	maxUploadFilenameLength = 255

	// transferProgressTimeout is the gap without any byte read or written
	// after which a file transfer is abandoned. The server's global
	// ReadTimeout/WriteTimeout (30 s) bound the WHOLE request — the client
	// tunnel's own 600 s data-copy bound is wider — so a 25 MB upload on a
	// slow uplink (about 200 s at 1 Mbit/s) is otherwise cut mid-body and a
	// download truncates with no error. The per-route progress wrappers in
	// upload_handler.go push the connection deadline out on every chunk, so a
	// transfer that keeps moving is not cut before transferMaxLifetime, while
	// a peer that stalls is.
	transferProgressTimeout = 30 * time.Second

	// transferMaxLifetime caps a file transfer's total lifetime however
	// steadily it progresses, restoring the bound the whole-request 30 s
	// timeouts used to give: without it a peer trickling one byte per
	// transferProgressTimeout holds its storage reservation, connection and
	// goroutine indefinitely. 10 minutes matches the client tunnel's 600 s
	// data-copy bound, so any transfer the client would finish is not cut.
	transferMaxLifetime = 10 * time.Minute

	// shutdownTransferGrace is how long an in-flight transfer may keep going
	// once server shutdown begins. It fits inside the 30 s HTTP drain budget
	// (httpDrainBudget in internal/app/lifecycle.go), so a short transfer
	// still finishes while a trickling one cannot hold the drain past it.
	shutdownTransferGrace = 20 * time.Second

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

	// maxStickerFileBytes is the largest custom-sticker image accepted (512 KiB).
	maxStickerFileBytes = 512 << 10

	// maxStickerDimension caps a sticker's width and height in pixels. A
	// sticker renders at 160px in a message, so 320px covers high-density
	// screens without letting a full-size picture through.
	maxStickerDimension = 320

	// stickerMaxBodySize bounds the whole multipart request: the image cap
	// plus the form's own framing.
	stickerMaxBodySize = 1 << 20

	// stickerMultipartMemoryLimit is the in-memory limit for parsing a sticker
	// upload, above maxStickerFileBytes so a valid sticker never spills to disk.
	stickerMultipartMemoryLimit = 1 << 20

	// stickerPatchMaxBodySize bounds a rename body: a name and an emoji.
	stickerPatchMaxBodySize = 4 << 10

	// maxAvatarFileBytes is the largest avatar image accepted (2 MiB).
	// An avatar renders at 40px in a message row and 64px in the profile
	// popup, so a still picture never comes near it; the room is for an
	// animated GIF or WebP, which the client uploads as-is. The cap is what
	// stops it being used as free file hosting.
	maxAvatarFileBytes = 2 << 20

	// maxGroupIconFileBytes is the largest group DM icon accepted (1 MiB). A
	// group icon is always still, so it keeps the pre-8.7 avatar cap.
	maxGroupIconFileBytes = 1 << 20

	// maxAvatarDimension caps an avatar's stored width and height. Bigger than
	// any surface renders it, so a retina display still has pixels to spare
	// while a 6000px camera JPEG is refused rather than shipped to every
	// client that sees the user post.
	maxAvatarDimension = 1024

	// avatarMaxBodySize bounds the whole multipart avatar (and group icon)
	// request: the image cap plus room for the form's boundaries and headers.
	avatarMaxBodySize = maxAvatarFileBytes + 1<<20

	// avatarMultipartMemoryLimit is the in-memory limit for parsing an avatar
	// upload. Above maxAvatarFileBytes, so a valid avatar never spills to disk.
	avatarMultipartMemoryLimit = avatarMaxBodySize

	// avatarUploadRateLimitPerMinute is the maximum avatar uploads per user per
	// minute. Lower than the attachment limit: every accepted upload fans a
	// user_update out to every connected session and orphans the previous file.
	avatarUploadRateLimitPerMinute = 5

	// maxBannerFileBytes is the largest profile banner image accepted (4 MiB),
	// and maxBannerWidth by maxBannerHeight the largest it may
	// measure. The client crops a still picture to 5:2 and scales
	// it down before uploading; an animated one goes up as-is, which is what
	// the room above the old 1 MiB is for.
	maxBannerFileBytes = 4 << 20
	maxBannerWidth     = 1920
	maxBannerHeight    = 960

	// bannerMaxBodySize and bannerMultipartMemoryLimit are the banner's
	// avatarMaxBodySize and avatarMultipartMemoryLimit.
	bannerMaxBodySize          = maxBannerFileBytes + 1<<20
	bannerMultipartMemoryLimit = bannerMaxBodySize

	// maxBannerColorLen is the longest valid banner colour (#rrggbb).
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
