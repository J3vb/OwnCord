package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// A member may try a channel's password this many times per window. The limit
// is per member and channel and separate from the voice_join rate limit, so a
// guesser cannot spend the whole of the join budget on one channel, and the
// bcrypt work stays bounded.
const (
	voiceJoinPasswordRateLimit = 5
	voiceJoinPasswordWindow    = time.Minute
)

// voiceJoinPasswordGate is the extra lock on a password-protected voice
// channel (permissions.CanPassChannelPassword). It runs only for the user's own
// voice_join, after CanJoinVoice: a moderator's move, the AFK move and the
// token refresh never ask for the password. It reports whether the join may
// go on; when not, the error frame has been sent.
//
// A member who entered the current password earlier has a stored grant and is
// let in without sending it again (a reconnect rejoins this way). A password
// that was sent is checked against the hash read together with its version,
// and the grant is written only if the channel still has that version, so a
// password changed meanwhile never leaves a grant behind.
func (h *Hub) voiceJoinPasswordGate(ctx context.Context, c *Client, sub permissions.Subject, channelID int64, protected bool, password, reqID string) bool {
	if permissions.CanPassChannelPassword(sub, protected, false) == nil {
		return true
	}
	granted, err := h.readers.Dispatch.HasChannelPasswordGrant(ctx, channelID, c.userID)
	if err != nil {
		slog.Error("ws voice_join: channel password grant lookup failed, denying", "user_id", c.userID, "channel_id", channelID, "err", err)
		voiceJoinFail(ctx, c, reqID, err, ErrCodeInternal, "password check failed")
		return false
	}
	if permissions.CanPassChannelPassword(sub, true, granted) == nil {
		return true
	}
	if password == "" {
		c.sendMsg(buildErrorMsgWithID(ErrCodePasswordRequired, "this channel needs a password", reqID))
		return false
	}

	key := auth.Key(auth.Key("voice_join_password", c.userID), channelID)
	if h.limiter != nil && !h.limiter.Allow(key, voiceJoinPasswordRateLimit, voiceJoinPasswordWindow) {
		slog.Warn("ws voice_join: channel password attempts rate limited", "user_id", c.userID, "channel_id", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeRateLimited, "too many password attempts", reqID))
		return false
	}

	hash, version, found, err := h.readers.Dispatch.ChannelPasswordState(ctx, channelID)
	if err != nil {
		slog.Error("ws voice_join: channel password lookup failed, denying", "user_id", c.userID, "channel_id", channelID, "err", err)
		voiceJoinFail(ctx, c, reqID, err, ErrCodeInternal, "password check failed")
		return false
	}
	if !found || hash == "" {
		// The password was removed since the channel row was read.
		return true
	}
	if !auth.CheckPassword(hash, password) {
		slog.Warn("ws voice_join: wrong channel password", "user_id", c.userID, "channel_id", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeWrongPassword, "wrong password", reqID))
		return false
	}
	written, err := h.readers.Dispatch.GrantChannelPassword(ctx, channelID, c.userID, version)
	if err != nil {
		slog.Error("ws voice_join: storing the channel password grant failed, denying", "user_id", c.userID, "channel_id", channelID, "err", err)
		voiceJoinFail(ctx, c, reqID, err, ErrCodeInternal, "password check failed")
		return false
	}
	if !written {
		// The password changed after the hash was read: the one just checked
		// is no longer the channel's.
		slog.Warn("ws voice_join: channel password changed during the join", "user_id", c.userID, "channel_id", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeWrongPassword, "wrong password", reqID))
		return false
	}
	return true
}

// grantPasswordForMove stores the grant a server-driven move needs. A moderator
// move and the AFK move evict the member and tell their client to re-join the
// destination with an ordinary voice_join, which would ask a password-protected
// destination for its password; the move itself never does, so the grant is
// written here, for the password the destination has right now. A destination
// without a password writes nothing.
func grantPasswordForMove(ctx context.Context, reader DispatchReader, channelID, userID int64) error {
	hash, version, found, err := reader.ChannelPasswordState(ctx, channelID)
	if err != nil {
		return fmt.Errorf("read channel password state: %w", err)
	}
	if !found || hash == "" {
		return nil
	}
	if _, err := reader.GrantChannelPassword(ctx, channelID, userID, version); err != nil {
		return fmt.Errorf("store channel password grant: %w", err)
	}
	return nil
}
