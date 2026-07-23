package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/telemetry"
)

const (
	authDeadline     = 10 * time.Second
	writeTimeout     = 10 * time.Second
	settingsCacheTTL = 30 * time.Second

	// wsReadLimitBytes is the maximum size of a single inbound WebSocket
	// message. Must match the client-side upload cap.
	wsReadLimitBytes = config.MaxMessageBytes
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
		conn.SetReadLimit(wsReadLimitBytes) // match client-side upload cap

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
	if role, roleErr := database.GetRoleByID(r.Context(), user.RoleID); roleErr == nil && role != nil {
		roleName = strings.ToLower(role.Name)
	}
	c.roleName = roleName

	slog.Info("websocket connected", "username", user.Username, "user_id", user.ID, "remote", r.RemoteAddr)
	db.WriteAudit(context.WithoutCancel(r.Context()), database, user.ID, "ws_connect", "user", user.ID,
		"WebSocket connected from "+r.RemoteAddr)

	return c, lastSeq, nil
}

func (h *Hub) handleReconnect(
	ctx context.Context, conn *websocket.Conn, c *Client, database *db.DB, lastSeq uint64,
) bool {
	// Channel-visibility changes are delivered as targeted, unsequenced
	// messages, so replay cannot bring a client that missed one back into a
	// coherent state — force the full-ready path instead.
	if h.mustFullResync(lastSeq) {
		slog.Info("ws replay skipped (visibility changed since last_seq), sending full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return false
	}
	// Compute the set of channel IDs the reconnecting user can access so that
	// channel-scoped replay events are filtered by current permissions (M3).
	allowedChannelIDs, err := h.computeAllowedChannels(ctx, database, c.user)
	if err != nil {
		slog.Warn("ws handleReconnect: computeAllowedChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return false
	}

	events := h.ReplayBuffer().EventsSinceFiltered(lastSeq, allowedChannelIDs)
	replaySource := "buffer"
	if events == nil {
		// Phase B Step 7 — try cold-tier replay from the EventStore before
		// giving up and forcing a full ready re-sync.
		if esp := h.eventStore.Load(); esp != nil {
			es := *esp
			channelIDs := make([]int64, 0, len(allowedChannelIDs))
			for cid := range allowedChannelIDs {
				channelIDs = append(channelIDs, cid)
			}
			const maxColdReplay = 5000
			persisted, dbErr := es.GetEventsSinceForChannels(ctx, int64(lastSeq), channelIDs, maxColdReplay) //nolint:gosec // lastSeq is a sequence counter bounded well below MaxInt64
			if dbErr != nil {
				slog.Warn("ws handleReconnect: cold-tier replay query failed",
					"user_id", c.userID, "err", dbErr)
			} else if len(persisted) > 0 {
				events = make([][]byte, 0, len(persisted))
				for _, p := range persisted {
					events = append(events, p.Payload)
				}
				replaySource = "db"
			}
		}
		if events == nil {
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return false
		}
	}
	switch replaySource {
	case "buffer":
		h.reconnectTierBuf.Add(1)
	case "db":
		h.reconnectTierDB.Add(1)
	}
	telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", replaySource))

	// Register BEFORE writing replay data so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost (BUG-123). writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	h.registerNow(c)

	// Replay succeeded — send auth_ok then missed events. The replay tier
	// is included in the payload so the client can attribute reconnect
	// behaviour without separate metric scraping.
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName, "replay_source", replaySource)
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(ctx, c.user, c.roleName, replaySource)); err != nil {
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
	slog.Info("ws replay completed", "user_id", c.userID, "events_replayed", len(events), "from_seq", lastSeq, "source", replaySource)

	// Update presence but skip member_join — user was already known.
	if updateErr := database.UpdateUserStatus(ctx, c.userID, "online"); updateErr != nil {
		slog.Warn("ws UpdateUserStatus", "err", updateErr)
	}
	h.BroadcastToAll(buildPresenceMsg(c.userID, "online"))

	return true
}

// computeAllowedChannels returns the set of channel IDs a user may access,
// including both server channels (filtered by ReadMessages permission) and
// the user's open DM channels. The server-channel set comes from the single
// permissions.Checker predicate shared with buildReady and REST
// ListVisibleChannels, so replay-buffer filtering can never drift from the
// ready payload's visible channels.
func (h *Hub) computeAllowedChannels(ctx context.Context, database *db.DB, user *db.User) (map[int64]bool, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels ListChannels: %w", err)
	}

	role, err := database.GetRoleByID(ctx, user.RoleID)
	if err != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetRoleByID: %w", err)
	}

	// Nil role = zero access (fail closed). Admins skip the override fetch.
	allowed := make(map[int64]bool)
	if role != nil {
		var overrides map[int64]db.ChannelOverride
		if !permissions.HasAdmin(role.Permissions) {
			overrides, err = database.GetAllChannelPermissionsForRole(ctx, role.ID)
			if err != nil {
				return nil, fmt.Errorf("computeAllowedChannels GetAllChannelPermissionsForRole: %w", err)
			}
		}
		allowed = h.permChecker.VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
	}

	// Include the user's open DM channels.
	dmChannels, dmErr := database.GetUserDMChannels(ctx, user.ID)
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
	if vs, err := database.GetVoiceState(ctx, c.userID); err == nil && vs != nil {
		slog.Info("ws fresh connect: cleaning stale voice state",
			"user_id", c.userID, "channel_id", vs.ChannelID)
		if _, delErr := database.LeaveVoiceChannelIfMatch(ctx, c.userID, vs.ChannelID, vs.JoinedAt); delErr != nil {
			slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
		}
		h.BroadcastToAll(buildVoiceLeave(vs.ChannelID, c.userID))
		if h.livekit != nil {
			// BUG-089: Capture stale join token so the goroutine only removes
			// the exact stale participant. The identity includes joinedAt, so
			// even if the user rejoins voice quickly, the new session has a
			// different identity and won't be removed. The removal must
			// complete even if this connection drops mid-handshake, so detach
			// from cancellation (values kept); shutdown is handled via h.stop.
			staleChID, staleUserID, staleJoinToken := vs.ChannelID, c.userID, vs.JoinedAt
			lkCtx := context.WithoutCancel(ctx)
			go func() {
				select {
				case <-h.stop:
					return
				default:
				}
				if err := h.livekit.RemoveParticipant(lkCtx, staleChID, staleUserID, staleJoinToken); err != nil {
					slog.Warn("ws fresh connect: RemoveParticipant failed (may already be gone)",
						"err", err, "user_id", staleUserID, "channel_id", staleChID)
				}
			}()
		}
	}

	// Look up role for permission-filtered ready payload.
	// Fail closed: if the role lookup fails, disconnect rather than serving
	// a permissive ready payload with nil role (BUG-094).
	userRole, roleErr := database.GetRoleByID(ctx, c.user.RoleID)
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
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(ctx, c.user, c.roleName, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterNow(c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	if ready, readyErr := h.buildReady(ctx, database, c.userID, userRole); readyErr == nil {
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
		h.unregisterNow(c)
		_ = conn.Close(websocket.StatusInternalError, "failed to build ready payload")
		return readyErr
	}

	if updateErr := database.UpdateUserStatus(ctx, c.userID, "online"); updateErr != nil {
		slog.Warn("ws UpdateUserStatus", "err", updateErr)
	}

	slog.Info("ws broadcasting member_join and presence", "user_id", c.userID, "username", c.user.Username)
	h.BroadcastToAll(buildMemberJoin(c.user, c.roleName))
	h.BroadcastToAll(buildPresenceMsg(c.userID, "online"))

	return nil
}

// writePump drains the client's send channels and writes to the WebSocket.
// Priority ordering: high > normal > low. High-priority messages (DMs, mentions)
// are drained first. Normal messages (chat, reactions) come next. Low-priority
// messages (typing, presence) are only sent when no higher-priority work is pending.
func writePump(ctx context.Context, conn *websocket.Conn, c *Client) {
	writeMsg := func(msg []byte) bool {
		wCtx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := conn.Write(wCtx, websocket.MessageText, msg)
		cancel()
		if err != nil {
			slog.Warn("ws writePump error", "user_id", c.userID, "err", err)
			return false
		}
		return true
	}

	for {
		// Priority 1: drain all pending high-priority messages first.
		select {
		case msg, ok := <-c.sendHigh:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
			continue
		default:
		}

		// Priority 2: try high or normal (high still gets priority via the
		// first case in the select, but Go's select is random when both are
		// ready — the outer drain-high loop above ensures high is truly first).
		select {
		case msg, ok := <-c.sendHigh:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.send:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
				return
			}
		case msg, ok := <-c.sendLow:
			if !ok {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			if !writeMsg(msg) {
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
		// The connection is gone, so ctx is (or is about to be) cancelled.
		// Teardown DB writes must still complete — a dead connection must not
		// cancel its own cleanup — so detach cancellation but keep values.
		cleanupCtx := context.WithoutCancel(ctx)
		// Snapshot voice state BEFORE unregister to avoid TOCTOU with replacement connections.
		voiceChID := c.getVoiceChID()
		replaced := hub.unregisterNow(c)
		if c.user != nil {
			// Clean up voice state only when this was the user's final
			// connection. A replacement connection owns the (transferred)
			// voice session, and the join_token guard cannot tell the
			// difference — the transfer keeps the same joined_at — so
			// cleaning here would delete the replacement's DB row whenever
			// teardown snapshots voiceChID before the transfer zeroes it.
			if voiceChID != 0 && !replaced {
				hub.handleVoiceLeave(cleanupCtx, c)
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
				_ = hub.db.UpdateUserStatus(cleanupCtx, c.userID, "offline")
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
	sess, err := database.GetSessionByTokenHash(ctx, hash)
	if err != nil || sess == nil {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("invalid token"))
		return nil, "", 0, fmt.Errorf("auth: invalid session")
	}

	if auth.IsSessionExpired(sess.ExpiresAt) {
		_ = conn.Write(ctx, websocket.MessageText, buildAuthError("session expired"))
		return nil, "", 0, fmt.Errorf("auth: session expired")
	}

	user, err := database.GetUserByID(ctx, sess.UserID)
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
//
// replaySource records which reconnection tier served this client:
//   - "none"   — fresh connection or full re-sync (no resume)
//   - "buffer" — resume served from the in-memory ring buffer
//   - "db"     — resume served from the persistent EventStore (Phase B Step 7)
func (h *Hub) buildAuthOK(ctx context.Context, user *db.User, roleName string, replaySource string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}

	serverName, motd := h.getCachedSettings(ctx)

	return buildJSON(map[string]any{
		"type": MsgTypeAuthOK,
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"role":     roleName,
			},
			"server_name":   serverName,
			"motd":          motd,
			"replay_source": replaySource,
		},
	})
}

// channelRefs maps db channels to the checker's db-agnostic ChannelRef so
// buildReady and computeAllowedChannels can share permissions.VisibleChannelIDs.
func channelRefs(channels []db.Channel) []permissions.ChannelRef {
	refs := make([]permissions.ChannelRef, len(channels))
	for i := range channels {
		refs[i] = permissions.ChannelRef{ID: channels[i].ID, Type: channels[i].Type}
	}
	return refs
}

// permOverrides maps a db override map to the checker's override map.
func permOverrides(overrides map[int64]db.ChannelOverride) map[int64]permissions.ChannelOverride {
	out := make(map[int64]permissions.ChannelOverride, len(overrides))
	for id, o := range overrides {
		out[id] = permissions.ChannelOverride{Allow: o.Allow, Deny: o.Deny}
	}
	return out
}

// channelCanSend reports whether a user with the given role and per-channel
// override may post in a channel of chanType. It mirrors the non-DM branch of
// MessageService.checkSendPermission so the client can pre-disable the composer
// without a round-trip; the server still enforces the rule authoritatively.
func channelCanSend(role *db.Role, o db.ChannelOverride, chanType string) bool {
	if role == nil {
		return false
	}
	if permissions.HasAdmin(role.Permissions) {
		return true
	}
	eff := permissions.EffectivePerms(role.Permissions, o.Allow, o.Deny)
	need := permissions.ReadMessages | permissions.SendMessages
	if eff&need != need {
		return false
	}
	if chanType == "announcement" {
		return eff&permissions.ManageMessages == permissions.ManageMessages
	}
	return true
}

// buildReady constructs the ready server→client message.
// Per PROTOCOL.md, channels include unread_count and last_message_id per user,
// and only protocol-specified fields (no slow_mode, archived, voice_* extras).
func (h *Hub) buildReady(ctx context.Context, database *db.DB, userID int64, role *db.Role) ([]byte, error) {
	channels, err := database.ListChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListChannels: %w", err)
	}
	roles, err := database.ListRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("buildReady ListRoles: %w", err)
	}

	members, err := database.ListMembers(ctx)
	if err != nil {
		slog.Warn("buildReady ListMembers", "err", err)
		members = []db.MemberSummary{}
	}

	// Filter channels by READ_MESSAGES through the single permissions.Checker
	// predicate shared with REST ListVisibleChannels and reconnect replay
	// filtering (computeAllowedChannels). The overrides map is fetched once and
	// reused below for the per-channel can_send affordance. DM channels are
	// excluded by the checker — they are delivered via the dm_channels field.
	overrides := map[int64]db.ChannelOverride{}
	if role != nil && !permissions.HasAdmin(role.Permissions) {
		var oErr error
		overrides, oErr = database.GetAllChannelPermissionsForRole(ctx, role.ID)
		if oErr != nil {
			return nil, fmt.Errorf("buildReady GetAllChannelPermissionsForRole: %w", oErr)
		}
	}
	var visibleChannels []db.Channel
	if role != nil {
		// Nil role = zero access (fail closed), handled by skipping the filter.
		visibleIDs := h.permChecker.VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
		for i := range channels {
			if visibleIDs[channels[i].ID] {
				visibleChannels = append(visibleChannels, channels[i])
			}
		}
	}
	if visibleChannels == nil {
		visibleChannels = []db.Channel{}
	}

	// Per-user unread counts.
	unreadMap, err := database.GetChannelUnreadCounts(ctx, userID)
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
			// can_send drives the client's composer affordance. It mirrors
			// MessageService.checkSendPermission for non-DM channels: base role
			// ± channel overrides must grant READ|SEND, and announcement
			// channels additionally require MANAGE_MESSAGES; admins bypass. The
			// server remains the authority — this only pre-disables the UI.
			"can_send": channelCanSend(role, overrides[visibleChannels[i].ID], visibleChannels[i].Type),
		}
		if visibleChannels[i].Type == "text" || visibleChannels[i].Type == "announcement" {
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
	allVoiceStates, err := collectAllVoiceStates(ctx, database, channels)
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
	dmChannels, err := database.GetUserDMChannels(ctx, userID)
	if err != nil {
		slog.Warn("buildReady GetUserDMChannels", "err", err)
		dmChannels = []db.DMChannelInfo{}
	}

	serverName, motd := h.getCachedSettings(ctx)

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
func collectAllVoiceStates(ctx context.Context, database *db.DB, _ []db.Channel) ([]db.VoiceState, error) {
	return database.GetAllVoiceStates(ctx)
}
