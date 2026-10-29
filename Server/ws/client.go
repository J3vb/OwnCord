package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const (
	sendBufSize     = 256 // per-client outbound send-channel capacity (normal priority)
	sendHighBufSize = 64  // high-priority buffer (DMs, mentions)
	sendLowBufSize  = 64  // low-priority buffer (typing, moderation and mention-badge notices)
)

// SessionCheckInterval is the number of messages processed between periodic
// session-expiry checks in readPump. Exported so tests can trigger the check
// without waiting for a real ticker.
const SessionCheckInterval = 10

// Client represents a single authenticated WebSocket connection.
// The underlying transport (conn) is set by ServeWS; in tests it remains nil.
type Client struct {
	hub       *Hub
	conn      wsConn          // interface — nil in unit tests
	ctx       context.Context // derived from WS upgrade request; cancelled on disconnect
	userID    int64
	user      *db.User
	channelID int64 // currently viewed channel for channel-scoped broadcasts
	// threadID is the second subscription slot (thread_focus): the
	// thread open beside the focused channel, 0 for none. It is a channel id
	// like channelID, so its topic is ChannelTopic(threadID). Guarded by mu.
	threadID int64
	// voice is this connection's voice membership (voice_registry.go):
	// channel, join token, completed flag, E2EE announce and the moderator
	// stash, all guarded by voice.voiceMu.
	voice     voiceSlot
	roleName  string          // cached role name for chat_message broadcasts
	held      *db.MemberRoles // the one held-role read of this handshake (refreshUserSnapshot)
	roleIDs   []int64         // held role ids, top first; set by refreshUserSnapshot before registration
	tokenHash string          // SHA-256 hex of the session token; used for periodic revalidation
	// identityKey is this device's E2EE identity public key from its auth
	// frame ("" when none was sent). Immutable: set once in upgradeAndAuth
	// before registerNow publishes the client, so it needs no lock.
	identityKey string
	lastSeq     uint64 // last_seq sent by the client during auth; 0 = fresh connection (e.g. F5 reload)
	// authChannelID is the channel the client says it had open when it
	// disconnected, sent alongside last_seq in the auth frame (0 = none).
	//
	// It exists to close a resume-only hole: registerNow copies the channel
	// subscription from the OLD client entry, but when the server already
	// observed the previous socket close there is no old entry to copy from,
	// so the resumed connection holds NO ChannelTopic subscription until its
	// post-auth_ok channel_focus round trip completes. Every channel broadcast
	// published in that window reaches nobody on this socket and is
	// unrecoverable afterwards, because the client only ever reports max(seq).
	//
	// UNTRUSTED — it is attacker-controlled like any other auth-frame field.
	// handleReconnect and handleFreshConnect promote it to channelID only after
	// checking it against the freshly computed allowed-channel set.
	authChannelID int64
	// features is what the auth frame declared (client_features.go). Set once
	// during the handshake, before the client is visible to any other
	// goroutine, so no lock guards it.
	features      clientFeatures
	connectedAt   time.Time                     // when the WS connection was established
	remoteAddr    string                        // client IP resolved through trusted_proxies (clientip.Resolve), no port
	msgCount      int                           // count of messages processed; resets after session check
	msgsReceived  int64                         // total messages received over the lifetime of this connection
	msgsSent      int64                         // total messages sent over the lifetime of this connection
	msgsDropped   int64                         // messages dropped due to full send buffer
	invalidCount  int                           // consecutive invalid messages; reset on valid parse
	lastActivity  time.Time                     // last message received from this client; guarded by mu
	lastTouch     time.Time                     // last touchSession write for this socket's session; guarded by mu
	sendClosed    bool                          // true after all send channels have been closed
	terminalKick  bool                          // set by markTerminalKick: the server ended this session for good; guarded by mu
	send          chan []byte                   // normal-priority outbound messages (chat messages, reactions)
	sendHigh      chan []byte                   // high-priority outbound messages (DMs, mentions)
	sendLow       chan []byte                   // low-priority outbound messages (typing, moderation and mention-badge notices) — dropped on overflow
	timeouts      heldTimeouts                  // which member_timeouts list this client holds (member_timeouts_delivery.go)
	presenceStale atomic.Bool                   // a presence frame was dropped; the next presence flush sends a full snapshot
	cseq          cseqState                     // per-socket sequenced-frame count, stamped by the writer (client_cseq.go)
	mu            syncutil.Ranked[lockRankLeaf] // guards sendClosed, msgCount, channelID, lastActivity, msgsReceived, msgsSent, msgsDropped

	// focusMu serialises every channel_focus APPLY (the readPump applier and the
	// deferred-focus drain goroutine), so an older deferred intent can never land
	// after a newer one. Lock order: focusMu before mu.
	focusMu syncutil.Ranked[lockRankSerialiser]
	// focusSeq is bumped on every focus intent, deferred or applied; guarded by mu.
	focusSeq uint64
	// pendingFocusChID is the latest deferred focus intent (0 = none); guarded by mu.
	pendingFocusChID int64
	// pendingFocusRead is the read flag of the deferred focus (false = the frame said read:false); guarded by mu.
	pendingFocusRead bool
	// pendingFocusReqID is the req_id of the deferred frame, echoed on an error; guarded by mu.
	pendingFocusReqID string
	// pendingFocusSeq is the focusSeq the pending intent was assigned; guarded by mu.
	pendingFocusSeq uint64
	// focusDrainActive is true while a drainDeferredFocus goroutine is running; guarded by mu.
	focusDrainActive bool

	// presence is the status and custom status this connection last stamped
	// (applyConnectStatus) or chose (presence_update); nil until the connect
	// stamp. presentableMembers and presence snapshots read it from other
	// goroutines, hence atomic.
	presence atomic.Pointer[livePresence]
	// voiceExitAt is when a moderator action last took a call off this
	// connection (unix nanos, 0 = never; ordinary leaves and moves do not stamp). SendToVoiceDevice uses it to find the device a
	// moderator's voice_moved / voice_disconnected belongs to.
	voiceExitAt atomic.Int64
	// displaced is set when registerNow replaced this connection with a newer
	// one of the same session, which then owns its voice session and presence.
	// A connection removed any other way (a kick, the stale sweep) is not
	// displaced even if its session has since reconnected, so its teardown
	// parks or ends its own call instead of leaving it to the 60 s sweep.
	displaced atomic.Bool
}

