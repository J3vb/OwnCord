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
			if handled, shouldStartPumps := hub.handleReconnect(ctx, conn, c, database, lastSeq); handled {
				if shouldStartPumps {
					startPumps()
				}
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

// handleReconnect attempts to resume a client via replay. Its two return
// values are independent signals for ServeWS:
//   - handled reports whether this function owns the outcome of the
//     connection attempt. false means "replay isn't possible, fall through
//     to handleFreshConnect for a full ready."
//   - startPumps reports whether ServeWS should start readPump/writePump.
//     It is only meaningful when handled is true, and is false on the
//     handshake-write-failure paths below: those paths already ran the full
//     unregisterFailedHandshake teardown and closed conn themselves, so no
//     pump may start — readPump's defer would find the client already gone
//     (unregisterNow reporting replaced=false) and run that same teardown a
//     second time (OC-0051): a duplicate MarkUserDisconnected, a duplicate
//     offline presence broadcast, and a duplicate hub seq for it.
func (h *Hub) handleReconnect(
	ctx context.Context, conn *websocket.Conn, c *Client, database *db.DB, lastSeq uint64,
) (handled, startPumps bool) {
	// Channel-visibility changes are delivered as targeted, unsequenced
	// messages, so replay cannot bring a client that missed one back into a
	// coherent state — force the full-ready path instead.
	if h.mustFullResync(lastSeq) {
		slog.Info("ws replay skipped (visibility changed since last_seq), sending full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return false, false
	}
	// Compute the set of channel IDs the reconnecting user can access so that
	// channel-scoped replay events are filtered by current permissions (M3).
	allowedChannelIDs, err := h.computeAllowedChannels(ctx, database, c.user)
	if err != nil {
		slog.Warn("ws handleReconnect: computeAllowedChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return false, false
	}

	// Voice membership needs only CONNECT_VOICE, not READ_MESSAGES
	// (voice_join.go), so a live participant resuming can have their own room
	// excluded from allowedChannelIDs entirely — most commonly a DM voice call
	// after the DM was closed (computeAllowedChannels sources DM IDs from
	// dm_open_state). Capture it before registerNow performs the same
	// lookup/transfer, so replay can be supplemented below with the room's own
	// voice_state/voice_leave even though the room is outside the READ-gated
	// allowed set. It is never added to allowedChannelIDs itself — that map
	// also gates the ChannelTopic subscription in registerNow and would leak
	// the channel's chat to a user who cannot read it.
	var liveVoiceChID int64
	if old := h.GetClient(c.userID); old != nil {
		liveVoiceChID = old.getVoiceChID()
	}

	var (
		events          [][]byte
		replaySource    = "buffer"
		persistedTail   [][]byte // cold-tier rows only; re-merged with a fresh buffer tail below
		maxPersistedSeq uint64
	)
	if buf := h.ReplayBuffer().EventsSinceFiltered(lastSeq, allowedChannelIDs); buf != nil {
		events = buf
	} else {
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
				// Retention pruning (PruneEventsOlderThan) deletes purely by
				// created_at with no seq-floor coordination, so this
				// channel-filtered result can be a surviving suffix left behind
				// after the events between lastSeq and persisted[0] were
				// pruned. Accepting it as-is would present a hole as a complete
				// resume, since the client tracks only max(seq). Probe the
				// store's oldest surviving seq UNFILTERED before trusting it —
				// a channel-filtered contiguity check on persisted itself can't
				// work, since a sparse per-channel result is legitimately
				// non-contiguous.
				oldest, oldestErr := es.GetEventsSince(ctx, 0, 1)
				switch {
				case oldestErr != nil:
					slog.Warn("ws handleReconnect: cold-tier oldest-seq probe failed, forcing full ready",
						"user_id", c.userID, "err", oldestErr)
				case len(oldest) == 0 || uint64(oldest[0].Seq) > lastSeq+1: //nolint:gosec // seq is a counter bounded well below MaxInt64
					var oldestSeq int64
					if len(oldest) > 0 {
						oldestSeq = oldest[0].Seq
					}
					slog.Warn("ws handleReconnect: retention pruning left a gap before last_seq, forcing full ready",
						"user_id", c.userID, "last_seq", lastSeq, "oldest_seq", oldestSeq)
				default:
					persistedTail = make([][]byte, 0, len(persisted))
					for _, p := range persisted {
						persistedTail = append(persistedTail, p.Payload)
					}
					// The EventPersister flushes asynchronously, so cold rows can
					// lag the live seq: events broadcast after the last flush sit
					// only in the ring buffer. Confirm the buffer can cover
					// everything above the newest persisted row — the
					// authoritative re-read happens atomically with registerNow
					// below, but a hole here must still force a full ready
					// rather than a replay with a silent gap at its end.
					maxPersistedSeq = uint64(persisted[len(persisted)-1].Seq) //nolint:gosec // seq is a counter bounded well below MaxInt64
					switch tail := h.ReplayBuffer().EventsSinceFiltered(maxPersistedSeq, allowedChannelIDs); {
					case tail != nil:
					case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
						// Post-restart empty buffer with the hub seq seeded from
						// the store max: nothing was broadcast after the last
						// persisted row, so the cold rows alone are complete.
					default:
						slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail, forcing full ready",
							"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
						persistedTail = nil
					}
					if persistedTail != nil {
						events = persistedTail
						replaySource = "db"
					}
				}
			}
		}
		if events == nil {
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return false, false
		}
	}

	// Register BEFORE writing replay data so broadcasts that arrive during
	// the write window are queued in the client's send buffer instead of
	// being lost (BUG-123). writePump hasn't started yet, so queued messages
	// will be drained once the pumps begin.
	//
	// The replay set built above can go stale between being read and c
	// becoming reachable: deliverBroadcast (the hub's own Run goroutine)
	// allocates a seq, pushes it to the ring buffer, and publishes to current
	// subscribers — all under h.seqMu — concurrently with this handshake
	// goroutine. registerNow is what subscribes this connection, so a
	// broadcast landing in the gap between the snapshot above and
	// registration reaches nobody, and the client's max(seq)-only tracking
	// means it can never be requested again once a later frame arrives.
	// Close the window by re-reading the ring-buffer-derived portion of
	// `events` and calling registerNow inside the SAME h.seqMu critical
	// section deliverBroadcast uses, so no seq can be allocated in between.
	// Restore the client's channel subscription BEFORE registration.
	//
	// registerNow copies the channel subscription from the OLD client entry,
	// but on a resume where the server already observed the previous socket
	// close there is no old entry to copy from — so without this the resumed
	// connection holds no ChannelTopic subscription until its post-auth_ok
	// channel_focus round trip completes. Everything broadcast to that channel
	// in the window (auth_ok write + up to maxColdReplay replay frames + pump
	// startup + one RTT) is delivered to nobody on this socket, and the client
	// can never ask for it back because it only ever reports max(seq).
	//
	// Set outside the h.seqMu section below so this does not introduce a
	// seqMu -> c.mu lock-order edge that nothing else in the hub has.
	//
	// c.authChannelID is attacker-controlled, so it is honoured only when the
	// freshly computed read-permission set contains it. Fail closed: an
	// unknown or now-unreadable id leaves channelID at 0, which is exactly the
	// pre-existing behaviour rather than a new denial.
	if c.authChannelID != 0 {
		if allowedChannelIDs[c.authChannelID] {
			c.mu.Lock()
			c.channelID = c.authChannelID
			c.mu.Unlock()
		} else {
			slog.Debug("ws handleReconnect: ignoring unreadable active_channel_id from auth frame",
				"user_id", c.userID, "channel_id", c.authChannelID)
		}
	}

	h.seqMu.Lock()
	switch replaySource {
	case "buffer":
		fresh := h.ReplayBuffer().EventsSinceFiltered(lastSeq, allowedChannelIDs)
		if fresh == nil {
			// The buffer window closed between the earlier check and this
			// lock (an extreme write burst evicted lastSeq) — there is
			// nothing left to fall back to for this attempt but a full ready.
			h.seqMu.Unlock()
			slog.Warn("ws handleReconnect: buffer window closed just before registration, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq)
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return false, false
		}
		events = fresh
	case "db":
		switch tail := h.ReplayBuffer().EventsSinceFiltered(maxPersistedSeq, allowedChannelIDs); {
		case tail != nil:
			events = append(append([][]byte{}, persistedTail...), tail...)
		case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
			events = persistedTail
		default:
			h.seqMu.Unlock()
			slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail just before registration, forcing full ready",
				"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return false, false
		}
	}
	h.registerNow(c, allowedChannelIDs)
	h.seqMu.Unlock()

	switch replaySource {
	case "buffer":
		h.reconnectTierBuf.Add(1)
	case "db":
		h.reconnectTierDB.Add(1)
	}
	telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", replaySource))

	// Best-effort supplement: the user's own live voice room may sit outside
	// allowedChannelIDs (see the capture of liveVoiceChID above), so its
	// voice_state/voice_leave would otherwise never reach this replay at all.
	// Tries the ring buffer first, then the cold-tier store; a miss on both
	// just leaves this one supplement as a no-op, not a regression versus the
	// pre-fix behaviour.
	if liveVoiceChID != 0 && !allowedChannelIDs[liveVoiceChID] {
		events = append(events, h.liveVoiceEventsSince(ctx, lastSeq, liveVoiceChID)...)
	}

	// Replay succeeded — send auth_ok then missed events. The replay tier
	// is included in the payload so the client can attribute reconnect
	// behaviour without separate metric scraping.
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName, "replay_source", replaySource)
	if err := conn.Write(ctx, websocket.MessageText, h.buildAuthOK(ctx, c.user, c.roleName, replaySource)); err != nil {
		slog.Warn("ws: failed to send auth_ok (reconnect)", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		// startPumps=false: the teardown above already ran in full. Starting
		// readPump on this closed conn would hit an immediate Read error and
		// its defer would run the identical teardown a second time (OC-0051).
		return true, false
	}
	for _, evt := range events {
		if err := conn.Write(ctx, websocket.MessageText, evt); err != nil {
			slog.Warn("ws: failed to send replay event", "user_id", c.userID, "err", err)
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return true, false
		}
	}
	slog.Info("ws replay completed", "user_id", c.userID, "events_replayed", len(events), "from_seq", lastSeq, "source", replaySource)

	// Update presence but skip member_join — user was already known.
	applyConnectStatus(ctx, database, c)
	h.announceConnectPresence(c)

	return true, true
}

// liveVoiceEventsSince returns voice_state/voice_leave events for chID at or
// after afterSeq, bypassing the READ-gated channel filter entirely. Voice
// membership needs only CONNECT_VOICE (voice_join.go), so a resuming
// participant's own room is not always in their READ-visible set — a stock
// example is a DM voice call after the DM was closed. Tries the ring buffer
// first (fresh, so it observes anything pushed concurrently with the caller),
// then falls back to the cold-tier store; returns nil, not an error, on a
// miss in both, since this is a best-effort supplement to the main replay.
func (h *Hub) liveVoiceEventsSince(ctx context.Context, afterSeq uint64, chID int64) [][]byte {
	if chID == 0 {
		return nil
	}
	only := map[int64]bool{chID: true}
	var raw [][]byte
	if buf := h.ReplayBuffer().EventsSinceFiltered(afterSeq, only); buf != nil {
		raw = buf
	} else if esp := h.eventStore.Load(); esp != nil {
		es := *esp
		persisted, err := es.GetEventsSinceForChannels(ctx, int64(afterSeq), []int64{chID}, maxColdReplay) //nolint:gosec // afterSeq is a sequence counter bounded well below MaxInt64
		if err != nil {
			return nil
		}
		raw = make([][]byte, 0, len(persisted))
		for _, p := range persisted {
			raw = append(raw, p.Payload)
		}
	}
	if len(raw) == 0 {
		return nil
	}
	filtered := make([][]byte, 0, len(raw))
	for _, evt := range raw {
		switch extractEventType(evt) {
		case MsgTypeVoiceState, MsgTypeVoiceLeaveBC:
			filtered = append(filtered, evt)
		}
	}
	return filtered
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
		_ = h.db.MarkUserDisconnected(cleanupCtx, c.userID)
		// custom_status is nil, not c.user.CustomStatus: see the identical
		// note in serve_pumps.go's readPump defer — that field is an
		// auth-time snapshot, never updated, so broadcasting it here can
		// resurrect a status the user already changed or cleared.
		h.BroadcastToAll(buildPresenceMsg(c.userID, db.StatusOffline, nil))
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
