package ws

// serve_ready_admission.go — P5-S04. A restart herd used to run every fresh
// connect's ready build at once and thrash the reader pool; handleFreshConnect
// now takes a permit from Hub.readyGate (2 x GOMAXPROCS slots) first.

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/coder/websocket"
)

// readyAdmissionWait is how long a fresh connect waits for a ready-build
// permit (Hub.readyGate) before it is refused with SERVER_BUSY. A var so
// tests can shorten it.
var readyAdmissionWait = 10 * time.Second

// readyRetryAfter is the upper bound of the retry_after_ms a refused connect
// is given; each refusal draws from [readyRetryAfter/2, readyRetryAfter] so
// the refused herd does not come back as one.
const readyRetryAfter = 5 * time.Second

// admitReady takes a ready-build permit, waiting up to readyAdmissionWait.
// The returned release is idempotent, so a caller can free the permit as
// soon as the build is done and still defer it for the early returns.
func (h *Hub) admitReady(ctx context.Context) (release func(), ok bool) {
	if h.readyGate == nil { // a Hub literal in a test: unbounded
		return func() {}, true
	}
	t := time.NewTimer(readyAdmissionWait)
	defer t.Stop()
	select {
	case h.readyGate <- struct{}{}:
	case <-t.C:
		return nil, false
	case <-ctx.Done():
		return nil, false
	}
	released := false
	return func() {
		if !released {
			released = true
			<-h.readyGate
		}
	}, true
}

// refuseBusy answers a fresh connect that found no ready-build permit in
// time: SERVER_BUSY with a jittered retry_after_ms, then close 1013.
func refuseBusy(ctx context.Context, conn *websocket.Conn, c *Client) {
	retry := readyRetryAfter/2 + rand.N(readyRetryAfter/2+1) //nolint:gosec // G404: retry jitter, nothing here is cryptographic
	slog.Warn("ws: fresh connect refused, ready builds saturated", "user_id", c.userID, "retry_after_ms", retry.Milliseconds())
	_ = handshakeWrite(ctx, conn, buildJSON(map[string]any{
		"type": MsgTypeError,
		"payload": map[string]any{
			"code":           ErrCodeServerBusy,
			"message":        "server busy, retrying shortly",
			"retry_after_ms": retry.Milliseconds(),
		},
	}))
	_ = conn.Close(websocket.StatusTryAgainLater, "server busy")
}

// sendFreshReady writes the ready handleFreshConnect built (or reports its
// build error), outside the admission permit: the write runs at the peer's
// pace, not the database's. owedResync is restored when the ready never
// reaches the client.
func (h *Hub) sendFreshReady(ctx context.Context, conn *websocket.Conn, c *Client, ready *readyPayload, readyErr error, owedResync bool) error {
	if readyErr != nil {
		slog.Error("buildReady failed", "user_id", c.userID, "err", readyErr)
		if owedResync {
			h.setPresenceResync(c.userID, true)
		}
		_ = handshakeWrite(ctx, conn, buildErrorMsg(ErrCodeInternal, "failed to build ready payload"))
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "failed to build ready payload")
		return readyErr
	}
	n, err := h.handshakeWriteReady(ctx, conn, ready)
	if err != nil {
		slog.Warn("ws: failed to send ready payload", "user_id", c.userID, "err", err)
		if owedResync {
			h.setPresenceResync(c.userID, true)
		}
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	slog.Info("ws sent ready payload", "user_id", c.userID, "payload_bytes", n)
	return nil
}
