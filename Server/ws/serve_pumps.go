package ws

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
)

// writeFrameChunk caps the payload of one outbound data frame.
const writeFrameChunk = 16 << 10

// writeFragmented writes msg as one text message in frames of at most
// writeFrameChunk bytes. coder/websocket holds its frame write lock for a whole
// frame, and a control frame — the Pong answering a peer's Ping, or pingPump's
// own Ping — waits for that lock under a fixed 5s deadline. One large frame on
// a slow link could hold it for up to writeTimeout (10s), failing the Pong and
// with it readPump's conn.Read, which drops a live session. Between fragments
// the lock is free, so a control frame waits for one chunk at most.
func writeFragmented(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	if len(msg) <= writeFrameChunk {
		return conn.Write(ctx, websocket.MessageText, msg)
	}
	w, err := conn.Writer(ctx, websocket.MessageText)
	if err != nil {
		return err
	}
	for len(msg) > 0 {
		n := min(len(msg), writeFrameChunk)
		if _, err := w.Write(msg[:n]); err != nil {
			return err
		}
		msg = msg[n:]
	}
	return w.Close()
}

// writePumpWrite writes one message to the WebSocket under writeTimeout.
// Returns false only when the write failed. A failed write closes the
// connection: it may have left a message half-sent, and readPump's teardown
// must run rather than leave a peer that never hears another event.
func writePumpWrite(ctx context.Context, conn *websocket.Conn, c *Client, msg []byte) bool {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	err := writeFragmented(wCtx, conn, msg)
	cancel()
	if err != nil {
		slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
		_ = conn.CloseNow()
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

// pingInterval is how often the server sends a WebSocket protocol Ping, and
// how long it waits for the matching Pong (CLI-01). The peer's WebSocket stack
// answers a protocol Ping itself, so liveness no longer rests on the client's
// app-level ping — a webview timer a minimised window may throttle. A live
// peer refreshes its activity every interval; a silent (half-open) one is
// closed at most 2×pingInterval after it went quiet.
var pingInterval = 25 * time.Second

// pingPump sends a protocol Ping every interval until ctx ends. A Pong
// refreshes the client's activity for the stale sweep; a missing Pong closes
// the connection, and readPump's teardown takes it from there. The Pong is
// read by readPump's conn.Read, so pingPump only works alongside it.
func pingPump(ctx context.Context, conn *websocket.Conn, c *Client, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pingCtx, cancel := context.WithTimeout(ctx, interval)
		err := conn.Ping(pingCtx)
		cancel()
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, net.ErrClosed) {
				slog.Warn("ws closing unresponsive connection (no pong)", "user_id", c.userID, "err", err)
				_ = conn.CloseNow()
			}
			return
		}
		// Not touch(): a Pong is liveness, not a received message.
		c.mu.Lock()
		c.lastActivity = time.Now()
		c.mu.Unlock()
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
			//
			// RT-8: a completed membership is parked in the grace window
			// (voice_grace.go) instead of torn down at once, so a resuming
			// socket can inherit the call. leaveVoiceOnDisconnect runs the
			// immediate teardown for an incomplete join or a disabled window.
			if voiceChID != 0 && !replaced {
				hub.leaveVoiceOnDisconnect(cleanupCtx, c, voiceLeaveReasonDisconnect)
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
				// stamping the user back online. StampDisconnect clears
				// only the non-choice "online" and refreshes last_seen; the
				// stale-choice problem it would otherwise create is handled at
				// read time, where a member with no live connection renders
				// offline no matter what the column says.
				_ = hub.presence.StampDisconnect(cleanupCtx, c.userID)
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
