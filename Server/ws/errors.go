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
	// ErrCodeAlreadyDeleted is the WS twin of REST's 409 ALREADY_DELETED: the
	// same "already in the requested end state" refusal, so a client sees one
	// code for the state rather than FORBIDDEN over WS and ALREADY_DELETED
	// over REST (F23).
	ErrCodeAlreadyDeleted = "ALREADY_DELETED"
	ErrCodeBadPayload     = "BAD_PAYLOAD"
	ErrCodeNotKeyHolder   = "NOT_KEY_HOLDER"
	// Returned when a user tries to lift a moderator-imposed voice state.
	ErrCodeServerMuted    = "SERVER_MUTED"
	ErrCodeServerDeafened = "SERVER_DEAFENED"
	// ErrCodeTimedOut is returned for a send, edit, reaction, voice join,
	// call ring or custom status refused by an active moderator timeout
	// (B5-9).
	ErrCodeTimedOut = "TIMED_OUT"
	// ErrCodeCallRequiresAcceptance answers a 1:1 call_ring whose recipient
	// has not accepted the caller's message request. One code for every
	// untrusted state, so it reveals nothing the caller's own request does
	// not; the ring is never delivered (DM call review D-03).
	ErrCodeCallRequiresAcceptance = "CALL_REQUIRES_ACCEPTANCE"
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
	// ErrCodeServerBusy refuses a fresh connect that waited readyAdmissionWait
	// for a ready-build permit (P5-S04). It carries retry_after_ms, and the
	// socket closes 1013 right after; the client redials no sooner.
	ErrCodeServerBusy = "SERVER_BUSY"
)
