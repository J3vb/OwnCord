package ws

import (
	"context"
	"log/slog"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/syncutil"
)

const (
	sendBufSize     = 256 // per-client outbound send-channel capacity (normal priority)
	sendHighBufSize = 64  // high-priority buffer (DMs, mentions)
	sendLowBufSize  = 64  // low-priority buffer (typing, presence)
)

// SessionCheckInterval is the number of messages processed between periodic
// session-expiry checks in readPump. Exported so tests can trigger the check
// without waiting for a real ticker.
const SessionCheckInterval = 10

// Client represents a single authenticated WebSocket connection.
// The underlying transport (conn) is set by ServeWS; in tests it remains nil.
type Client struct {
	hub            *Hub
	conn           wsConn          // interface — nil in unit tests
	ctx            context.Context // derived from WS upgrade request; cancelled on disconnect
	userID         int64
	user           *db.User
	channelID      int64  // currently viewed channel for channel-scoped broadcasts
	voiceChID      int64  // voice channel the user is in (0 = not in voice); guarded by voiceMu
	voiceJoinToken string // opaque join-instance token for the current voice session; guarded by voiceMu
	// voiceJoinCompleted is true once voiceJoinComplete's supersession guard
	// has passed for the current (voiceChID, voiceJoinToken) pair — i.e. the
	// join actually reached the SFU handoff (token sent, voice topic
	// subscribed, voice_state broadcast). It starts false the moment
	// voiceJoinPersist calls setVoiceState (BUG-088, immediately after the DB
	// row commits but well before completion) and is reset to false by every
	// state change, so it is true only while a real, deliverable membership
	// is live. registerNow reads it (via clearVoiceState) to decide whether a
	// network reconnect's replaced connection had a completed join to hand
	// off, or only a persisted-but-not-yet-delivered one still racing its own
	// supersession guards in voice_join.go — transferring the latter makes
	// those guards misread the transfer as an eviction and abandon the join
	// while its voice_states row stays behind for nothing to reap (OC-0270).
	// Guarded by voiceMu.
	voiceJoinCompleted bool
	e2eePubKey         string // ECDH P-256 public key (base64) for voice E2EE; guarded by voiceMu
	e2eeSignature      string // identity-key signature over e2eePubKey (F3 TOFU); "" for legacy announces; guarded by voiceMu
	// pendingModServerMuted/pendingModServerDeafened stash a moderator-imposed
	// mute/deafen across a server-driven leave (voice_mod_move), which deletes
	// the voice_states row those flags normally live in before the target's
	// own re-join can read them back. Guarded by voiceMu; see
	// setPendingModFlags/takePendingModFlags.
	pendingModServerMuted    bool
	pendingModServerDeafened bool
	roleName                 string // cached role name for chat_message broadcasts
	tokenHash                string // SHA-256 hex of the session token; used for periodic revalidation
	lastSeq                  uint64 // last_seq sent by the client during auth; 0 = fresh connection (e.g. F5 reload)
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
	// handleReconnect promotes it to channelID only after checking it against
	// the freshly computed allowed-channel set, and never on a fresh connect.
	authChannelID int64
	connectedAt   time.Time      // when the WS connection was established
	remoteAddr    string         // client IP:port from the HTTP upgrade request
	msgCount      int            // count of messages processed; resets after session check
	msgsReceived  int64          // total messages received over the lifetime of this connection
	msgsSent      int64          // total messages sent over the lifetime of this connection
	msgsDropped   int64          // messages dropped due to full send buffer
	invalidCount  int            // consecutive invalid messages; reset on valid parse
	lastActivity  time.Time      // last message received from this client; guarded by mu
	sendClosed    bool           // true after all send channels have been closed
	send          chan []byte    // normal-priority outbound messages (chat messages, reactions)
	sendHigh      chan []byte    // high-priority outbound messages (DMs, mentions)
	sendLow       chan []byte    // low-priority outbound messages (typing, presence) — dropped on overflow
	mu            syncutil.Mutex // guards sendClosed, msgCount, channelID, lastActivity, msgsReceived, msgsSent, msgsDropped
	voiceMu       syncutil.Mutex // guards voiceChID and voiceJoinToken
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

// GetTokenHash returns the session token hash stored on this client.
// Exported for tests.
func (c *Client) GetTokenHash() string {
	return c.tokenHash
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

// getChannelID returns the currently focused channel ID under mu.
func (c *Client) getChannelID() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.channelID
}

// getVoiceChID returns the voice channel ID under voiceMu.
func (c *Client) getVoiceChID() int64 {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceChID
}

func (c *Client) getVoiceState() (int64, string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.voiceChID, c.voiceJoinToken
}

func (c *Client) setVoiceState(chID int64, joinToken string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.voiceChID = chID
	c.voiceJoinToken = joinToken
	// A new join instance starts (BUG-088 sets this before the token round
	// trip and completion guard even run); only voiceJoinComplete may mark it
	// done, via markVoiceJoinCompleteIfMatch.
	c.voiceJoinCompleted = false
}

// markVoiceJoinCompleteIfMatch records that the join for (chID, joinToken) has
// passed voiceJoinComplete's supersession guard, but only if the client is
// still in exactly that join instance — re-checked under this same lock
// acquisition so nothing can land between voiceJoinComplete's guard check and
// this call and have it silently mark a superseded/cleared state as done.
// Returns whether it matched and was recorded.
func (c *Client) markVoiceJoinCompleteIfMatch(chID int64, joinToken string) bool {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	if c.voiceChID != chID || c.voiceJoinToken != joinToken {
		return false
	}
	c.voiceJoinCompleted = true
	return true
}

// clearVoiceChID clears the voice channel ID and returns the old value.
func (c *Client) clearVoiceChID() int64 {
	oldChID, _, _ := c.clearVoiceState()
	return oldChID
}

// clearVoiceState clears the client's voice state and returns the old channel
// ID, join token, and whether that join had completed (see
// voiceJoinCompleted) — the last is what registerNow consults before handing
// a resuming connection this state (OC-0270).
func (c *Client) clearVoiceState() (int64, string, bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	oldChID := c.voiceChID
	oldJoinToken := c.voiceJoinToken
	oldCompleted := c.voiceJoinCompleted
	c.voiceChID = 0
	c.voiceJoinToken = ""
	c.voiceJoinCompleted = false
	c.e2eePubKey = ""
	c.e2eeSignature = ""
	return oldChID, oldJoinToken, oldCompleted
}

// clearVoiceStateIfMatch clears the voice state only when the current channel
// is chID, returning the join token and whether it cleared. Delayed evictions
// decided against a snapshotted channel use it so a membership committed after
// the snapshot survives — the in-memory analogue of LeaveVoiceChannelIfMatch.
func (c *Client) clearVoiceStateIfMatch(chID int64) (string, bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	if c.voiceChID != chID {
		return "", false
	}
	oldJoinToken := c.voiceJoinToken
	c.voiceChID = 0
	c.voiceJoinToken = ""
	c.voiceJoinCompleted = false
	c.e2eePubKey = ""
	c.e2eeSignature = ""
	return oldJoinToken, true
}

// setPendingModFlags stashes a moderator-imposed mute/deafen on this client
// before a server-driven leave (voice_mod_move) deletes the voice_states row
// those flags live in. Guarded by voiceMu, the same lock
// clearVoiceStateIfMatch takes for the delete, so the stash can never
// interleave with it. Paired with takePendingModFlags, which the client's own
// subsequent voice_join consults when there is no live row left to read the
// flags back from (currentChID == 0).
func (c *Client) setPendingModFlags(serverMuted, serverDeafened bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.pendingModServerMuted = serverMuted
	c.pendingModServerDeafened = serverDeafened
}

// takePendingModFlags reads and clears the flags stashed by
// setPendingModFlags. Take-and-clear so an ordinary later join — one not
// preceded by a moderator move — is unaffected by a stash nobody consumed.
func (c *Client) takePendingModFlags() (serverMuted, serverDeafened bool) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	serverMuted, serverDeafened = c.pendingModServerMuted, c.pendingModServerDeafened
	c.pendingModServerMuted = false
	c.pendingModServerDeafened = false
	return serverMuted, serverDeafened
}

// setE2EEPubKey stores the ECDH public key for voice E2EE key exchange,
// together with its identity-key signature ("" for legacy announces).
func (c *Client) setE2EEPubKey(key, signature string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	c.e2eePubKey = key
	c.e2eeSignature = signature
}

// getE2EEPubKey returns the stored ECDH public key and its signature.
func (c *Client) getE2EEPubKey() (string, string) {
	c.voiceMu.Lock()
	defer c.voiceMu.Unlock()
	return c.e2eePubKey, c.e2eeSignature
}

// sendMsg queues a normal-priority message (chat messages, reactions, channel events).
// If the buffer is full, the client is disconnected to force a reconnect
// with replay recovery instead of silently losing messages (BUG-124).
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

// sendLowMsg queues a low-priority message (typing indicators, presence updates).
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
// On buffer overflow, the client is disconnected to force a reconnect (BUG-124).
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
