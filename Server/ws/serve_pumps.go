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
// frame, and a control frame (the Pong answering a Ping, or pingPump's Ping) waits
// for it under a fixed 5s deadline. One large frame on a slow link could hold it up
// to writeTimeout (10s), failing the Pong and readPump's conn.Read, dropping a live
// session. Between fragments the lock is free, so a control frame waits one chunk at most.
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

// writeDeadline bounds each write by a timeout without a context.WithTimeout per
// frame (propagateCancel and Deadline were ~5% of server CPU under load). One
// cancellable context serves the pump; a timer cancels it only while a write is in
// flight, so an idle gap never counts. Cancelling is one-way, so a timer firing as
// a write succeeds would poison the shared context for every later frame; a fired
// timer is observed and reset before the context is reused.
type writeDeadline struct {
	parent  context.Context
	ctx     context.Context
	cancel  context.CancelFunc
	timer   *time.Timer
	timeout time.Duration
	// writeFn is the frame writer; a field so a test can interleave the timer with a write.
	writeFn func(context.Context, *websocket.Conn, []byte) error
}

func newWriteDeadline(parent context.Context, timeout time.Duration) *writeDeadline {
	d := &writeDeadline{parent: parent, timeout: timeout, writeFn: writeFragmented}
	d.reset()
	return d
}

// reset mints a fresh context, cancel and timer. An AfterFunc timer captures the
// cancel it was created with, so a new context needs a new timer; stopping the old
// one leaves at most one armed.
func (d *writeDeadline) reset() {
	if d.timer != nil {
		d.timer.Stop()
	}
	d.ctx, d.cancel = context.WithCancel(d.parent)
	d.timer = time.AfterFunc(d.timeout, d.cancel)
	d.timer.Stop()
}

func (d *writeDeadline) write(conn *websocket.Conn, msg []byte) error {
	if d.ctx.Err() != nil {
		d.reset()
	}
	d.timer.Reset(d.timeout)
	err := d.writeFn(d.ctx, conn, msg)
	if !d.timer.Stop() && err == nil {
		d.reset()
	}
	return err
}

func (d *writeDeadline) stop() {
	d.timer.Stop()
	d.cancel()
}

// writePumpWrite writes one message under writeTimeout; false only when the write
// failed. A failed write closes the connection: it may have left a message
// half-sent, and readPump's teardown must run rather than leave a peer that never
// hears another event.
func writePumpWrite(wd *writeDeadline, conn *websocket.Conn, c *Client, msg []byte) bool {
	if err := wd.write(conn, c.stampCseq(msg)); err != nil {
		slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
		_ = conn.CloseNow()
		return false
	}
	return true
}

// writePumpDrainChannel writes every message still buffered on ch without blocking;
// false only when a write failed (empty or closed is true).
func writePumpDrainChannel(wd *writeDeadline, conn *websocket.Conn, c *Client, ch chan []byte) bool {
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return true
			}
			if !writePumpWrite(wd, conn, c, msg) {
				return false
			}
		default:
			return true
		}
	}
}

