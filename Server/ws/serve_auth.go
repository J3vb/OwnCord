package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// authenticateConn reads the first WebSocket message and validates the session
// token. Returns the authenticated user and the token hash (for later
// periodic session revalidation).
// resumeHint carries the client-supplied reconnect hints from the auth frame.
// Both fields are UNTRUSTED attacker-controlled input: LastSeq only ever
// narrows what replay will send, and ChannelID is checked against the allowed
// set before it is honoured (see handleReconnect).
type resumeHint struct {
	LastSeq   uint64
	ChannelID int64
}

func authenticateConn(parent context.Context, conn *websocket.Conn, database *db.DB) (*db.User, string, resumeHint, error) {
	ctx, cancel := context.WithTimeout(parent, authDeadline)
	defer cancel()

	_, raw, err := conn.Read(ctx)
	if err != nil {
		return nil, "", resumeHint{}, err
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid message"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: invalid JSON: %w", err)
	}
	if env.Type != MsgTypeAuth {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("first message must be auth"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: unexpected type %q", env.Type)
	}

	var p struct {
		Token   string `json:"token"`
		LastSeq uint64 `json:"last_seq"`
		// ActiveChannelID lets a resuming client re-declare the channel it had
		// open, so the server can restore its ChannelTopic subscription during
		// the handshake instead of leaving it unsubscribed until the
		// post-auth_ok channel_focus round trip lands.
		ActiveChannelID int64 `json:"active_channel_id"`
		// Epoch is the wire epoch the client speaks (docs/protocol.md,
		// Compatibility). Absent means 0: clients up to v1.2.0-alpha.4 predate
		// the field.
		Epoch int `json:"epoch"`
	}
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.Token == "" {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("missing token"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: missing token")
	}
	if p.Epoch < minClientEpoch || p.Epoch > ProtocolEpoch {
		_ = conn.Write(ctx, websocket.MessageText, buildProtocolEpochError(p.Epoch))
		return nil, "", resumeHint{}, fmt.Errorf("auth: protocol epoch %d outside [%d, %d]", p.Epoch, minClientEpoch, ProtocolEpoch)
	}

	hash := auth.HashToken(p.Token)
	sess, err := database.GetSessionByTokenHash(ctx, hash)
	if err != nil {
		// DB outage, not a bad token — send a non-terminal error frame so the
		// client's normal backoff/reconnect logic retries instead of treating
		// this like a genuinely invalid session (buildAuthError is defined as
		// non-recoverable on the wire: the client stops reconnecting and
		// clears its stored credentials on that frame).
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeInternal, "temporary failure, please retry"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: session lookup failed: %w", err)
	}
	if sess == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid token"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: invalid session")
	}

	if auth.IsSessionExpired(sess.ExpiresAt) {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("session expired"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: session expired")
	}

	user, err := database.GetUserByID(ctx, sess.UserID)
	if err != nil {
		// Same DB-outage-vs-bad-credential distinction as above.
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeInternal, "temporary failure, please retry"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: user lookup failed: %w", err)
	}
	if user == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("user not found"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: user not found")
	}

	if auth.IsEffectivelyBanned(user) {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeBanned, "you are banned"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: banned user %d", user.ID)
	}

	return user, hash, resumeHint{LastSeq: p.LastSeq, ChannelID: p.ActiveChannelID}, nil
}

// handshakeWrite writes one handshake-phase message (auth_ok, ready, or a
// replay event) under writeTimeout, instead of the bare ctx every caller here
// otherwise has on hand.
//
// Every handshake write runs against ctx = r.Context() from ServeWS.
// websocket.Accept hijacks the connection, which stops net/http's own
// mechanism for cancelling that context on client disconnect, so without this
// wrapper ctx is never cancelled while the handler is blocked inside
// conn.Write — a peer that stops reading (or whose receive window closes)
// pins the write, the handler goroutine, and the socket forever (OC-0152).
// writePumpWrite (serve_pumps.go) already bounds its writes the same way;
// this brings the handshake writes in serve.go up to the same guarantee.
func handshakeWrite(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(wCtx, websocket.MessageText, msg)
}

