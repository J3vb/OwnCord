package ws

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// A member may try a channel's password this many times per window. Per member and
// channel, separate from the voice_join rate limit, so a guesser cannot spend the whole
// join budget on one channel and the bcrypt work stays bounded.
const (
	voiceJoinPasswordRateLimit = 5
	voiceJoinPasswordWindow    = time.Minute
)

// Wider budgets: per member across all channels, and server-wide, so guessing is bounded however many
// channels are protected.
const (
	voiceJoinPasswordUserLimit = 10
	voiceJoinPasswordAllLimit  = 60
)

// voiceJoinPasswordAttemptAllowed spends one password attempt from the server-wide budget,
// the member's per-channel budget and the member's cross-channel budget. All three are
// checked before any is charged, so a refused attempt spends nothing from the others; they
// are charged widest first, so a caller losing a check-to-charge race has spent only from
// budgets wider than the one that refused it. Without a limiter every attempt is allowed.
func (h *Hub) voiceJoinPasswordAttemptAllowed(userID, channelID int64) bool {
	if h.limiter == nil {
		return true
	}
	budgets := [...]struct {
		key   string
		limit int
	}{
		{"voice_join_password_all", voiceJoinPasswordAllLimit},
		{auth.Key(auth.Key("voice_join_password", userID), channelID), voiceJoinPasswordRateLimit},
		{auth.Key("voice_join_password_user", userID), voiceJoinPasswordUserLimit},
	}
	for _, b := range budgets {
		if !h.limiter.Check(b.key, b.limit, voiceJoinPasswordWindow) {
			return false
		}
	}
	for _, b := range budgets {
		if !h.limiter.Allow(b.key, b.limit, voiceJoinPasswordWindow) {
			return false
		}
	}
	return true
}

// voiceJoinPasswordGate is the extra lock on a password-protected voice channel
// (permissions.CanPassChannelPassword). It runs only for the user's own voice_join, after
// CanJoinVoice (moderator move, AFK move and token refresh never ask). It reports whether
// the join may go on; when not, the error frame has been sent. A member who entered the
// current password earlier has a stored grant and is let in (a reconnect rejoins this way).
// A sent password is checked against the hash read with its version, and the grant is
// written only if the channel still has that version, so a password changed meanwhile never
// leaves a grant behind.
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

	if !h.voiceJoinPasswordAttemptAllowed(c.userID, channelID) {
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
		// The password changed after the hash was read: the one just checked is no longer the channel's.
		slog.Warn("ws voice_join: channel password changed during the join", "user_id", c.userID, "channel_id", channelID)
		c.sendMsg(buildErrorMsgWithID(ErrCodeWrongPassword, "wrong password", reqID))
		return false
	}
	return true
}

// grantPasswordForMove stores the grant a server-driven move needs: a moderator or AFK move
// evicts the member and tells their client to re-join with an ordinary voice_join, which
// would ask a protected destination for its password. The move never does, so the grant is
// written here for the destination's current password. No password writes nothing.
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

// moveGrantStored stores the grant a moderator move needs for a protected destination and
// reports whether the move may go on; an unprotected one needs none.
func moveGrantStored(ctx context.Context, reader DispatchReader, protected bool, channelID, userID int64) bool {
	if !protected {
		return true
	}
	if err := grantPasswordForMove(ctx, reader, channelID, userID); err != nil {
		slog.Error("ws voice_mod_move: granting the destination password failed", "err", err, "channel_id", channelID)
		return false
	}
	return true
}
