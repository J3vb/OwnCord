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
)
