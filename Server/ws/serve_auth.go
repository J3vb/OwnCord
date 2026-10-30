package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/clientip"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// resumeHint carries the client-supplied reconnect hints from the auth frame. Both
// fields are UNTRUSTED: LastSeq only narrows what replay sends, and ChannelID is
// checked against the allowed set before it is honoured (handleReconnect and
// handleFreshConnect).
type resumeHint struct {
	LastSeq   uint64
	ChannelID int64
	// Features is the parsed `features` list of the auth frame. UNTRUSTED; it only
	// narrows what the socket is sent.
	Features clientFeatures
	// IdentityKey is the device identity public key from the auth frame (voice E2EE, key
	// per device), trimmed and validated; "" if none or invalid. It is relayed to peers
	// in this connection's voice announces, which verify it against the announce's own
	// signature.
	IdentityKey string
}

// authenticateConn reads the first WebSocket message and validates the session
// token. Returns the authenticated user, the token hash (for periodic session
// revalidation) and the resume hints.
func (h *Hub) authenticateConn(parent context.Context, conn *websocket.Conn) (*db.User, string, resumeHint, error) {
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
		// ActiveChannelID lets a resuming client re-declare its open channel so the server
		// restores its ChannelTopic subscription during the handshake instead of leaving it
		// unsubscribed until the post-auth_ok channel_focus lands.
		ActiveChannelID int64 `json:"active_channel_id"`
		// Epoch is the wire epoch the client speaks (docs/protocol.md, Compatibility).
		// Absent means 0: clients up to v1.2.0-alpha.4 predate the field.
		Epoch int `json:"epoch"`
		// Wake marks a reconnect after a process suspend. Accepted and ignored: several devices may be signed in at once, so no wake is refused. Optional;
		// absent means an ordinary connect.
		Wake bool `json:"wake"`
		// Features declares optional client capabilities (client_features.go); absent
		// means none (clients from before forums predate it).
		Features []string `json:"features"`
		// IdentityPublicKey is this device's E2EE identity public key (base64). Optional
		// and never fatal: kept raw so a wrongly typed value cannot make the whole frame
		// fail to parse, and validated below.
		IdentityPublicKey json.RawMessage `json:"identity_public_key"`
	}
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.Token == "" {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("missing token"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: missing token")
	}
	if p.Epoch < minClientEpoch || p.Epoch > ProtocolEpoch {
		_ = conn.Write(ctx, websocket.MessageText, buildProtocolEpochError(p.Epoch))
		return nil, "", resumeHint{}, fmt.Errorf("auth: protocol epoch %d outside [%d, %d]", p.Epoch, minClientEpoch, ProtocolEpoch)
	}

	// The session, expiry, user and ban gates are AuthService's
	// (ResolveSocketPrincipal). What stays here is the wire answer: a bad credential
	// gets buildAuthError, NON-RECOVERABLE on the wire (the client stops reconnecting
	// and clears its credentials), while a database failure gets an ordinary error
	// frame so the client's backoff retries. Collapsing the two would log every user
	// out during a blip.
	hash := auth.HashToken(p.Token)
	user, err := h.authn.ResolveSocketPrincipal(ctx, hash)
	switch {
	case errors.Is(err, service.ErrSessionInvalid):
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid token"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: invalid session")
	case errors.Is(err, service.ErrSessionExpired):
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("session expired"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: session expired")
	case errors.Is(err, service.ErrPrincipalGone):
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("user not found"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: user not found")
	case errors.Is(err, service.ErrPrincipalBanned):
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeBanned, "you are banned"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: %w", err) // carries "user N", see ResolveSocketPrincipal
	case err != nil:
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeInternal, "temporary failure, please retry"))
		return nil, "", resumeHint{}, fmt.Errorf("auth: principal resolution failed: %w", err)
	}

	return user, hash, resumeHint{
		LastSeq:     p.LastSeq,
		ChannelID:   p.ActiveChannelID,
		Features:    parseClientFeatures(p.Features),
		IdentityKey: authIdentityKey(user.ID, p.IdentityPublicKey),
	}, nil
}

// sessionIdentityKeyTimeout bounds the session-row write of the device key so a
// busy database writer cannot stall the handshake.
const sessionIdentityKeyTimeout = 2 * time.Second

// recordSessionIdentityKey stores the device key on the session row under its own
// deadline: after the hijack the request context no longer ends on client
// disconnect, so the timeout keeps a busy writer from stalling the handshake.
// Failure is log-only: the key is also held on the Client, and the row is kept only
// for a resumed connection and future device lists.
func (h *Hub) recordSessionIdentityKey(ctx context.Context, userID int64, tokenHash, key string) {
	ctx, cancel := context.WithTimeout(ctx, sessionIdentityKeyTimeout)
	defer cancel()
	if err := h.authn.RecordSessionIdentityKey(ctx, tokenHash, key); err != nil {
		slog.Warn("ws auth: recording the session identity key failed", "user_id", userID, "err", err)
	}
}

// authIdentityKey returns the device identity key an auth frame carried, or "" if
// none or invalid. An invalid key is logged and ignored, never an auth failure: a
// bad key must not lock a device out, and the announce just goes out without one.
func authIdentityKey(userID int64, raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var key string
	if err := json.Unmarshal(raw, &key); err != nil {
		slog.Info("ws auth: identity_public_key ignored, not a string", "user_id", userID)
		return ""
	}
	key = strings.TrimSpace(key)
	if err := service.ValidateIdentityKey(key); err != nil {
		slog.Info("ws auth: identity_public_key ignored, invalid", "user_id", userID, "err", err)
		return ""
	}
	return key
}

