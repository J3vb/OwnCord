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

// resumeHint carries the client-supplied reconnect hints from the auth frame, both UNTRUSTED:
// LastSeq only narrows what replay sends, and ChannelID is checked against the allowed set
// before it is honoured.
type resumeHint struct {
	LastSeq   uint64
	ChannelID int64
	// Features is the parsed `features` list. UNTRUSTED; it only narrows what the socket is sent.
	Features clientFeatures
	// IdentityKey is the validated device identity public key ("" if none or invalid), relayed
	// to peers in this connection's voice announces, which verify it against the announce signature.
	IdentityKey string
}

// authenticateConn reads the first WebSocket message and validates the session token,
// returning the user, the token hash (for periodic revalidation) and the resume hints.
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
		// ActiveChannelID lets a resuming client re-declare its open channel so the ChannelTopic
		// subscription is restored during the handshake, not after the post-auth_ok channel_focus.
		ActiveChannelID int64 `json:"active_channel_id"`
		// Epoch is the wire epoch the client speaks (docs/protocol.md). Absent means 0: clients up to
		// v1.2.0-alpha.4 predate it.
		Epoch int `json:"epoch"`
		// Wake marks a reconnect after a process suspend. Accepted and ignored: several devices may be signed
		// in at once.
		Wake bool `json:"wake"`
		// Features declares optional client capabilities (client_features.go); absent means none.
		Features []string `json:"features"`
		// IdentityPublicKey is this device's E2EE identity public key (base64). Never fatal: kept
		// raw so a wrongly typed value cannot fail the whole frame parse.
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

	// The session, expiry, user and ban gates are AuthService's (ResolveSocketPrincipal). Here
	// only the wire answer: a bad credential gets buildAuthError, NON-RECOVERABLE (the client
	// stops reconnecting and clears credentials); a database failure gets an ordinary error
	// frame so backoff retries. Collapsing them would log every user out during a blip.
	hash := auth.HashToken(p.Token)
	user, err := h.seams.authn.ResolveSocketPrincipal(ctx, hash)
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

// sessionIdentityKeyTimeout bounds the device-key session write so a busy writer cannot stall the handshake.
const sessionIdentityKeyTimeout = 2 * time.Second

// recordSessionIdentityKey stores the device key on the session row under its own deadline
// (after the hijack the request context no longer ends on client disconnect). Failure is
// log-only: the key is also held on the Client; the row serves resumed connections and device lists.
func (h *Hub) recordSessionIdentityKey(ctx context.Context, userID int64, tokenHash, key string) {
	ctx, cancel := context.WithTimeout(ctx, sessionIdentityKeyTimeout)
	defer cancel()
	if err := h.seams.authn.RecordSessionIdentityKey(ctx, tokenHash, key); err != nil {
		slog.Warn("ws auth: recording the session identity key failed", "user_id", userID, "err", err)
	}
}

// authIdentityKey returns the device identity key an auth frame carried, or "" if none or
// invalid. An invalid key is logged and ignored: it must not lock a device out.
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

// handshakeWrite writes one handshake-phase message under writeTimeout. websocket.Accept
// hijacks the connection, so net/http no longer cancels r.Context() on client disconnect;
// without this deadline a peer that stops reading would pin the write, the handler goroutine
// and the socket forever. writePumpWrite bounds its writes the same way.
func handshakeWrite(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(wCtx, websocket.MessageText, msg)
}

// handshakeWriteReady streams ready as one message in writeReady-buffer-sized frames, so the
// shared cached roster encoding is never copied into a per-viewer buffer.
func (h *Hub) handshakeWriteReady(ctx context.Context, conn *websocket.Conn, p *readyPayload) (int64, error) {
	wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	w, err := conn.Writer(wCtx, websocket.MessageText)
	if err != nil {
		return 0, err
	}
	n, err := h.writeReady(w, p)
	if err != nil {
		// No Close: its fin frame would deliver a truncated ready as a whole. The caller closes the
		// connection.
		return n, err
	}
	return n, w.Close()
}

func (h *Hub) upgradeAndAuth(conn *websocket.Conn, r *http.Request) (*Client, uint64, error) {
	// Resolve the client address through trusted_proxies so logs and the ws_connect audit row name the
	// client, not the proxy.
	clientAddr := clientip.Resolve(r, h.seams.trustedProxyNets)
	user, tokenHash, hint, err := h.authenticateConn(r.Context(), conn)
	if err != nil {
		slog.Warn("ws auth failed", "err", err, "remote", clientAddr)
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return nil, 0, err
	}
	lastSeq := hint.LastSeq

	c := newClient(h, conn, user, tokenHash, lastSeq, r.Context())
	c.remoteAddr = clientAddr
	c.authChannelID = hint.ChannelID
	c.features = hint.Features
	// Set once before registerNow makes c reachable and never written again, so reads need no lock.
	c.identityKey = hint.IdentityKey
	if hint.IdentityKey != "" {
		h.recordSessionIdentityKey(r.Context(), user.ID, tokenHash, hint.IdentityKey)
	}

	// Fail closed like handleFreshConnect's lookup: this is authoritative on the wire (auth_ok,
	// presence_batch, every chat_message), so a failure must not substitute "member".
	role, roleErr := h.readers.Visibility.GetRoleByID(r.Context(), user.RoleID)
	if roleErr != nil || role == nil {
		slog.Error("ws: role lookup failed during handshake, closing connection",
			"user_id", user.ID, "role_id", user.RoleID, "err", roleErr)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return nil, 0, fmt.Errorf("upgradeAndAuth: role lookup failed for user %d: %w", user.ID, roleErr)
	}
	c.roleName = strings.ToLower(role.Name)

	slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", clientAddr)
	h.seams.authn.RecordSocketConnect(r.Context(), user.ID, clientAddr)

	return c, lastSeq, nil
}

// unregisterFailedHandshake removes c after a post-registerNow handshake write failure. No
// readPump ever starts for it, and the replaced old connection skipped teardown because
// this client held the slot, so when no replacement remains the standard disconnect
// teardown must run here or the user stays online forever.
func (h *Hub) unregisterFailedHandshake(ctx context.Context, c *Client) {
	// Snapshot voice state before unregister, as readPump's defer does: afterwards there is no
	// telling whether c owned a (possibly transferred) voice session.
	txn := h.begin(c.userID)
	voiceChID := c.voice.channel()
	replaced := h.unregisterNow(c)
	if !replaced {
		cleanupCtx := context.WithoutCancel(ctx)
		// A connection that inherited a transferred voice session (the replay-failure fallback)
		// must have it parked or torn down here, or the row, LiveKit participant and key-holder
		// entry survive until the next sweep (up to 60s).
		if voiceChID != 0 {
			h.disconnectVoice(cleanupCtx, txn, c, voiceLeaveReasonHandshake)
		}
	}
	txn.end()
	// shouldMarkOffline re-checks h.clients rather than the `replaced` snapshot, sampled before
	// handleVoiceLeave (can block for seconds), so a reconnect landing meanwhile is not marked offline.
	if h.shouldMarkOffline(c, replaced) {
		cleanupCtx := context.WithoutCancel(ctx)
		_ = h.presence.StampDisconnect(cleanupCtx, c.userID)
		// custom_status is nil, not the auth-time c.user.CustomStatus (see readPump's defer).
		// Re-check after the DB write: a device that registered meanwhile queues its own online presence.
		if !h.isConnected(c.userID) {
			h.QueuePresence(c.userID, db.StatusOffline, nil)
		}
	} else if !replaced {
		h.rebroadcastAfterDeviceLeft(c)
	}
}
