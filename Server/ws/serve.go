package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"nhooyr.io/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

const (
	authDeadline     = 10 * time.Second
	writeTimeout     = 10 * time.Second
	settingsCacheTTL = 30 * time.Second
)

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
		conn.SetReadLimit(1 << 20) // 1 MB — match client-side limit

		c, lastSeq, err := hub.upgradeAndAuth(conn, database, r)
		if err != nil {
			return
		}

		ctx := r.Context()
		startPumps := func() {
			writeCtx, writeCancel := context.WithCancel(ctx)
			go writePump(writeCtx, conn, c)
			readPump(ctx, conn, hub, c)
			c.closeSend()
			writeCancel()
		}

		// Reconnection with state recovery: if the client sent a last_seq,
		// try to replay missed events from the ring buffer instead of
		// sending a full ready payload.
		if lastSeq > 0 {
			if hub.handleReconnect(ctx, conn, c, database, lastSeq) {
				startPumps()
				return
			}
			// Replay failed (seq too old) — fall through to full ready payload.
			slog.Info("ws replay failed (seq too old), sending full ready", "user_id", c.userID, "last_seq", lastSeq)
		}

		if err := hub.handleFreshConnect(ctx, conn, c, database); err != nil {
			return
		}

		// writePump runs in background; readPump blocks.
		// When readPump returns (disconnect), close the send channel first
		// so writePump drains any remaining messages, then cancel its context.
		startPumps()
	}
}

func (h *Hub) upgradeAndAuth(
	conn *websocket.Conn, database *db.DB, r *http.Request,
) (*Client, uint64, error) {
	user, tokenHash, lastSeq, err := authenticateConn(r.Context(), conn, database)
	if err != nil {
		slog.Warn("ws auth failed", "err", err, "remote", r.RemoteAddr)
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication failed")
		return nil, 0, err
	}

	c := newClient(h, conn, user, tokenHash, lastSeq, r.Context())
	c.remoteAddr = r.RemoteAddr

	// Look up role name for protocol-compliant payloads and cache on client.
	roleName := "member"
	if role, roleErr := database.GetRoleByID(user.RoleID); roleErr == nil && role != nil {
		roleName = strings.ToLower(role.Name)
	}
	c.roleName = roleName

	slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", r.RemoteAddr)
	_ = database.LogAudit(user.ID, "ws_connect", "user", user.ID,
		"WebSocket connected from "+r.RemoteAddr)

	return c, lastSeq, nil
}

