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
// REQUEST_TIMEOUT when the frame deadline fctx cut the work short, otherwise
// with the given error frame. The join itself is not applied; a channel switch
// has already left the previous channel, and the client has been sent that
// voice_leave.
func voiceJoinFail(fctx context.Context, c *Client, reqID string, err error, code, msg string) {
	if commandDeadlineExceeded(fctx, err) {
		slog.Warn("ws command deadline exceeded",
			"user_id", c.userID, "msg_type", MsgTypeVoiceJoin, "req_id", reqID, "err", err)
		c.sendMsg(buildErrorMsgWithID(ErrCodeRequestTimeout, "the server is busy, try again", reqID))
		return
	}
	c.sendMsg(buildErrorMsgWithID(code, msg, reqID))
}

// voiceJoinAbandonOnDeadline removes a membership row the interrupted insert
// may have committed before the driver reported the deadline. The read runs on
// the connection context and deletes only a row naming channelID.
func (h *Hub) voiceJoinAbandonOnDeadline(fctx, ctx context.Context, txn *voiceTxn, c *Client, channelID int64, err error) {
	if commandDeadlineExceeded(fctx, err) {
		h.rollbackVoiceJoin(ctx, txn, c, channelID, "", false)
	}
}