// handshakeWrite writes one handshake-phase message (auth_ok, ready, a replay event)
// under writeTimeout. Every handshake write runs against r.Context() from ServeWS;
// websocket.Accept hijacks the connection, which stops net/http cancelling that
// context on client disconnect, so without this a peer that stops reading would
// pin the write, the handler goroutine and the socket forever. writePumpWrite
// bounds its writes the same way.
func handshakeWrite(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(wCtx, websocket.MessageText, msg)
}

// handshakeWriteReady streams the ready frame to conn as one message in frames the
// size of writeReady's buffer, so the roster's shared cached encoding is never
// copied into a per-viewer buffer.
func (h *Hub) handshakeWriteReady(ctx context.Context, conn *websocket.Conn, p *readyPayload) (int64, error) {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	w, err := conn.Writer(wCtx, websocket.MessageText)
	if err != nil {
		return 0, err
	}
	n, err := h.writeReady(w, p)
	if err != nil {
		// No Close: its fin frame would deliver the frames so far as a whole, truncated
		// ready. The caller closes the connection instead.
		return n, err
	}
	return n, w.Close()
}

func (h *Hub) upgradeAndAuth(conn *websocket.Conn, r *http.Request) (*Client, uint64, error) {
	// Resolve the client address through trusted_proxies so handshake logs and the
	// ws_connect audit row name the client, not the reverse proxy.
	clientAddr := clientip.Resolve(r, h.trustedProxyNets)
	user, tokenHash, hint, err := h.authenticateConn(r.Context(), conn)
	if err != nil {
		slog.Warn("ws auth failed", "err", err, "remote", clientAddr)
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return nil, 0, err
	}
	lastSeq := hint.LastSeq

	c := newClient(h, conn, user, tokenHash, lastSeq, r.Context())
	c.remoteAddr = clientAddr
	// Untrusted until handleReconnect checks it against the allowed set.
	c.authChannelID = hint.ChannelID
	// What the client says it can render; forums are withheld without it.
	c.features = hint.Features
	// Voice E2EE key per device: set once before registerNow makes c reachable and
	// never written again, so reading it needs no lock.
	c.identityKey = hint.IdentityKey
	if hint.IdentityKey != "" {
		h.recordSessionIdentityKey(r.Context(), user.ID, tokenHash, hint.IdentityKey)
	}

	// Fail closed like handleFreshConnect's lookup: this value is authoritative on the
	// wire (auth_ok's own role, a new member's presence_batch entry, every
	// chat_message), so a lookup failure must not substitute "member" and pin the
	// session to a fabricated role.
	role, roleErr := h.readers.Visibility.GetRoleByID(r.Context(), user.RoleID)
	if roleErr != nil || role == nil {
		slog.Error("ws: role lookup failed during handshake, closing connection",
			"user_id", user.ID, "role_id", user.RoleID, "err", roleErr)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return nil, 0, fmt.Errorf("upgradeAndAuth: role lookup failed for user %d: %w", user.ID, roleErr)
	}
	c.roleName = strings.ToLower(role.Name)

	slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", clientAddr)
	h.authn.RecordSocketConnect(r.Context(), user.ID, clientAddr)

	return c, lastSeq, nil
}

// unregisterFailedHandshake removes c after a post-registerNow handshake write
// failure. No readPump ever starts for this connection (fresh-connect callers
// return an error before the pumps; handleReconnect's report startPumps=false), and
// the replaced old connection already ran its defer, skipping teardown because
// this client held the slot. So when no replacement remains the standard
// disconnect teardown must run here or the user stays online forever.
func (h *Hub) unregisterFailedHandshake(ctx context.Context, c *Client) {
	// Snapshot voice state before unregister, as readPump's defer does: once
	// unregisterNow removes c there is no telling whether it owned a (possibly
	// just-transferred) voice session.
	txn := h.begin(c.userID)
	voiceChID := c.voice.channel()
	replaced := h.unregisterNow(c)
	if !replaced {
		cleanupCtx := context.WithoutCancel(ctx)
		// A connection that inherited a transferred voice session (the replay-failure
		// fallback in handleFreshConnect keeps the row and registerNow transfers it onto c)
		// must have it parked or torn down here, or the row, LiveKit participant and a
		// stale key-holder entry all survive until the next sweep (up to 60s).
		if voiceChID != 0 {
			h.disconnectVoice(cleanupCtx, txn, c, voiceLeaveReasonHandshake)
		}
	}
	txn.end()
	// shouldMarkOffline re-checks h.clients rather than trusting the `replaced`
	// snapshot, sampled before handleVoiceLeave (can block for seconds), so a reconnect
	// landing meanwhile is not marked offline (as in readPump's defer).
	if h.shouldMarkOffline(c, replaced) {
		cleanupCtx := context.WithoutCancel(ctx)
		_ = h.presence.StampDisconnect(cleanupCtx, c.userID)
		// custom_status is nil, not c.user.CustomStatus (an auth-time snapshot; see
		// readPump's defer). Re-check after the DB write: a device that registered
		// meanwhile queues its own online presence after this point.
		if !h.isConnected(c.userID) {
			h.QueuePresence(c.userID, db.StatusOffline, nil)
		}
	} else if !replaced {
		h.rebroadcastAfterDeviceLeft(c)
	}
}