// wsConn is the subset of github.com/coder/websocket.Conn used by writePump/readPump.
// Defining it as an interface lets us avoid importing github.com/coder/websocket here,
// keeping the core hub logic free from that dependency during unit tests.
type wsConn any

// newClient creates a real client wrapping a WebSocket connection (set by serve.go).
func newClient(hub *Hub, conn wsConn, user *db.User, tokenHash string, lastSeq uint64, ctx context.Context) *Client {
	now := time.Now()
	return &Client{
		hub:          hub,
		conn:         conn,
		ctx:          ctx,
		userID:       user.ID,
		user:         user,
		tokenHash:    tokenHash,
		lastSeq:      lastSeq,
		connectedAt:  now,
		lastActivity: now,
		send:         make(chan []byte, sendBufSize),
		sendHigh:     make(chan []byte, sendHighBufSize),
		sendLow:      make(chan []byte, sendLowBufSize),
	}
}

// touch updates the last activity timestamp and increments the received counter.
func (c *Client) touch() {
	c.mu.Lock()
	c.lastActivity = time.Now()
	c.msgsReceived++
	c.mu.Unlock()
}

// getLastActivity returns the last activity timestamp under mu.
func (c *Client) getLastActivity() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastActivity
}

// getThreadID returns the thread in the second focus slot under mu.
func (c *Client) getThreadID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.threadID
}

