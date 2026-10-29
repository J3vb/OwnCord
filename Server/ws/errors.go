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
	// ErrCodeAttachmentsUnavailable refines BAD_REQUEST: a send with no text
	// whose every attachment was skipped. Nothing was stored.
	ErrCodeAttachmentsUnavailable = "ATTACHMENTS_UNAVAILABLE"
	// ErrCodeReactionLimit refines BAD_REQUEST: a new emoji on a message that
	// already holds 20 different ones. No reaction_update is sent.
	ErrCodeReactionLimit = "REACTION_LIMIT"
	// ErrCodePollEnded refines BAD_REQUEST: a poll_vote or poll_end on a poll
	// that was already ended or whose time ran out. Nothing was written and no
	// poll_update is sent for the refused command.
	ErrCodePollEnded = "POLL_ENDED"
	// ErrCodeStickerNotFound refines NOT_FOUND: a chat_send named a sticker
	// that does not exist, or was deleted. Nothing was stored, and the client
	// refreshes its picker from sticker_update.
	ErrCodeStickerNotFound = "STICKER_NOT_FOUND"
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
	// because the same device session reconnected (F5, network drop, wake), or
	// because the account is over its per-user connection cap. The client stops
	// reconnecting on it; without it the displaced device cannot tell the
	// close from a network drop and the two devices trade the socket forever.
	ErrCodeSessionReplaced = "SESSION_REPLACED"
	// ErrCodeAnotherDeviceActive is kept for wire compatibility only: the
	// server no longer sends it, because several device sessions of one
	// account now stay connected at once. Older servers sent it to a wake
	// reconnect refused while another session held the connection, and
	// clients still handle it.
	ErrCodeAnotherDeviceActive = "ANOTHER_DEVICE_ACTIVE"
	// ErrCodeServerBusy refuses a fresh connect that waited readyAdmissionWait
	// for a ready-build permit (P5-S04). It carries retry_after_ms, and the
	// socket closes 1013 right after; the client redials no sooner.
	ErrCodeServerBusy = "SERVER_BUSY"
	// ErrCodeRequestTimeout answers a command whose database work ran past the
	// per-frame deadline (command_deadline.go, WP 4.1b). It means "not
	// applied": the command was cut short before its commit, so a retry is
	// safe. It is not SERVER_BUSY, which the client treats as a refused
	// connect and redials on.
	ErrCodeRequestTimeout = "REQUEST_TIMEOUT"
	// ErrCodeThreadExists answers a thread_create for a message that already
	// has a thread (WP 6.9c). The payload carries thread_id, the existing
	// thread, so the client opens it instead of failing.
	ErrCodeThreadExists = "THREAD_EXISTS"
	// ErrCodeThreadLocked refines FORBIDDEN: the thread is locked and only a
	// moderator (MANAGE_MESSAGES) may post, react, pin or change it.
	ErrCodeThreadLocked = "THREAD_LOCKED"
	// ErrCodeGameActivityDisabled answers an activity_update that sets a game
	// while an admin has turned game activity off for the server (WP 8.3e-2).
	// A clear is never refused. The client claims it without a toast and does
	// not resend until the game changes.
	ErrCodeGameActivityDisabled = "GAME_ACTIVITY_DISABLED"
)
