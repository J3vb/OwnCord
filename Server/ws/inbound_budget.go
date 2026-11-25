package ws

import (
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// Inbound frame budget, per user across every socket of the account (up to
// maxConnectionsPerUser). It sits above the largest single per-type limit (a
// voice key rotation's offers, 64 a second) with room for everything else a
// client sends beside it (speaking, focus, typing, acks), on several devices
// at once.
const (
	inboundFrameLimit  = 600
	inboundFrameWindow = 5 * time.Second
)

// frameStrikeLimit is the count of consecutive strikes (invalid JSON, or a
// frame over the inbound budget) after which the socket is closed. A frame
// that parses into a known command resets it. An unknown type or a payload
// that does not parse is refused and logged but is no strike: an app newer
// than the server may send a frame this server does not know yet.
const frameStrikeLimit = 10

// frameStrikeLogInterval bounds the refused-frame warnings to one per
// connection per interval; the next logged line carries the count skipped.
const frameStrikeLogInterval = 10 * time.Second

// frameStrike names why a frame was refused; each has its own fixed log message.
type frameStrike int

// closes reports whether the kind counts toward frameStrikeLimit.
func (k frameStrike) closes() bool {
	return k == strikeInvalidJSON || k == strikeOverBudget
}

const (
	strikeInvalidJSON frameStrike = iota
	strikeUnknownType
	strikeBadPayload
	strikeOverBudget
)

// allowInboundFrame spends one frame of the user's inbound budget. A frame over
// the budget is answered RATE_LIMITED, counts as a strike and is not decoded.
func (h *Hub) allowInboundFrame(c *Client) bool {
	if h.limiter == nil || h.limiter.Allow(auth.Key("ws_inbound", c.userID), inboundFrameLimit, inboundFrameWindow) {
		return true
	}
	c.sendMsg(buildErrorMsg(ErrCodeRateLimited, "too many messages, slow down"))
	h.strikeFrame(c, strikeOverBudget)
	return false
}

// logFrameStrike writes the warning for one refused frame.
func logFrameStrike(kind frameStrike, args []any) {
	switch kind {
	case strikeInvalidJSON:
		slog.Warn("ws handleMessage invalid JSON", args...)
	case strikeUnknownType:
		slog.Warn("ws handleMessage unknown type", args...)
	case strikeBadPayload:
		slog.Warn("ws command parse error", args...)
	default:
		slog.Warn("ws inbound frame budget exceeded", args...)
	}
}

// strikeFrame records a refused frame against c: it logs at most once per
// frameStrikeLogInterval and, for a kind that counts, closes the socket at
// frameStrikeLimit consecutive strikes. attrs are extra log attributes
// (already capped by the caller).
func (h *Hub) strikeFrame(c *Client, kind frameStrike, attrs ...any) {
	now := time.Now()
	c.mu.Lock()
	if kind.closes() {
		c.invalidCount++
	}
	count := c.invalidCount
	logNow := c.lastStrikeLog.IsZero() || now.Sub(c.lastStrikeLog) >= frameStrikeLogInterval
	skipped := c.skippedStrikeLogs
	if logNow {
		c.lastStrikeLog = now
		c.skippedStrikeLogs = 0
	} else {
		c.skippedStrikeLogs++
	}
	c.mu.Unlock()

	if logNow {
		logFrameStrike(kind, append([]any{"user_id", c.userID, "strikes", count, "skipped_since_last", skipped}, attrs...))
	}
	if kind.closes() && count >= frameStrikeLimit {
		slog.Warn("ws too many invalid messages, closing connection", "user_id", c.userID, "strikes", count)
		h.kickClient(c)
	}
}

// clearFrameStrikes resets the consecutive-strike count after a frame parsed
// into a known command.
func clearFrameStrikes(c *Client) {
	c.mu.Lock()
	c.invalidCount = 0
	c.mu.Unlock()
}