// getChannelID returns the currently focused channel ID under mu.
func (c *Client) getChannelID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channelID
}

// livePresence is a connection's live presence: its status and custom status.
type livePresence struct {
	status       string
	customStatus *string
	// customStatusExpiresAt is the stored expiry (dbtime.ISOLayout)
	// of customStatus, "" when it has none. It is the tag the expirer's
	// CustomStatusExpired compares: only a connection still showing the status
	// that expired is cleared.
	customStatusExpiresAt string
	// idleSince is when status last became "idle" on this connection, the zero
	// time while it is anything else. It is kept while the status
	// stays idle, across a custom-status change and its expiry, so the AFK sweep
	// measures one unbroken idle stretch. A reconnect re-stamps it at connect.
	idleSince time.Time
	// setAt is when this connection last chose or stamped its status. Several
	// connections of one user each hold a presence; the user's is the status of
	// the most recent setter (mergeLivePresence).
	setAt time.Time
	// activity is the game this connection reports, nil when none.
	// It is memory only and belongs to the connection: a replacement connection
	// starts without one. The value is immutable; a change swaps in a new
	// livePresence, so every writer of livePresence must carry it over.
	activity *gameActivity
	// listening is the song this connection reports, nil when none.
	// Same rules as activity: memory only, owned by the connection, immutable,
	// and carried over by every writer of livePresence.
	listening *listeningActivity
}

// noActivity reports whether the connection shows neither a game nor a song.
func (p livePresence) noActivity() bool { return p.activity == nil && p.listening == nil }

// afkNow is the clock the idle stamp and the AFK sweep read. A var so tests
// can move time without sleeping.
var afkNow = time.Now

// nextLivePresence is the presence that follows prev when the connection takes
// status: it keeps prev.activity and prev.listening, and prev.idleSince while the status stays idle and stamps now on
// entry to idle, and leaves it zero for every other status.
func nextLivePresence(prev *livePresence, status string, customStatus *string, expiresAt string, now time.Time) *livePresence {
	next := &livePresence{status: status, customStatus: customStatus, customStatusExpiresAt: expiresAt, setAt: now}
	if prev != nil {
		next.activity = prev.activity
		next.listening = prev.listening
	}
	if !isIdleStatus(status) {
		return next
	}
	next.idleSince = now
	if prev != nil && isIdleStatus(prev.status) && !prev.idleSince.IsZero() {
		next.idleSince = prev.idleSince
	}
	return next
}

// livePresence returns the connection's live presence, a zero value (status
// "") before the connect stamp.
func (c *Client) livePresence() livePresence {
	if p := c.presence.Load(); p != nil {
		return *p
	}
	return livePresence{}
}

// setLivePresence records the presence this connection just stamped or chose.
// The idle stamp is derived from the previous value, so the swap is a
// compare-and-swap loop: two writers (a presence_update and the connect stamp)
// cannot both read the same prev and drop each other's idleSince.
func (c *Client) setLivePresence(status string, customStatus *string, expiresAt string) {
	now := afkNow()
	for {
		prev := c.presence.Load()
		if c.presence.CompareAndSwap(prev, nextLivePresence(prev, status, customStatus, expiresAt, now)) {
			return
		}
	}
}

// sendMsg queues a normal-priority message (chat messages, reactions, channel events).
// If the buffer is full, the client is disconnected to force a reconnect
// with replay recovery instead of silently losing messages.
func (c *Client) sendMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.send <- msg:
		c.msgsSent++
	default:
		c.msgsDropped++
		if c.hub != nil { // hub-less clients exist only in unit tests
			c.hub.bpQueueDisconnects.Add(1)
		}
		slog.Warn("ws: client send buffer full, closing connection to force reconnect",
			"user_id", c.userID)
		c.closeAllSendLocked()
	}
}

