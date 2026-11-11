package ws

import (
	"context"
	"errors"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
)

// focusDrainInterval is the wait between attempts to spend a freed focus slot
// (one of focusRateLimit per focusRateWindow); a var so tests can shorten it.
var focusDrainInterval = focusRateWindow / focusRateLimit

// applyFocusResult applies a handler's SetChannelID. It is serialised against the
// deferred drain by focusMu and supersedes any pending deferred intent, so a
// stale deferred focus never overwrites it.
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

func (h *Hub) deferChannelFocus(c *Client, chID int64, reqID string, read bool) {
	c.mu.Lock()
	c.focusSeq++
	c.pendingFocusChID = chID
	c.pendingFocusRead = read
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
// drain flag is cleared). The service call runs outside focusMu so a readPump
// apply never waits on this attempt's database work.
func (h *Hub) drainFocusOnce(ctx context.Context, c *Client) bool {
	if c.isSendClosed() || ctx.Err() != nil {
		c.mu.Lock()
		c.focusDrainActive = false
		c.mu.Unlock()
		return false
	}

	c.mu.Lock()
	chID, reqID, seq := c.pendingFocusChID, c.pendingFocusReqID, c.pendingFocusSeq
	read := c.pendingFocusRead
	if chID == 0 {
		// Cleared under the same c.mu hold as the check, so a concurrent deferral
		// either set pending already or sees false and starts a fresh drain.
		c.focusDrainActive = false
		c.mu.Unlock()
		return false
	}
	c.mu.Unlock()

	d := h.seams.focusDeps
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

	// A deferred read:false focus stays read:false: it subscribes without marking
	// the channel read.
	var err error
	if read {
		_, err = d.ChannelSvc.HandleChannelFocus(ctx, c.userID, chID)
	} else {
		_, err = d.ChannelSvc.AdmitChannelFocus(ctx, c.userID, chID)
	}
	if err != nil {
		// On error, drop like the handler, but only if no newer intent replaced
		// this one; a replaced intent gets no error frame for a channel the
		// client has left.
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
// channel_focus that set no channel (failed or refused) must not be overtaken by
// the older deferred one.
func supersedeDeferredFocus(c *Client) {
	c.mu.Lock()
	c.focusSeq++
	c.pendingFocusChID = 0
	c.mu.Unlock()
}