// writePumpDrainAndClose flushes whatever the kick paths queued before closing the
// send channels (e.g. the BANNED frame that makes the client clear its
// credentials); returning on the first closed channel would drop those frames.
func writePumpDrainAndClose(wd *writeDeadline, conn *websocket.Conn, c *Client) {
	if writePumpDrainChannel(wd, conn, c, c.sendHigh) && writePumpDrainChannel(wd, conn, c, c.send) {
		writePumpDrainChannel(wd, conn, c, c.sendLow)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")
}

// writePumpDeliver handles one frame from a send channel: a closed channel drains
// and closes the connection, a failed write ends the pump without draining. False
// means writePump must return.
func writePumpDeliver(wd *writeDeadline, conn *websocket.Conn, c *Client, msg []byte, ok bool) bool {
	if !ok {
		writePumpDrainAndClose(wd, conn, c)
		return false
	}
	return writePumpWrite(wd, conn, c, msg)
}

// writePump drains the client's send channels to the WebSocket in priority order
// high > normal > low: DMs and mentions first, then chat and reactions, then
// typing and presence only when nothing higher is pending.
func writePump(ctx context.Context, conn *websocket.Conn, c *Client) {
	wd := newWriteDeadline(ctx, writeTimeout)
	defer wd.stop()
	for {
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
			continue
		default:
		}

		// Try high or normal non-blocking. Go's select among ready cases is uniformly
		// random, so sendLow cannot be a peer here: it would win the coin flip against a
		// pending normal frame about half the time, contradicting low-only-when-idle. Fall
		// through to sendLow only once this default proves neither has anything ready.
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
			continue
		case msg, ok := <-c.send:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
			continue
		default:
		}

		// Nothing high or normal is ready: block on all three (plus shutdown) so an idle
		// connection still gets typing/presence frames without busy-looping.
		select {
		case msg, ok := <-c.sendHigh:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
		case msg, ok := <-c.send:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
		case msg, ok := <-c.sendLow:
			if !writePumpDeliver(wd, conn, c, msg, ok) {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// pingInterval is how often the server sends a protocol Ping and how long it waits
// for the Pong. The peer's stack answers it itself, so liveness does not rest on the
// client's app-level ping (a webview timer a minimised window may throttle). A live
// peer refreshes activity every interval; a silent (half-open) one is closed at
// most 2x pingInterval after going quiet.
var pingInterval = 25 * time.Second

// pingPump sends a protocol Ping every interval until ctx ends. A Pong refreshes
// activity for the stale sweep; a missing Pong closes the connection and readPump's
// teardown takes over. The Pong is read by readPump's conn.Read, so pingPump only
// works alongside it.
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
		// A Pong is liveness, not a received message, so not touch().
		c.mu.Lock()
		c.lastActivity = time.Now()
		c.mu.Unlock()
	}
}

// readPump reads from the WebSocket and dispatches messages; it blocks until disconnect.
func readPump(ctx context.Context, conn *websocket.Conn, hub *Hub, c *Client) {
	var lastReadErr error
	defer func() {
		// The connection is gone so ctx is (or is about to be) cancelled, but teardown DB
		// writes must complete: detach cancellation, keep values.
		cleanupCtx := context.WithoutCancel(ctx)
		// Snapshot voice state before unregister to avoid a TOCTOU with replacement
		// connections. The voice lock spans snapshot to park, so a reconnect's transfer
		// (voiceTxn.inherit) runs wholly before or after this teardown.
		txn := hub.begin(c.userID)
		voiceChID := c.voice.channel()
		replaced := hub.unregisterNow(c)
		// Clean up voice only when this was the user's final connection. A replacement owns
		// the transferred voice session and the join_token guard cannot tell (the transfer
		// keeps the same joined_at), so cleaning here would delete the replacement's row
		// whenever teardown snapshots voiceChID before the transfer zeroes it. A completed
		// membership is parked in the grace window (voice_grace.go) so a resuming socket
		// can inherit the call; disconnectVoice tears down at once for an incomplete join
		// or a disabled window.
		if c.user != nil && voiceChID != 0 && !replaced {
			hub.disconnectVoice(cleanupCtx, txn, c, voiceLeaveReasonDisconnect)
		}
		txn.end()
		if c.user != nil {
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

			// shouldMarkOffline re-checks h.clients instead of trusting `replaced`, which was
			// sampled before handleVoiceLeave (can block for seconds): a reconnect landing in
			// that window would otherwise be invisible and this dead connection's teardown
			// would mark the live user offline.
			if hub.shouldMarkOffline(c, replaced) {
				// A real disconnect is offline for everyone, the user included, so no invisible
				// mapping. The row keeps a chosen status (idle/dnd/invisible) standing, which the
				// next connect reads to avoid stamping the user back online. StampDisconnect clears
				// only the non-choice "online" and refreshes last_seen; the stale-choice problem is
				// handled at read time, where a member with no live connection renders offline.
				_ = hub.presence.StampDisconnect(cleanupCtx, c.userID)
				// custom_status is nil, not c.user.CustomStatus: that is an auth-time snapshot never
				// updated, so broadcasting it would resurrect a status the user changed or cleared
				// (presentableMembers applies the same rule to ready). StampDisconnect is a DB
				// write, so a device may have registered since shouldMarkOffline claimed the
				// offline. Re-check right before the enqueue: that device's online presence is
				// queued after it registers, so skipping here keeps offline from landing last.
				if !hub.isConnected(c.userID) {
					hub.QueuePresence(c.userID, db.StatusOffline, nil)
				}
			} else if !replaced {
				// Another device stays: its presence is now the user's, so the game, song or
				// status this one held must not linger.
				hub.rebroadcastAfterDeviceLeft(c)
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
		hub.handleMessage(c, msg) //nolint:contextcheck // handleMessage derives its per-frame deadline from c.ctx, the same connection context readPump runs on.
	}
}
