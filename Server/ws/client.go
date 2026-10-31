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

// SessionCheckInterval is the number of messages between periodic session-expiry
// checks in readPump. Exported so tests can trigger the check.
const SessionCheckInterval = 10

// Client is a single authenticated WebSocket connection. conn is set by ServeWS and nil in tests.
type Client struct {
	hub       *Hub
	conn      wsConn          // interface — nil in unit tests
	ctx       context.Context // derived from WS upgrade request; cancelled on disconnect
	userID    int64
	user      *db.User
	channelID int64 // currently viewed channel for channel-scoped broadcasts
	// threadID is the second subscription slot (thread_focus): the thread open beside
	// the focused channel, 0 for none, a channel id whose topic is
	// ChannelTopic(threadID). Guarded by mu.
	threadID int64
	// voice is this connection's voice membership (voice_registry.go), guarded by voice.voiceMu.
	voice     voiceSlot
	roleName  string          // cached role name for chat_message broadcasts
	held      *db.MemberRoles // the one held-role read of this handshake (refreshUserSnapshot)
	roleIDs   []int64         // held role ids, top first; set by refreshUserSnapshot before registration
	tokenHash string          // SHA-256 hex of the session token; used for periodic revalidation
	// identityKey is this device's E2EE identity public key from its auth frame ("" if
	// none). Immutable: set in upgradeAndAuth before registerNow publishes the client,
	// so it needs no lock.
	identityKey string
	lastSeq     uint64 // last_seq sent by the client during auth; 0 = fresh connection (e.g. F5 reload)
	// authChannelID is the channel the client says it had open at disconnect, sent
	// with last_seq in the auth frame (0 = none). It closes a resume-only hole:
	// registerNow copies the channel subscription from the old client entry, but when
	// the server already saw the old socket close there is none to copy, so the
	// resumed connection has no ChannelTopic subscription until its post-auth_ok
	// channel_focus completes, and every channel broadcast in that window is
	// unrecoverable (the client reports only max(seq)). UNTRUSTED, like any auth-frame
	// field: handleReconnect and handleFreshConnect promote it to channelID only after
	// checking it against the freshly computed allowed-channel set.
	authChannelID int64
	// features is what the auth frame declared (client_features.go). Set once during
	// the handshake before the client is visible to other goroutines, so no lock.
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

	// focusMu serialises every channel_focus apply (the readPump applier and the
	// deferred-focus drain goroutine) so an older deferred intent never lands after a
	// newer one. Lock order: focusMu before mu.
	focusMu syncutil.Ranked[lockRankSerialiser]
	// focusSeq is bumped on every focus intent, deferred or applied; guarded by mu.
	focusSeq uint64
	// pendingFocusChID is the latest deferred focus intent (0 = none); guarded by mu.
	pendingFocusChID int64
	// pendingFocusRead is the deferred focus's read flag (false = frame said read:false); guarded by mu.
	pendingFocusRead bool
	// pendingFocusReqID is the deferred frame's req_id, echoed on an error; guarded by mu.
	pendingFocusReqID string
	// pendingFocusSeq is the focusSeq assigned to the pending intent; guarded by mu.
	pendingFocusSeq uint64
	// focusDrainActive is true while a drainDeferredFocus goroutine runs; guarded by mu.
	focusDrainActive bool

	// presence is the status and custom status this connection last stamped
	// (applyConnectStatus) or chose (presence_update); nil until the connect stamp.
	// Atomic because presentableMembers and snapshots read it from other goroutines.
	presence atomic.Pointer[livePresence]
	// voiceExitAt is when a moderator action last took a call off this connection
	// (unix nanos, 0 = never; ordinary leaves and moves do not stamp).
	// SendToVoiceDevice uses it to find the device a moderator's voice_moved /
	// voice_disconnected belongs to.
	voiceExitAt atomic.Int64
	// displaced is set when registerNow replaced this connection with a newer one of
	// the same session, which then owns its voice session and presence. A connection
	// removed any other way (kick, stale sweep) is not displaced, so its teardown
	// parks or ends its own call instead of leaving it to the 60 s sweep.
	displaced atomic.Bool
}

// wsConn is the subset of coder/websocket.Conn used by writePump/readPump. An
// interface keeps the core hub logic free of that import in unit tests.
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

