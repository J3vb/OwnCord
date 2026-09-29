package ws

// WebSocket error codes used in buildErrorMsg calls.
const (
	ErrCodeBadRequest    = "BAD_REQUEST"
	ErrCodeInternal      = "INTERNAL"
	ErrCodeNotFound      = "NOT_FOUND"
	ErrCodeForbidden     = "FORBIDDEN"
	ErrCodeRateLimited   = "RATE_LIMITED"
	ErrCodeAlreadyJoined = "ALREADY_JOINED"
	ErrCodeChannelFull   = "CHANNEL_FULL"
	ErrCodeVoiceError    = "VOICE_ERROR"
	ErrCodeVideoLimit    = "VIDEO_LIMIT"
	ErrCodeBanned        = "BANNED"
	ErrCodeInvalidJSON   = "INVALID_JSON"
	ErrCodeUnknownType   = "UNKNOWN_TYPE"
	ErrCodeSlowMode      = "SLOW_MODE"
	ErrCodeConflict      = "CONFLICT"
	ErrCodeBadPayload    = "BAD_PAYLOAD"
	ErrCodeNotKeyHolder  = "NOT_KEY_HOLDER"
	// Returned when a user tries to lift a moderator-imposed voice state.
	ErrCodeServerMuted    = "SERVER_MUTED"
	ErrCodeServerDeafened = "SERVER_DEAFENED"
	// ErrCodeTimedOut is returned for a send, reaction or voice join refused
	// by an active moderator timeout (B5-9).
	ErrCodeTimedOut = "TIMED_OUT"
	// ErrCodeSessionReplaced is sent to a connection the hub displaces
	// because the same user connected from another device. The client stops
	// reconnecting on it; without it the displaced device cannot tell the
	// close from a network drop and the two devices trade the socket forever.
	ErrCodeSessionReplaced = "SESSION_REPLACED"
	// ErrCodeAnotherDeviceActive is returned in a plain `error` frame to a
	// wake reconnect (auth frame `wake: true`) when a DIFFERENT session of
	// the same account currently holds the live connection. It is not
	// auth_error: the token is still valid. The wake is refused without
	// displacing the live session; the client stops reconnecting and offers
	// "Use here" so the user chooses whether to take over.
	ErrCodeAnotherDeviceActive = "ANOTHER_DEVICE_ACTIVE"
)
