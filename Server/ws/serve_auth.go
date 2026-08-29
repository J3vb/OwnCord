package ws

import (
	"context"
	"encoding/json"
	"fmt"

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