func (h *Hub) handleReconnect(
	ctx context.Context, conn *websocket.Conn, c *Client, database *db.DB, lastSeq uint64,
) bool {
	// Compute the set of channel IDs the reconnecting user can access so that
	// channel-scoped replay events are filtered by current permissions (M3).
	allowedChannelIDs, err := h.computeAllowedChannels(database, c.user)
	if err != nil {
		slog.Warn("ws handleReconnect: computeAllowedChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return false
	}

	events := h.ReplayBuffer().EventsSinceFiltered(lastSeq, allowedChannelIDs)
	if events == nil {
		return false
	}

	// Register BEFORE writing replay data so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost (BUG-123). writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	h.registerNow(c)

	// Replay succeeded — send auth_ok then missed events.
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(c.user, c.roleName)); err != nil {
		slog.Warn("ws: failed to send auth_ok (reconnect)", "user_id", c.userID, "err", err)
		h.unregisterNow(c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return true
	}
	for _, evt := range events {
		if err := conn.Write(ctx, websocket.MessageText, evt); err != nil {
			slog.Warn("ws: failed to send replay event", "user_id", c.userID, "err", err)
			h.unregisterNow(c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return true
		}
	}
	slog.Info("ws replay completed", "user_id", c.userID, "events_replayed", len(events), "from_seq", lastSeq)

	// Update presence but skip member_join — user was already known.
	if updateErr := database.UpdateUserStatus(c.userID, "online"); updateErr != nil {
		slog.Warn("ws UpdateUserStatus", "err", updateErr)
	}
	h.BroadcastToAll(buildPresenceMsg(c.userID, "online"))

	return true
}

// computeAllowedChannels returns the set of channel IDs a user may access,
// including both server channels (filtered by ReadMessages permission) and
// the user's open DM channels. This mirrors the buildReady logic so that
// replay-buffer filtering matches the ready payload's visible channels.
func (h *Hub) computeAllowedChannels(database *db.DB, user *db.User) (map[int64]bool, error) {
	channels, err := database.ListChannels()
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels ListChannels: %w", err)
	}

	role, err := database.GetRoleByID(user.RoleID)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetRoleByID: %w", err)
	}

	allowed := make(map[int64]bool)

	// Nil role = zero access (fail closed, same as buildReady).
	if role != nil {
		if permissions.HasAdmin(role.Permissions) {
			// Admin bypasses all channel permission checks.
			for i := range channels {
				if channels[i].Type != "dm" {
					allowed[channels[i].ID] = true
				}
			}
		} else {
			overrides, oErr := database.GetAllChannelPermissionsForRole(role.ID)
			if oErr != nil {
				return nil, fmt.Errorf("computeAllowedChannels GetAllChannelPermissionsForRole: %w", oErr)
			}
			for i := range channels {
				if channels[i].Type == "dm" {
					continue
				}
				o := overrides[channels[i].ID]
				effective := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
				if effective&permissions.ReadMessages == permissions.ReadMessages {
					allowed[channels[i].ID] = true
				}
			}
		}
	}

	// Include the user's open DM channels.
	dmChannels, dmErr := database.GetUserDMChannels(user.ID)
	if dmErr != nil {
		slog.Warn("computeAllowedChannels GetUserDMChannels", "err", dmErr)
		// Non-fatal: DM events will simply be filtered out.
	} else {
		for i := range dmChannels {
			allowed[dmChannels[i].ChannelID] = true
		}
	}

	return allowed, nil
}

