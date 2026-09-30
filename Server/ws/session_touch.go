package ws

import (
	"context"
	"log/slog"
	"time"
)

// sessionTouchInterval is the minimum time between session touches from one
// socket, matching the REST middleware's throttle: the expiry slides by days,
// so a write a minute per connected session is plenty.
const sessionTouchInterval = 60 * time.Second

// touchSession slides c's session expiry (DP-05) at most once per
// sessionTouchInterval. A long-lived socket may make no REST call for weeks,
// so the handshake and the app-level ping touch the session themselves.
// Non-fatal: a failed write only means the slide waits for the next touch.
// The touch never revives an expired or revoked row (TouchSession's WHERE).
func (h *Hub) touchSession(ctx context.Context, c *Client) {
	if c.tokenHash == "" {
		return
	}
	now := time.Now()
	c.mu.Lock()
	due := now.Sub(c.lastTouch) >= sessionTouchInterval
	if due {
		c.lastTouch = now
	}
	c.mu.Unlock()
	if !due {
		return
	}
	if err := h.authn.TouchSession(ctx, c.tokenHash); err != nil {
		slog.Warn("failed to touch session", "user_id", c.userID, "err", err)
	}
}
