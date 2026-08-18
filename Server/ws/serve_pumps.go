package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/db"
)

// writePumpWrite writes one frame to the WebSocket under writeTimeout.
// Returns false only when the write failed.
func writePumpWrite(ctx context.Context, conn *websocket.Conn, c *Client, msg []byte) bool {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	err := conn.Write(wCtx, websocket.MessageText, msg)
	cancel()
	if err != nil {
		slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
		return false
	}
	return true
}

// writePumpDrainChannel writes every message still buffered on ch without blocking.
// Returns false only when a write failed; empty or closed is true.
func writePumpDrainChannel(ctx context.Context, conn *websocket.Conn, c *Client, ch chan []byte) bool {
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return true
			}
			if !writePumpWrite(ctx, conn, c, msg) {
				return false
			}
		default:
			return true
		}
	}
}

// writePumpDrainAndClose flushes whatever the kick paths queued before closing the
// send channels (e.g. the BANNED error frame that makes the client clear
// its credentials) — serve.go and hub_broadcast.go both document that
// writePump drains remaining messages after closeSend. Returning on the
// first closed channel would drop those frames.
func writePumpDrainAndClose(ctx context.Context, conn *websocket.Conn, c *Client) {
	if writePumpDrainChannel(ctx, conn, c, c.sendHigh) && writePumpDrainChannel(ctx, conn, c, c.send) {
		writePumpDrainChannel(ctx, conn, c, c.sendLow)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")
}

// writePumpDeliver handles one frame received from a send channel: a closed
// channel drains and closes the connection, a failed write ends the pump
// without draining. Returns false when writePump must return.
func writePumpDeliver(ctx context.Context, conn *websocket.Conn, c *Client, msg []byte, ok bool) bool {
	if !ok {
		writePumpDrainAndClose(ctx, conn, c)
		return false
	}
	return writePumpWrite(ctx, conn, c, msg)
}

// writePump drains the client's send channels and writes to the WebSocket.
// Priority ordering: high > normal > low. High-priority messages (DMs, mentions)
// are drained first. Normal messages (chat, reactions) come next. Low-priority
// messages (typing, presence) are only sent when no higher-priority work is pending.
func writePump(ctx context.Context, conn *websocket.Conn, c *Client) {
	for {
		// Priority 1: drain all pending high-priority messages first.
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
				return
			}
			continue
		default:
		}

		// Priority 2: try high or normal, non-blocking. Go's select among
		// ready cases is uniformly random, so sendLow cannot be a peer here —
		// a case that fires the moment any low-priority frame is queued would
		// let it win the coin flip against a pending normal frame roughly
		// half the time, contradicting "low-priority messages are only sent
		// when no higher-priority work is pending". Only fall through to
		// sendLow (via the blocking select below) once this default proves
		// neither high nor normal has anything ready right now.
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
				return
			}
			continue
		case msg, ok := <-c.send:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
				return
			}
			continue
		default:
		}

		// Priority 3: nothing high or normal is ready — block on all three
		// (plus shutdown) so an idle connection still gets its typing/presence
		// frames instead of busy-looping.
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
				return
			}
		case msg, ok := <-c.send:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
				return
			}
		case msg, ok := <-c.sendLow:
			if !writePumpDeliver(ctx, conn, c, msg, ok) {
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

			// shouldMarkOffline re-checks h.clients instead of trusting
			// `replaced` alone: that flag was sampled before handleVoiceLeave,
			// which can block for seconds, so a reconnect landing during that
			// window would otherwise be invisible here and this dead
			// connection's teardown would mark the live session's user
			// offline (OC-0019).
			if hub.shouldMarkOffline(c, replaced) {
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
				// custom_status is nil, not c.user.CustomStatus: that field is a
				// snapshot taken once at auth (client.go) and never updated, so
				// broadcasting it here would resurrect a status the user changed
				// or cleared mid-session. presentableMembers applies the same
				// rule for a fresh ready payload (serve_ready.go) — a member with
				// no live connection shows no custom status.
				hub.QueuePresence(c.userID, db.StatusOffline, nil)
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