func (h *Hub) handleFreshConnect(
	ctx context.Context, conn *websocket.Conn, c *Client, database *db.DB,
) error {
	// Clean stale voice state BEFORE building ready and registering.
	// When a user F5-reloads while in voice, the DB row from the previous
	// session must be removed so the ready payload doesn't include it and
	// other clients see a voice_leave broadcast.
	if vs, err := database.GetVoiceState(c.userID); err == nil && vs != nil {
		slog.Info("ws fresh connect: cleaning stale voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		if _, delErr := database.LeaveVoiceChannelIfMatch(c.userID, vs.ChannelID, vs.JoinedAt); delErr != nil {
			slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
		}
		h.BroadcastToAll(buildVoiceLeave(vs.ChannelID, c.userID))
		if h.livekit != nil {
			// BUG-089: Capture stale join token so the goroutine only removes
			// the exact stale participant. The identity includes joinedAt, so
			// even if the user rejoins voice quickly, the new session has a
			// different identity and won't be removed. Use a hub-stop-aware
			// context to avoid goroutine leaks on shutdown.
			staleChID, staleUserID, staleJoinToken := vs.ChannelID, c.userID, vs.JoinedAt
			go func() {
				select {
				case <-h.stop:
					return
				default:
				}
				if err := h.livekit.RemoveParticipant(staleChID, staleUserID, staleJoinToken); err != nil {
					slog.Warn("ws fresh connect: RemoveParticipant failed (may already be gone)",
						"err", err, "user_id", staleUserID, "channel_id", staleChID)
				}
			}()
		}
	}

	// Look up role for permission-filtered ready payload.
	// Fail closed: if the role lookup fails, disconnect rather than serving
	// a permissive ready payload with nil role (BUG-094).
	userRole, roleErr := database.GetRoleByID(c.user.RoleID)
	if roleErr != nil || userRole == nil {
		slog.Error("ws: role lookup failed, disconnecting", "user_id", c.userID, "role_id", c.user.RoleID, "err", roleErr)
		_ = conn.Close(websocket.StatusInternalError, "role lookup failed")
		return fmt.Errorf("role lookup failed for user %d: %w", c.userID, roleErr)
	}

	// Register BEFORE writing auth_ok + ready so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost (BUG-123). writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	h.registerNow(c)

	// Fresh connection or replay fallback: full auth_ok + ready flow.
	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(c.user, c.roleName)); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterNow(c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	if ready, readyErr := h.buildReady(database, c.userID, userRole); readyErr == nil {
		slog.Info("ws sending ready payload", "user_id", c.userID, "payload_bytes", len(ready))
		if err := conn.Write(ctx, websocket.MessageText, ready); err != nil {
			slog.Warn("ws: failed to send ready payload", "user_id", c.userID, "err", err)
			h.unregisterNow(c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return err
		}
	} else {
		slog.Error("buildReady failed", "user_id", c.userID, "err", readyErr)
		_ = conn.Write(ctx, websocket.MessageText,
			buildErrorMsg(ErrCodeInternal, "failed to build ready payload"))
	}

	if updateErr := database.UpdateUserStatus(c.userID, "online"); updateErr != nil {
		slog.Warn("ws UpdateUserStatus", "err", updateErr)
	}

	slog.Info("ws broadcasting member_join and presence", "user_id", c.userID, "username", c.user.Username)
	h.BroadcastToAll(buildMemberJoin(c.user, c.roleName))
	h.BroadcastToAll(buildPresenceMsg(c.userID, "online"))

	return nil
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
	var lastReadErr error
	defer func() {
		// Snapshot voice state BEFORE unregister to avoid TOCTOU with replacement connections.
		voiceChID := c.getVoiceChID()
		replaced := hub.unregisterNow(c)
		if c.user != nil {
			// Always clean up voice state — LeaveVoiceChannelIfMatch uses a
			// join_token guard so it won't remove a replacement client's session.
			if voiceChID != 0 {
				hub.handleVoiceLeave(ctx, c)
			}
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

			if !replaced {
				_ = hub.db.UpdateUserStatus(c.userID, "offline")
				hub.BroadcastToAll(buildPresenceMsg(c.userID, "offline"))
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
		hub.handleMessage(c, msg)
	}
}

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
	sess, err := database.GetSessionByTokenHash(hash)
	if err != nil || sess == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid token"))
		return nil, "", 0, fmt.Errorf("auth: invalid session")
	}

	if auth.IsSessionExpired(sess.ExpiresAt) {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("session expired"))
		return nil, "", 0, fmt.Errorf("auth: session expired")
	}

	user, err := database.GetUserByID(sess.UserID)
	if err != nil || user == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("user not found"))
		return nil, "", 0, fmt.Errorf("auth: user not found")
	}

	if auth.IsEffectivelyBanned(user) {
		_ = conn.Write(ctx, websocket.MessageText, buildErrorMsg(ErrCodeBanned, "you are banned"))
		return nil, "", 0, fmt.Errorf("auth: banned user %d", user.ID)
	}

	return user, hash, p.LastSeq, nil
}

// buildAuthOK constructs the auth_ok server→client message.
// Per PROTOCOL.md, user object contains only id, username, avatar, role (no status).
func (h *Hub) buildAuthOK(user *db.User, roleName string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	serverName, motd := h.getCachedSettings()

	return buildJSON(map[string]any{
		"type": MsgTypeAuthOK,
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"role":     roleName,
			},
			"server_name": serverName,
			"motd":        motd,
		},
	})
}