// touch updates the last activity time and increments the received counter.
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
	// customStatusExpiresAt is the stored expiry (dbtime.ISOLayout) of customStatus,
	// "" when none. The expirer's CustomStatusExpired compares it: only a connection
	// still showing the expired status is cleared.
	customStatusExpiresAt string
	// idleSince is when status last became "idle" on this connection, zero otherwise.
	// It is kept while the status stays idle (across a custom-status change and its
	// expiry) so the AFK sweep measures one unbroken idle stretch. A reconnect re-stamps it.
	idleSince time.Time
	// setAt is when this connection last chose or stamped its status. A user's status
	// is that of the most recent setter (mergeLivePresence).
	setAt time.Time
	// activity is the game this connection reports, nil when none. Memory only and
	// owned by the connection (a replacement starts without one). Immutable: a change
	// swaps in a new livePresence, so every writer must carry it over.
	activity *gameActivity
	// listening is the song this connection reports; same rules as activity.
	listening *listeningActivity
	// mobile is set only on a merged presence (mergeLivePresence): the shown
	// status comes from a phone-app connection and no desktop connection that is
	// equally active backs it. A connection's own stored value is always false;
	// whether it is a phone is a fact of the socket (Client.features).
	mobile bool
	// selfIdle is whether this connection's own device is idle: set by its own
	// updates (its connect stamp and its own presence_update) and carried over
	// when another device's chosen status is stamped on it. status alone cannot
	// say, since a chosen status overwrites every device's.
	selfIdle bool
}

// noActivity reports whether the connection shows neither a game nor a song.
func (p livePresence) noActivity() bool { return p.activity == nil && p.listening == nil }

// afkNow is the clock the idle stamp and AFK sweep read. A var so tests can move time.
var afkNow = time.Now

// nextLivePresence is the presence that follows prev when the connection takes
// status: it keeps prev.activity and prev.listening, keeps prev.idleSince while the
// status stays idle, stamps now on entry to idle, and is zero for other statuses.
func nextLivePresence(prev *livePresence, status string, customStatus *string, expiresAt string, now time.Time) *livePresence {
	next := &livePresence{status: status, customStatus: customStatus, customStatusExpiresAt: expiresAt, setAt: now, selfIdle: isIdleStatus(status)}
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

// livePresence returns the connection's live presence, zero before the connect stamp.
func (c *Client) livePresence() livePresence {
	if p := c.presence.Load(); p != nil {
		return *p
	}
	return livePresence{}
}

// setLivePresence records the presence this connection just stamped or chose. The
// idle stamp derives from the previous value, so the swap is a compare-and-swap
// loop: two writers (presence_update and the connect stamp) cannot read the same
// prev and drop each other's idleSince.
func (c *Client) setLivePresence(status string, customStatus *string, expiresAt string) {
	now := afkNow()
	for {
		prev := c.presence.Load()
		if c.presence.CompareAndSwap(prev, nextLivePresence(prev, status, customStatus, expiresAt, now)) {
			return
		}
	}
}

// stampChosenStatus records a status another device chose on this connection. It
// is setLivePresence except that this device's own idle fact is kept.
func (c *Client) stampChosenStatus(status string, customStatus *string, expiresAt string) {
	now := afkNow()
	for {
		prev := c.presence.Load()
		next := nextLivePresence(prev, status, customStatus, expiresAt, now)
		if prev != nil {
			next.selfIdle = prev.selfIdle
		}
		if c.presence.CompareAndSwap(prev, next) {
			return
		}
	}
}

// sendMsg queues a normal-priority message. If the buffer is full the client is
// disconnected to force a reconnect with replay recovery instead of silently
// losing messages.
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

// sendPresenceMsg queues a presence frame on the normal queue (the FIFO every
// sequenced frame shares). Unlike sendMsg, a full queue does not close the client:
// in a connect herd every arrival's presence reaches every client, and kicking the
// slow ones only made them rejoin the herd. The frame is dropped and the client
// marked stale; the next presence flush sends a full snapshot and its next resume
// takes the full ready (presenceDropped), so the unseen seq is not lost for good.
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

// sendHighMsg queues a high-priority message (DMs, direct mentions), drained
// before normal and low by writePump. If the high buffer is full it falls back to
// the normal buffer; if both are full the client is disconnected.
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

// sendLowMsg queues a low-priority message (typing, moderation and mention-badge
// notices). If the buffer is full it is dropped and the client is not
// disconnected: these events are ephemeral.
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
		// No disconnect and no per-drop log (typing/presence bursts would flood it); the
		// aggregate counter is the only place these drops are visible.
		if c.hub != nil {
			c.hub.bpLowDrops.Add(1)
		}
	}
}

// trySendMsg queues a normal-priority message, returning false if the buffer is
// full or the channel closed. On overflow the client is disconnected to force a
// reconnect.
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

// closeSend marks all send channels closed, closing them exactly once. Safe from any goroutine.
func (c *Client) closeSend() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeAllSendLocked()
}

// markTerminalKick records that the server ended c's session for good, so its
// teardown ends a voice call at once instead of parking it.
func (c *Client) markTerminalKick() {
	c.mu.Lock()
	c.terminalKick = true
	c.mu.Unlock()
}

func (c *Client) isTerminallyKicked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.terminalKick
}

// isSendClosed reports whether the client's send channels have been closed.
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
