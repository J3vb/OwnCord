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
)