// buildReady constructs the ready server→client message.
// Per PROTOCOL.md, channels include unread_count and last_message_id per user,
// and only protocol-specified fields (no slow_mode, archived, voice_* extras).
func (h *Hub) buildReady(database *db.DB, userID int64, role *db.Role) ([]byte, error) {
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

	// Filter channels by READ_MESSAGES permission (mirrors REST handleListChannels).
	overrides := map[int64]db.ChannelOverride{}
	if role != nil && !permissions.HasAdmin(role.Permissions) {
		var oErr error
		overrides, oErr = database.GetAllChannelPermissionsForRole(role.ID)
		if oErr != nil {
			return nil, fmt.Errorf("buildReady GetAllChannelPermissionsForRole: %w", oErr)
		}
	}
	var visibleChannels []db.Channel
	for i := range channels {
		// DM channels are excluded — they are delivered via dm_channels field.
		if channels[i].Type == "dm" {
			continue
		}
		// Nil role = zero access (fail closed). Admin role bypasses all checks.
		if role == nil {
			continue
		}
		if permissions.HasAdmin(role.Permissions) {
			visibleChannels = append(visibleChannels, channels[i])
			continue
		}
		o := overrides[channels[i].ID]
		effective := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
		if effective&permissions.ReadMessages == permissions.ReadMessages {
			visibleChannels = append(visibleChannels, channels[i])
		}
	}
	if visibleChannels == nil {
		visibleChannels = []db.Channel{}
	}

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(userID)
	if err != nil {
		slog.Warn("buildReady GetChannelUnreadCounts", "err", err)
		unreadMap = map[int64]db.ChannelUnread{}
	}

	// Build protocol-compliant channel objects (strip extra fields).
	channelPayloads := make([]map[string]any, 0, len(visibleChannels))
	for i := range visibleChannels {
		entry := map[string]any{
			"id":       visibleChannels[i].ID,
			"name":     visibleChannels[i].Name,
			"type":     visibleChannels[i].Type,
			"category": visibleChannels[i].Category,
			"position": visibleChannels[i].Position,
		}
		if visibleChannels[i].Type == "text" {
			if u, ok := unreadMap[visibleChannels[i].ID]; ok {
				entry["unread_count"] = u.UnreadCount
				entry["last_message_id"] = u.LastMessageID
			} else {
				entry["unread_count"] = 0
				entry["last_message_id"] = 0
			}
		}
		channelPayloads = append(channelPayloads, entry)
	}

	// Collect voice states, filtered to only visible channels (BUG-095).
	allVoiceStates, err := collectAllVoiceStates(database, channels)
	if err != nil {
		// Non-fatal: send empty list rather than failing the whole ready payload.
		slog.Warn("buildReady collectAllVoiceStates", "err", err)
		allVoiceStates = []db.VoiceState{}
	}
	visibleSet := make(map[int64]struct{}, len(visibleChannels))
	for i := range visibleChannels {
		visibleSet[visibleChannels[i].ID] = struct{}{}
	}
	voiceStates := make([]db.VoiceState, 0, len(allVoiceStates))
	for i := range allVoiceStates {
		if _, ok := visibleSet[allVoiceStates[i].ChannelID]; ok {
			voiceStates = append(voiceStates, allVoiceStates[i])
		}
	}

	// Load open DM channels for this user.
	dmChannels, err := database.GetUserDMChannels(userID)
	if err != nil {
		slog.Warn("buildReady GetUserDMChannels", "err", err)
		dmChannels = []db.DMChannelInfo{}
	}

	serverName, motd := h.getCachedSettings()

	return buildJSON(map[string]any{
		"type": MsgTypeReady,
		"payload": map[string]any{
			"channels":     channelPayloads,
			"members":      members,
			"voice_states": voiceStates,
			"roles":        roles,
			"dm_channels":  dmChannels,
			"server_name":  serverName,
			"motd":         motd,
		},
	}), nil
}

// collectAllVoiceStates gathers voice states across all channels in a single
// query, replacing the previous N+1 per-channel pattern.
func collectAllVoiceStates(database *db.DB, _ []db.Channel) ([]db.VoiceState, error) {
	return database.GetAllVoiceStates()
}
