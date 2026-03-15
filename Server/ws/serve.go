package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"nhooyr.io/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

const authDeadline = 10 * time.Second
const writeTimeout = 10 * time.Second

// ServeWS upgrades an HTTP connection to WebSocket, performs in-band auth,
// then drives the client's read/write loops.
// Do not wrap with AuthMiddleware — WS does its own auth.
//
// allowedOrigins controls which HTTP origins may open a WebSocket connection.
// Pass nil or []string{"*"} to allow all origins (insecure, for development).
// Pass explicit origins such as []string{"https://example.com"} to restrict access.
func ServeWS(hub *Hub, database *db.DB, allowedOrigins []string) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, acceptOpts)
		if err != nil {
			slog.Warn("ws upgrade failed", "err", err)
			return
		}

		user, tokenHash, err := authenticateConn(conn, database)
		if err != nil {
			slog.Warn("ws auth failed", "err", err, "remote", r.RemoteAddr)
			_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
			return
		}

		c := newClient(hub, conn, user, tokenHash)
		hub.Register(c)

		slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", r.RemoteAddr)
		_ = database.LogAudit(user.ID, "ws_connect", "user", user.ID,
			"WebSocket connected from "+r.RemoteAddr)

		if updateErr := database.UpdateUserStatus(user.ID, "online"); updateErr != nil {
			slog.Warn("ws UpdateUserStatus", "err", updateErr)
		}

		// Send auth_ok followed by the ready payload.
		ctx := r.Context()
		_ = conn.Write(ctx, websocket.MessageText, buildAuthOK(database, user))
		if ready, readyErr := buildReady(database); readyErr == nil {
			_ = conn.Write(ctx, websocket.MessageText, ready)
		}

		hub.BroadcastToAll(buildMemberJoin(user))
		hub.BroadcastToAll(buildPresenceMsg(user.ID, "online"))

		// writePump runs in background; readPump blocks.
		writeCtx, writeCancel := context.WithCancel(ctx)
		go writePump(writeCtx, conn, c)
		readPump(ctx, conn, hub, c)
		writeCancel()
	}
}

// writePump drains the client's send channel and writes to the WebSocket.
func writePump(ctx context.Context, conn *websocket.Conn, c *Client) {
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := conn.Write(wCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// readPump reads from the WebSocket and dispatches messages. Blocks until disconnect.
func readPump(ctx context.Context, conn *websocket.Conn, hub *Hub, c *Client) {
	defer func() {
		hub.Unregister(c)
		hub.handleVoiceLeave(c)
		if c.user != nil {
			slog.Info("websocket disconnected", "username", c.user.Username, "user_id", c.userID)
			_ = hub.db.UpdateUserStatus(c.userID, "offline")
			hub.BroadcastToAll(buildPresenceMsg(c.userID, "offline"))
		}
	}()

	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return
		}
		hub.handleMessage(c, msg)
	}
}

// authenticateConn reads the first WebSocket message and validates the session
// token. Returns the authenticated user and the token hash (for later
// periodic session revalidation).
func authenticateConn(conn *websocket.Conn, database *db.DB) (*db.User, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), authDeadline)
	defer cancel()

	_, raw, err := conn.Read(ctx)
	if err != nil {
		return nil, "", err
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "invalid message"))
		return nil, "", fmt.Errorf("auth: invalid JSON: %w", err)
	}
	if env.Type != "auth" {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "first message must be auth"))
		return nil, "", fmt.Errorf("auth: unexpected type %q", env.Type)
	}

	var p struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.Token == "" {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "missing token"))
		return nil, "", fmt.Errorf("auth: missing token")
	}

	hash := auth.HashToken(p.Token)
	sess, err := database.GetSessionByTokenHash(hash)
	if err != nil || sess == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "invalid token"))
		return nil, "", fmt.Errorf("auth: invalid session")
	}

	if auth.IsSessionExpired(sess.ExpiresAt) {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "session expired"))
		return nil, "", fmt.Errorf("auth: session expired")
	}

	user, err := database.GetUserByID(sess.UserID)
	if err != nil || user == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("AUTH_ERROR", "user not found"))
		return nil, "", fmt.Errorf("auth: user not found")
	}

	if auth.IsEffectivelyBanned(user) {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg("BANNED", "you are banned"))
		return nil, "", fmt.Errorf("auth: banned user %d", user.ID)
	}

	return user, hash, nil
}

// buildAuthOK constructs the auth_ok server→client message.
func buildAuthOK(database *db.DB, user *db.User) []byte {
	serverName := "OwnCord Server"
	motd := "Welcome!"
	_ = database.QueryRow("SELECT value FROM settings WHERE key='server_name'").Scan(&serverName)
	_ = database.QueryRow("SELECT value FROM settings WHERE key='motd'").Scan(&motd)

	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	return buildJSON(map[string]any{
		"type": "auth_ok",
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"status":   user.Status,
			},
			"server_name": serverName,
			"motd":        motd,
		},
	})
}

// buildReady constructs the ready server→client message.
func buildReady(database *db.DB) ([]byte, error) {
	channels, err := database.ListChannels()
	if err != nil {
		return nil, fmt.Errorf("buildReady ListChannels: %w", err)
	}
	roles, err := database.ListRoles()
	if err != nil {
		return nil, fmt.Errorf("buildReady ListRoles: %w", err)
	}

	members, err := database.ListMembers()
	if err != nil {
		slog.Warn("buildReady ListMembers", "err", err)
		members = []db.MemberSummary{}
	}

	// Collect all active voice states across every voice channel.
	voiceStates, err := collectAllVoiceStates(database, channels)
	if err != nil {
		// Non-fatal: send empty list rather than failing the whole ready payload.
		slog.Warn("buildReady collectAllVoiceStates", "err", err)
		voiceStates = []db.VoiceState{}
	}

	return buildJSON(map[string]any{
		"type": "ready",
		"payload": map[string]any{
			"channels":     channels,
			"members":      members,
			"voice_states": voiceStates,
			"roles":        roles,
		},
	}), nil
}

// collectAllVoiceStates gathers voice states for all voice-type channels.
func collectAllVoiceStates(database *db.DB, channels []db.Channel) ([]db.VoiceState, error) {
	var all []db.VoiceState
	for _, ch := range channels {
		if ch.Type != "voice" {
			continue
		}
		states, err := database.GetChannelVoiceStates(ch.ID)
		if err != nil {
			return nil, err
		}
		all = append(all, states...)
	}
	if all == nil {
		all = []db.VoiceState{}
	}
	return all, nil
}