// sendPresenceMsg queues a presence frame (presence, presence_batch) on the
// normal queue, the FIFO every sequenced frame shares. Unlike sendMsg, a full
// queue does not close the client: in a connect herd every arrival's presence
// reaches every client, and kicking the slow ones only made them rejoin the
// herd. The frame is dropped and the client marked stale instead; the next
// presence flush sends it a full snapshot, and its next resume takes the full
// ready (presenceDropped), so the seq it never saw is not lost for good.
func (c *Client) sendPresenceMsg(msg []byte) {
	c.mu.Lock()
	if c.sendClosed {
		c.mu.Unlock()
		return
	}
	select {
	case c.send <- msg:
		c.msgsSent++
		c.mu.Unlock()
		return
	default:
		c.msgsDropped++
	}
	c.mu.Unlock()
	c.presenceStale.Store(true)
	if c.hub != nil {
		c.hub.presenceDropped(c.userID, c.tokenHash)
	}
}

// sendHighMsg queues a high-priority message (DMs, direct mentions).
// High-priority messages are drained before normal and low-priority messages
// by writePump. If the high-priority buffer is full, falls back to the normal
// buffer. If both are full, disconnects the client.
func (c *Client) sendHighMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.sendHigh <- msg:
		c.msgsSent++
	default:
		// Fall back to normal priority channel.
		if c.hub != nil {
			c.hub.bpHighFallbacks.Add(1)
		}
		select {
		case c.send <- msg:
			c.msgsSent++
		default:
			c.msgsDropped++
			if c.hub != nil {
				c.hub.bpQueueDisconnects.Add(1)
			}
			slog.Warn("ws: client high+normal buffers full, closing connection",
				"user_id", c.userID)
			c.closeAllSendLocked()
		}
	}
}

// sendLowMsg queues a low-priority message (typing indicators, moderation and mention-badge notices).
// If the buffer is full the message is silently dropped — the client is NOT
// disconnected, since these events are ephemeral and can be safely lost.
func (c *Client) sendLowMsg(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return
	}
	select {
	case c.sendLow <- msg:
		c.msgsSent++
	default:
		c.msgsDropped++
		// Do NOT disconnect — low-priority messages are safely droppable. No
		// per-drop log either (typing/presence bursts would flood it); the
		// aggregate counter is the only place these drops are visible.
		if c.hub != nil {
			c.hub.bpLowDrops.Add(1)
		}
	}
}

// trySendMsg queues a normal-priority message and returns true if it was
// accepted, false if the buffer is full or the channel is closed.
// On buffer overflow, the client is disconnected to force a reconnect.
func (c *Client) trySendMsg(msg []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendClosed {
		return false
	}
	select {
	case c.send <- msg:
		c.msgsSent++
		return true
	default:
		c.msgsDropped++
		if c.hub != nil {
			c.hub.bpQueueDisconnects.Add(1)
		}
		slog.Warn("ws: client send buffer full (trySend), closing connection to force reconnect",
			"user_id", c.userID)
		c.closeAllSendLocked()
		return false
	}
}

// closeSend marks all send channels closed and closes them exactly once.
// Safe to call from any goroutine.
func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeAllSendLocked()
}

// isSendClosed reports whether the client's send channels have been closed.
// markTerminalKick records that the server ended c's session for good, so its
// teardown ends a voice call at once instead of parking it.
func (c *Client) markTerminalKick() {
	c.mu.Lock()
	c.terminalKick = true
	c.mu.Unlock()
}

// isTerminallyKicked reports whether c was marked by markTerminalKick.
func (c *Client) isTerminallyKicked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.terminalKick
}

func (c *Client) isSendClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sendClosed
}

// closeAllSendLocked closes all three send channels. Caller must hold c.mu.
func (c *Client) closeAllSendLocked() {
	if !c.sendClosed {
		c.sendClosed = true
		close(c.send)
		if c.sendHigh != c.send {
			close(c.sendHigh)
		}
		if c.sendLow != c.send && c.sendLow != c.sendHigh {
			close(c.sendLow)
		}
	}
}
