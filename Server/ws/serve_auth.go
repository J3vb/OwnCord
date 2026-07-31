package ws

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// authenticateConn reads the first WebSocket message and validates the session
// token. Returns the authenticated user and the token hash (for later
// periodic session revalidation).
func authenticateConn(parent context.Context, conn *websocket.Conn, database *db.DB) (*db.User, string, uint64, error) {
	ctx, cancel := context.WithTimeout(parent, authDeadline)
	defer cancel()

	_, raw, err := conn.Read(ctx)
	if err != nil {
		return nil, "", 0, err
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid message"))
		return nil, "", 0, fmt.Errorf("auth: invalid JSON: %w", err)
	}
	if env.Type != "auth" {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("first message must be auth"))
		return nil, "", 0, fmt.Errorf("auth: unexpected type %q", env.Type)
	}

	var p struct {
		Token   string `json:"token"`
		LastSeq uint64 `json:"last_seq"`
	}
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.Token == "" {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("missing token"))
		return nil, "", 0, fmt.Errorf("auth: missing token")
	}

	hash := auth.HashToken(p.Token)
	sess, err := database.GetSessionByTokenHash(ctx, hash)
	if err != nil || sess == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid token"))
		if err != nil {
			// DB outage, not a bad token — carry the cause so the caller's log
			// distinguishes it from an ordinary invalid-token rejection.
			return nil, "", 0, fmt.Errorf("auth: session lookup failed: %w", err)
		}
		return nil, "", 0, fmt.Errorf("auth: invalid session")
	}

	if auth.IsSessionExpired(sess.ExpiresAt) {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("session expired"))
		return nil, "", 0, fmt.Errorf("auth: session expired")
	}

	user, err := database.GetUserByID(ctx, sess.UserID)
	if err != nil || user == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("user not found"))
		if err != nil {
			return nil, "", 0, fmt.Errorf("auth: user lookup failed: %w", err)
		}
		return nil, "", 0, fmt.Errorf("auth: user not found")
	}

	if auth.IsEffectivelyBanned(user) {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeBanned, "you are banned"))
		return nil, "", 0, fmt.Errorf("auth: banned user %d", user.ID)
	}

	return user, hash, p.LastSeq, nil
}
