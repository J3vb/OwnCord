package ws

import (
	"context"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// focusDrainInterval is how long the drain goroutine waits between attempts to
// spend a freed focus slot: one slot of the focusRateLimit-per-focusRateWindow
// budget. A package var so tests can shorten it.
var focusDrainInterval = focusRateWindow / focusRateLimit

// applyFocusResult applies a handler's SetChannelID. A channel_focus apply is
// serialised against the deferred drain by focusMu and supersedes any pending
// deferred intent, so a stale deferred focus can never overwrite it.
func (h *Hub) applyFocusResult(c *Client, msgType string, chID int64) {
	c.focusMu.Lock()
	defer c.focusMu.Unlock()
	if msgType == MsgTypeChannelFocus {
		c.mu.Lock()
		c.focusSeq++
		c.pendingFocusChID = 0
		c.mu.Unlock()
	}
	h.applySetChannelID(c, chID)
}

// deferChannelFocus records chID as c's latest focus intent (the budget was
// spent) and makes sure a drain goroutine is running to apply it.
func (h *Hub) deferChannelFocus(c *Client, chID int64, reqID string) {
	c.mu.Lock()
	c.focusSeq++
	c.pendingFocusChID = chID
	c.pendingFocusReqID = reqID
	c.pendingFocusSeq = c.focusSeq
	start := !c.focusDrainActive
	if start {
		c.focusDrainActive = true
	}
	c.mu.Unlock()
	if start {
		go h.drainDeferredFocus(c.ctx, c)
	}
}

// drainDeferredFocus applies c's pending deferred focus once the limiter
// allows. It exits when nothing is pending, the client is gone, or ctx ends.
func (h *Hub) drainDeferredFocus(ctx context.Context, c *Client) {
	for {
		timer := time.NewTimer(focusDrainInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			c.mu.Lock()
			c.focusDrainActive = false
			c.mu.Unlock()
			return
		case <-timer.C:
		}
		if !h.drainFocusOnce(ctx, c) {
			return
		}
	}
}

// drainFocusOnce makes one attempt; false means the goroutine must exit (the
// drain flag has been cleared). The service call runs outside focusMu so a
// readPump focus apply never waits on this attempt's database work; focusMu
// covers only the supersession check and the apply.
func (h *Hub) drainFocusOnce(ctx context.Context, c *Client) bool {
	if c.isSendClosed() || ctx.Err() != nil {
		c.mu.Lock()
		c.focusDrainActive = false
		c.mu.Unlock()
		return false
	}

	c.mu.Lock()
	chID, reqID, seq := c.pendingFocusChID, c.pendingFocusReqID, c.pendingFocusSeq
	if chID == 0 {
		// Cleared under the same c.mu hold as the check, so a concurrent
		// deferral either already set pending (seen above) or sees the flag
		// false and starts a fresh drain.
		c.focusDrainActive = false
		c.mu.Unlock()
		return false
	}
	c.mu.Unlock()

	d := h.focusDeps
	if d.ChannelSvc == nil {
		c.mu.Lock()
		c.pendingFocusChID = 0
		c.focusDrainActive = false
		c.mu.Unlock()
		return false
	}
	if d.Limiter != nil && !d.Limiter.Allow(auth.Key("focus", c.userID), focusRateLimit, focusRateWindow) {
		return true
	}

	_, err := d.ChannelSvc.HandleChannelFocus(ctx, c.userID, chID)
	if err != nil {
		// Forbidden or any other error: drop like the handler, but only if no
		// newer intent replaced this one meanwhile; a replaced intent gets no
		// error frame for a channel the client has already left.
		c.mu.Lock()
		current := c.pendingFocusSeq == seq && c.focusSeq == seq
		if current {
			c.pendingFocusChID = 0
		}
		c.mu.Unlock()
		if current && errors.Is(err, service.ErrForbidden) {
			c.sendMsg(buildErrorMsgWithID(ErrCodeForbidden, "access denied", reqID))
		}
		return true
	}

	c.focusMu.Lock()
	defer c.focusMu.Unlock()
	c.mu.Lock()
	apply := c.pendingFocusSeq == seq && c.focusSeq == seq
	if apply {
		c.pendingFocusChID = 0
	}
	c.mu.Unlock()
	if apply {
		h.applySetChannelID(c, chID)
	}
	return true
}

// supersedeDeferredFocus drops c's pending deferred focus: a newer in-budget
// channel_focus arrived but set no channel (it failed or was refused), and the
// older deferred channel must not land after it.
func supersedeDeferredFocus(c *Client) {
	c.mu.Lock()
	c.focusSeq++
	c.pendingFocusChID = 0
	c.mu.Unlock()
}
