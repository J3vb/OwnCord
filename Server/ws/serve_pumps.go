package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/db"
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

	// drainChannel writes every message still buffered on ch without blocking.
	// Returns false only when a write failed; empty or closed is true.
	drainChannel := func(ch chan []byte) bool {
		for {
			select {
			case msg, ok := <-ch:
				if !ok {
					return true
				}
				if !writeMsg(msg) {
					return false
				}
			default:
				return true
			}
		}
	}

	// drainAndClose flushes whatever the kick paths queued before closing the
	// send channels (e.g. the BANNED error frame that makes the client clear
	// its credentials) — serve.go and hub_broadcast.go both document that
	// writePump drains remaining messages after closeSend. Returning on the
	// first closed channel would drop those frames.
	drainAndClose := func() {
		if drainChannel(c.sendHigh) && drainChannel(c.send) {
			drainChannel(c.sendLow)
		}
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}

	for {
		// Priority 1: drain all pending high-priority messages first.
		select {
		case msg, ok := <-c.sendHigh:
			if !ok {
				drainAndClose()
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
				drainAndClose()
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.send:
			if !ok {
				drainAndClose()
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.sendLow:
			if !ok {
				drainAndClose()
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
				// A real disconnect is offline for everyone, the user
				// included, so this path needs no invisible mapping. The row,
				// however, keeps a *chosen* status (idle/dnd/invisible)
				// standing — that is what the next connect reads to avoid
				// stamping the user back online. MarkUserDisconnected clears
				// only the non-choice "online" and refreshes last_seen; the
				// stale-choice problem it would otherwise create is handled at
				// read time, where a member with no live connection renders
				// offline no matter what the column says.
				_ = hub.db.MarkUserDisconnected(cleanupCtx, c.userID)
				hub.BroadcastToAll(buildPresenceMsg(c.userID, db.StatusOffline, c.user.CustomStatus))
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
