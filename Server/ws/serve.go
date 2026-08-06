package ws

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

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

	// maxColdReplay caps how many persisted events a single cold-tier reconnect
	// replay may return. A gap that reaches the cap cannot be replayed correctly
	// and falls back to a full ready — see handleReconnect.
	maxColdReplay = 5000
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
			persisted, dbErr := es.GetEventsSinceForChannels(ctx, int64(lastSeq), channelIDs, maxColdReplay) //nolint:gosec // lastSeq is a sequence counter bounded well below MaxInt64
			switch {
			case dbErr != nil:
				slog.Warn("ws handleReconnect: cold-tier replay query failed",
					"user_id", c.userID, "err", dbErr)
			case len(persisted) >= maxColdReplay:
				// The query is "ORDER BY seq ASC LIMIT maxColdReplay", so a full
				// result means the gap exceeds the cap and the NEWEST events were
				// dropped. Replaying it would look like a complete resume to the
				// client — it tracks only max(seq) and cannot detect the hole —
				// silently losing state events that REST history never repairs.
				// Leave events nil so the fall-through forces a full ready.
				slog.Warn("ws handleReconnect: cold-tier replay hit the row cap, forcing full ready",
					"user_id", c.userID, "last_seq", lastSeq, "cap", maxColdReplay)
			case len(persisted) > 0:
				events = make([][]byte, 0, len(persisted))
				for _, p := range persisted {
					events = append(events, p.Payload)
				}
				// The EventPersister flushes asynchronously, so cold rows can
				// lag the live seq: events broadcast after the last flush sit
				// only in the ring buffer. Merge that tail, or the replay
				// presents an incomplete resume as complete (the client tracks
				// only max(seq) and cannot detect the hole).
				maxPersistedSeq := uint64(persisted[len(persisted)-1].Seq) //nolint:gosec // seq is a counter bounded well below MaxInt64
				switch tail := h.ReplayBuffer().EventsSinceFiltered(maxPersistedSeq, allowedChannelIDs); {
				case tail != nil:
					events = append(events, tail...)
				case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
					// Post-restart empty buffer with the hub seq seeded from
					// the store max: nothing was broadcast after the last
					// persisted row, so the cold rows alone are complete.
				default:
					// The buffer cannot vouch for the gap above the newest
					// persisted row — force a full ready instead of a replay
					// with a silent hole at its end.
					slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail, forcing full ready",
						"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
					events = nil
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
	h.registerNow(c, allowedChannelIDs)

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
	applyConnectStatus(ctx, database, c)
	h.announceConnectPresence(c)

	return true
}

// unregisterFailedHandshake removes c after a post-registerNow handshake
// write failure. No readPump ever starts for this connection, and the old
// connection this one replaced already ran its defer (skipping teardown
// because this client held the slot) — so when no replacement remains, the
// standard disconnect teardown must run here or the user stays online forever.
func (h *Hub) unregisterFailedHandshake(ctx context.Context, c *Client) {
	if replaced := h.unregisterNow(c); !replaced {
		cleanupCtx := context.WithoutCancel(ctx)
		_ = h.db.MarkUserDisconnected(cleanupCtx, c.userID)
		h.BroadcastToAll(buildPresenceMsg(c.userID, db.StatusOffline, c.user.CustomStatus))
	}
}

// applyConnectStatus writes the status this session comes online as and caches
// it on the client.
//
// It is db.ConnectStatus(saved) rather than a flat "online": stamping online on
// every connect is what made a saved Do Not Disturb — and, before this phase,
// an "appear offline" — flash back to online on every reconnect, with the
// client racing to re-assert its choice afterwards. idle/dnd/invisible are
// deliberate choices and survive; anything else becomes online. The write still
// happens when the status is unchanged, because UpdateUserStatus also refreshes
// last_seen.
//
// It runs BEFORE the ready payload is built so the member list the client is
// handed already agrees with the presence broadcast that follows it.
func applyConnectStatus(ctx context.Context, database *db.DB, c *Client) {
	status := db.ConnectStatus(c.user.Status)
	if updateErr := database.UpdateUserStatus(ctx, c.userID, status); updateErr != nil {
		slog.Warn("ws UpdateUserStatus", "err", updateErr)
	}
	c.user.Status = status
}

// announceConnectPresence fans out the status applyConnectStatus settled on,
// with the invisible mapping applied.
func (h *Hub) announceConnectPresence(c *Client) {
	h.BroadcastPresence(c.userID, c.user.Status, c.user.CustomStatus)
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
			overrides, err = database.GetChannelOverridesFor(ctx, role.ID, user.ID)
			if err != nil {
				return nil, fmt.Errorf("computeAllowedChannels GetChannelOverridesFor: %w", err)
			}
		}
		allowed = h.permChecker.VisibleChannelIDs(role.Permissions, channelRefs(channels), permOverrides(overrides))
	}

	// Include the user's open DM channels. Only the ID set matters here, so
	// use the PK-covered dm_open_state lookup instead of the full DM query.
	// Fatal like the three sibling lookups above: a silently DM-stripped
	// replay advances the client's lastSeq past DM events it never received —
	// a permanent hole. The caller's error path falls back to full ready.
	dmIDs, dmErr := database.GetUserDMChannelIDs(ctx, user.ID)
	if dmErr != nil {
		return nil, fmt.Errorf("computeAllowedChannels GetUserDMChannelIDs: %w", dmErr)
	}
	for _, id := range dmIDs {
		allowed[id] = true
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
		// Replay-failure fallback (lastSeq > 0): registerNow below transfers
		// the still-registered old connection's live voice state into this
		// client. Deleting the DB row here — and the LiveKit participant,
		// whose removal token is the very JoinedAt being transferred — would
		// leave the user "in voice" on the hub only: voice_join bounces off
		// ALREADY_JOINED and sweepStaleVoiceStates never heals
		// memory-without-row. Keep the row so ready stays consistent. If the
		// old client unregisters before registerNow runs, the transfer is
		// skipped and the next sweep reaps the then-truly-stale row.
		if old := h.GetClient(c.userID); c.lastSeq > 0 && old != nil && old.getVoiceChID() == vs.ChannelID {
			slog.Info("ws fresh connect: keeping voice state for replay-failure fallback",
				"user_id", c.userID, "channel_id", vs.ChannelID)
		} else {
			slog.Info("ws fresh connect: cleaning stale voice state",
				"user_id", c.userID, "channel_id", vs.ChannelID)
			if _, delErr := database.LeaveVoiceChannelIfMatch(ctx, c.userID, vs.ChannelID, vs.JoinedAt); delErr != nil {
				slog.Warn("ws fresh connect: LeaveVoiceChannelIfMatch failed", "err", delErr)
			}
			h.broadcastVoiceEvent(ctx, vs.ChannelID, buildVoiceLeave(vs.ChannelID, c.userID))
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
	//
	// Only the replay-failure fallback (lastSeq > 0) can inherit voice state
	// from the previous connection, so that is the only case where registerNow
	// needs the read-permission set. Fail closed on error: nil denies the
	// inherited voice-channel subscription.
	var allowedChannelIDs map[int64]bool
	if c.lastSeq > 0 {
		allowed, allowedErr := h.computeAllowedChannels(ctx, database, c.user)
		if allowedErr != nil {
			slog.Warn("ws handleFreshConnect: computeAllowedChannels failed, skipping voice channel subscription",
				"user_id", c.userID, "err", allowedErr)
		} else {
			allowedChannelIDs = allowed
		}
	}
	h.registerNow(c, allowedChannelIDs)

	// Settle the session's status before buildReady reads the member list, so
	// the ready payload and the presence broadcast below cannot disagree.
	applyConnectStatus(ctx, database, c)

	// Fresh connection or replay fallback: full auth_ok + ready flow.
	slog.Info("ws sending auth_ok", "user_id", c.userID, "username", c.user.Username, "role", c.roleName)
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(ctx, c.user, c.roleName, "none")); err != nil {
		slog.Warn("ws: failed to send auth_ok", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return err
	}
	if ready, readyErr := h.buildReady(ctx, database, c.userID, userRole); readyErr == nil {
		slog.Info("ws sending ready payload", "user_id", c.userID, "payload_bytes", len(ready))
		if err := conn.Write(ctx, websocket.MessageText, ready); err != nil {
			slog.Warn("ws: failed to send ready payload", "user_id", c.userID, "err", err)
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return err
		}
	} else {
		slog.Error("buildReady failed", "user_id", c.userID, "err", readyErr)
		_ = conn.Write(ctx, websocket.MessageText,
			buildErrorMsg(ErrCodeInternal, "failed to build ready payload"))
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "failed to build ready payload")
		return readyErr
	}

	slog.Info("ws broadcasting member_join and presence", "user_id", c.userID, "username", c.user.Username)
	h.BroadcastToAll(buildMemberJoin(c.user, c.roleName))
	h.announceConnectPresence(c)

	return nil
}
