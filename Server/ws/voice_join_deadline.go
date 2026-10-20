package ws

import (
	"context"
	"errors"
	"log/slog"
)

// errVoiceJoinUnhealthy marks a LiveKit probe that answered unhealthy without
// an error of its own.
var errVoiceJoinUnhealthy = errors.New("voice join: livekit unhealthy")

// voiceJoinFail answers a join that failed before its commit point: with
// REQUEST_TIMEOUT when the frame deadline fctx cut the work short (nothing was
// applied), otherwise with the given error frame.
func voiceJoinFail(fctx context.Context, c *Client, reqID string, err error, code, msg string) {
	if commandDeadlineExceeded(fctx, err) {
		slog.Warn("ws command deadline exceeded",
			"user_id", c.userID, "msg_type", MsgTypeVoiceJoin, "req_id", reqID, "err", err)
		c.sendMsg(buildErrorMsgWithID(ErrCodeRequestTimeout, "the server is busy, try again", reqID))
		return
	}
	c.sendMsg(buildErrorMsgWithID(code, msg, reqID))
}