func (h *Hub) upgradeAndAuth(
	conn *websocket.Conn, database *db.DB, r *http.Request,
) (*Client, uint64, error) {
	user, tokenHash, hint, err := authenticateConn(r.Context(), conn, database)
	if err != nil {
		slog.Warn("ws auth failed", "err", err, "remote", r.RemoteAddr)
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return nil, 0, err
	}
	lastSeq := hint.LastSeq

	c := newClient(h, conn, user, tokenHash, lastSeq, r.Context())
	c.remoteAddr = r.RemoteAddr
	// Untrusted until handleReconnect checks it against the allowed set.
	c.authChannelID = hint.ChannelID

	// Look up role name for protocol-compliant payloads and cache on client.
	// Fail closed like the sibling lookup in handleFreshConnect (BUG-094):
	// this value is authoritative on the wire — auth_ok reports it as the
	// user's own role, member_join broadcasts it to every other client, and
	// every chat_message carries it — so a lookup failure must not silently
	// substitute "member" and pin the whole session to a fabricated role
	// (OC-0269).
	role, roleErr := database.GetRoleByID(r.Context(), user.RoleID)
	if roleErr != nil || role == nil {
		slog.Error("ws: role lookup failed during handshake, closing connection",
			"user_id", user.ID, "role_id", user.RoleID, "err", roleErr)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return nil, 0, fmt.Errorf("upgradeAndAuth: role lookup failed for user %d: %w", user.ID, roleErr)
	}
	c.roleName = strings.ToLower(role.Name)

	slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", r.RemoteAddr)
	db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "ws_connect", "user", user.ID,
		"WebSocket connected from "+r.RemoteAddr)

	return c, lastSeq, nil
}

// unregisterFailedHandshake removes c after a post-registerNow handshake
// write failure. No readPump ever starts for this connection — the
// fresh-connect callers return an error that stops ServeWS before it starts
// the pumps, and handleReconnect's callers report startPumps=false for the
// same reason (OC-0051) — and the old connection this one replaced already
// ran its defer (skipping teardown because this client held the slot) — so
// when no replacement remains, the standard disconnect teardown must run
// here or the user stays online forever.
func (h *Hub) unregisterFailedHandshake(ctx context.Context, c *Client) {
	// Snapshot voice state BEFORE unregister, mirroring readPump's defer
	// (serve_pumps.go): once unregisterNow removes c, there is no way to tell
	// whether it still owned a (possibly just-transferred) voice session.
	voiceChID := c.getVoiceChID()
	replaced := h.unregisterNow(c)
	if !replaced {
		cleanupCtx := context.WithoutCancel(ctx)
		// A connection that inherited a transferred voice session (the
		// replay-failure fallback in handleFreshConnect deliberately keeps
		// the voice_states row and registerNow transfers it onto c) must have
		// that session torn down here too, or the row, the LiveKit
		// participant, and a stale E2EE key-holder entry all survive this
		// connection's death until the next sweep (up to 60s).
		if voiceChID != 0 {
			h.handleVoiceLeave(cleanupCtx, c)
		}
	}
	// shouldMarkOffline re-checks h.clients rather than trusting the
	// `replaced` snapshot alone: it was sampled before handleVoiceLeave,
	// which can block for seconds, so a reconnect landing during that window
	// would otherwise be invisible here and mark the live session's user
	// offline (OC-0019, mirrored from readPump's defer in serve_pumps.go).
	if h.shouldMarkOffline(c, replaced) {
		cleanupCtx := context.WithoutCancel(ctx)
		_ = h.presence.StampDisconnect(cleanupCtx, c.userID)
		// custom_status is nil, not c.user.CustomStatus: see the identical
		// note in serve_pumps.go's readPump defer — that field is an
		// auth-time snapshot, never updated, so broadcasting it here can
		// resurrect a status the user already changed or cleared.
		h.QueuePresence(c.userID, db.StatusOffline, nil)
	}
}
