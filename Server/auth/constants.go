package auth

import "time"

const (

	// minUsernameLength and maxUsernameLength bound a username in runes.
	minUsernameLength = 2

	maxUsernameLength = 32

	// sessionTokenBytes and opaqueTokenBytes are random bytes per token (256 bits).
	sessionTokenBytes = 32

	opaqueTokenBytes = 32

	totpSecretBytes = 20

	// usedTOTPCodeTTL is how long a verified TOTP code is remembered against
	// replay (the current period +/- 1).
	usedTOTPCodeTTL = 90 * time.Second
)
