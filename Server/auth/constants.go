package auth

import "time"

const (
	// ─── Username validation ────────────────────────────────────────────────

	// minUsernameLength is the minimum number of runes in a username.
	minUsernameLength = 2

	// maxUsernameLength is the maximum number of runes in a username.
	maxUsernameLength = 32

	// ─── Token generation ───────────────────────────────────────────────────

	// sessionTokenBytes is the number of random bytes in a session token (256 bits).
	sessionTokenBytes = 32

	// opaqueTokenBytes is the number of random bytes in an opaque token (256 bits).
	opaqueTokenBytes = 32

	// totpSecretBytes is the number of random bytes used to generate a TOTP secret.
	totpSecretBytes = 20

	// ─── TOTP replay prevention ─────────────────────────────────────────────

	// usedTOTPCodeTTL is how long a verified TOTP code is remembered to prevent
	// replay attacks (covers the current period +/- 1, ~90 seconds).
	usedTOTPCodeTTL = 90 * time.Second
)
