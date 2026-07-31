package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/coder/websocket"
)

// writePump drains the client's send channels and writes to the WebSocket.
// Priority ordering: high > normal > low. High-priority messages (DMs, mentions)
// are drained first. Normal messages (chat, reactions) come next. Low-priority
// messages (typing, presence) are only sent when no higher-priority work is pending.
func writePump(ctx context.Context, conn *websocket.Conn, c *Client) {
	writeMsg := func(msg []byte) bool {
		wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := conn.Write(wCtx, websocket.MessageText, msg)
		cancel()
		if err != nil {
			slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
			return false
		}
		return true
	}

	for {
		// Priority 1: drain all pending high-priority messages first.
		select {
		case msg, ok := <-c.sendHigh:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
			continue
		default:
		}

		// Priority 2: try high or normal (high still gets priority via the
		// first case in the select, but Go's select is random when both are
		// ready — the outer drain-high loop above ensures high is truly first).
		select {
		case msg, ok := <-c.sendHigh:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.sendLow:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// readPump reads from the WebSocket and dispatches messages. Blocks until disconnect.
func readPump(ctx context.Context, conn *websocket.Conn, hub *Hub, c *Client) {
	var lastReadErr error
	defer func() {
		// The connection is gone, so ctx is (or is about to be) cancelled.
		// Teardown DB writes must still complete — a dead connection must not
		// cancel its own cleanup — so detach cancellation but keep values.
		cleanupCtx := context.WithoutCancel(ctx)
		// Snapshot voice state BEFORE unregister to avoid TOCTOU with replacement connections.
		voiceChID := c.getVoiceChID()
		replaced := hub.unregisterNow(c)
		if c.user != nil {
			// Clean up voice state only when this was the user's final
			// connection. A replacement connection owns the (transferred)
			// voice session, and the join_token guard cannot tell the
			// difference — the transfer keeps the same joined_at — so
			// cleaning here would delete the replacement's DB row whenever
			// teardown snapshots voiceChID before the transfer zeroes it.
			if voiceChID != 0 && !replaced {
				hub.handleVoiceLeave(cleanupCtx, c)
			}
			c.mu.Lock()
			received := c.msgsReceived
			sent := c.msgsSent
			dropped := c.msgsDropped
			c.mu.Unlock()
			duration := time.Since(c.connectedAt)

			attrs := []any{
				"username", c.user.Username,
				"user_id", c.userID,
				"remote", c.remoteAddr,
				"duration_s", int64(duration.Seconds()),
				"msgs_received", received,
				"msgs_sent", sent,
				"msgs_dropped", dropped,
			}
			if voiceChID > 0 {
				attrs = append(attrs, "voice_channel_id", voiceChID)
			}
			if replaced {
				attrs = append(attrs, "replaced", true)
			}
			if lastReadErr != nil {
				attrs = append(attrs, "last_error", lastReadErr.Error())
			}
			slog.Info("websocket disconnected", attrs...)

			if !replaced {
				_ = hub.db.UpdateUserStatus(cleanupCtx, c.userID, "offline")
				hub.BroadcastToAll(buildPresenceMsg(c.userID, "offline"))
			}
		}
	}()

	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			lastReadErr = err
			return
		}
		c.touch()
		hub.handleMessage(c, msg)
	}
}
