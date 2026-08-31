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

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
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
//
// maxConns, when > 0, refuses new connections with 503 once that many clients
// are registered — a static capacity guardrail (server.max_ws_connections).
// The check runs before the upgrade so a refused connection costs one HTTP
// request, not a socket plus goroutines. Registered count trails pre-auth
// connections by design; the 10s auth deadline bounds that gap.
func ServeWS(hub *Hub, database *db.DB, allowedOrigins []string, maxConns int) http.HandlerFunc {
	acceptOpts := OriginAcceptOptions(allowedOrigins)
	return func(w http.ResponseWriter, r *http.Request) {
		if maxConns > 0 && hub.ClientCount() >= maxConns {
			hub.connRejects.Add(1)
			w.Header().Set("Retry-After", "30")
			http.Error(w, "server at connection capacity", http.StatusServiceUnavailable)
			return
		}
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

// handleReconnectPreRegisterRaceHook, when non-nil, runs once inside
// handleReconnect's h.seqMu critical section immediately before the
// mustFullResync re-check that guards registerNow. Test-only (nil in
// production); a real visibility change lands too fast relative to the DB
// round trips above to reliably land a concurrent goroutine in this window,
// so tests use this hook to pin it deterministically instead — mirrors the
// refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook pattern used
// for the analogous races elsewhere in this package (OC-0206).
var handleReconnectPreRegisterRaceHook func()

// freshConnectPreRegisterRaceHook, when non-nil, runs once inside
// handleFreshConnect after refreshUserSnapshot has re-read the user row but
// before registerNow. Test-only (nil in production); pins the
// role-reassignment-vs-handshake window (audit-2026-08-19 F-2)
// deterministically, same pattern as handleReconnectPreRegisterRaceHook.
var freshConnectPreRegisterRaceHook func()

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
	allowedChannelIDs, ok := h.reconnectPrecheck(ctx, database, c, lastSeq)
	if !ok {
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

	events, replaySource, persistedTail, maxPersistedSeq := h.reconnectSelectReplay(ctx, c, lastSeq, allowedChannelIDs)
	if events == nil {
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return false, false
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
	// section deliverBroadcast uses, so no seq can be allocated in between
	// (reconnectRegister below).
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

	events, ok = h.reconnectRegister(ctx, c, lastSeq, allowedChannelIDs, replaySource, persistedTail, maxPersistedSeq)
	if !ok {
		return false, false
	}

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

	// Settle the session's status BEFORE the auth_ok write below, mirroring
	// handleFreshConnect's ordering: reconnectWriteReplay reads c.user.Status
	// to build auth_ok, so if this ran after that write the resumed client
	// would be told its disconnect-time status (routinely "offline", since
	// MarkUserDisconnected just rewrote it) instead of the status it is about
	// to come online as and broadcast (OC-0222). Skips member_join — the user
	// was already known.
	applyConnectStatus(ctx, database, c)

	if !h.reconnectWriteReplay(ctx, conn, c, lastSeq, events, replaySource) {
		// startPumps=false: the teardown inside reconnectWriteReplay already ran
		// in full. Starting readPump on this closed conn would hit an immediate
		// Read error and its defer would run the identical teardown a second
		// time (OC-0051).
		return true, false
	}

	h.announceConnectPresence(c)

	return true, true
}

// reconnectPrecheck runs handleReconnect's two entry guards and, when replay is
// still on the table, returns the read-permission set replay is filtered by.
// ok=false means the caller must fall through to a full ready.
func (h *Hub) reconnectPrecheck(
	ctx context.Context, database *db.DB, c *Client, lastSeq uint64,
) (map[int64]bool, bool) {
	// Channel-visibility changes are delivered as targeted, unsequenced
	// messages, so replay cannot bring a client that missed one back into a
	// coherent state — force the full-ready path instead.
	if h.mustFullResync(lastSeq) {
		slog.Info("ws replay skipped (visibility changed since last_seq), sending full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, false
	}
	// c.user is the auth-time snapshot; a role reassignment landing between
	// authenticateConn and here would otherwise be resolved from the OLD
	// RoleID for the rest of this socket's life — revokeUnreadableChannels
	// cannot reach a mid-handshake socket (it early-returns when the user is
	// not yet in h.clients), and nothing revalidates handshake-time
	// subscriptions afterwards (audit-2026-08-19 F-2). Re-read the row so
	// the permission set below is computed from the CURRENT role.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Warn("ws handleReconnect: user re-read failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, false
	}
	// Compute the set of channel IDs the reconnecting user can access so that
	// channel-scoped replay events are filtered by current permissions (M3).
	allowedChannelIDs, err := h.computeAllowedChannels(ctx, database, c.user)
	if err != nil {
		slog.Warn("ws handleReconnect: computeAllowedChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, false
	}
	return allowedChannelIDs, true
}

// refreshUserSnapshot replaces c.user (and, when the role changed, c.roleName)
// with a fresh read of the user row. Handshake paths call it before
// registerNow, while c is still invisible to every other goroutine, so the
// plain field writes are safe. Fail closed: callers must not proceed on the
// stale snapshot when the re-read fails.
func (h *Hub) refreshUserSnapshot(ctx context.Context, database *db.DB, c *Client) error {
	user, err := database.GetUserByID(ctx, c.userID)
	if err != nil {
		return fmt.Errorf("refreshUserSnapshot GetUserByID: %w", err)
	}
	if user == nil {
		return fmt.Errorf("refreshUserSnapshot: user %d vanished", c.userID)
	}
	// A ban committing during the handshake window (after authenticateConn's
	// own check) must stop the connection here rather than sail through to a
	// live, fully authorized socket: both callers are already fail-closed on
	// this function's error (handleFreshConnect closes the conn;
	// reconnectPrecheck falls back to the full-ready path, which re-reads and
	// hits this same guard) (OC-0272).
	if auth.IsEffectivelyBanned(user) {
		return fmt.Errorf("refreshUserSnapshot: user %d is banned", c.userID)
	}
	if user.RoleID != c.user.RoleID {
		// Fail closed like the sibling lookups in upgradeAndAuth and
		// handleFreshConnect: c.roleName is authoritative on the wire
		// (auth_ok, member_join, every chat_message), so a lookup failure
		// must not silently substitute "member" and pin the session to a
		// fabricated role (OC-0299).
		role, roleErr := database.GetRoleByID(ctx, user.RoleID)
		if roleErr != nil || role == nil {
			return fmt.Errorf("refreshUserSnapshot: role lookup failed for user %d role %d: %w", c.userID, user.RoleID, roleErr)
		}
		c.roleName = strings.ToLower(role.Name)
	}
	c.user = user
	return nil
}

// reconnectSelectReplay picks the tier that serves this resume — the ring
// buffer when it still covers lastSeq, otherwise the cold-tier EventStore — and
// returns the events found, the tier name, and (cold tier only) the persisted
// rows plus their highest seq, which reconnectRegister needs for its re-read.
// A nil events return means neither tier can replay and the caller must fall
// through to a full ready.
func (h *Hub) reconnectSelectReplay(
	ctx context.Context, c *Client, lastSeq uint64, allowedChannelIDs map[int64]bool,
) ([][]byte, string, [][]byte, uint64) {
	var (
		events          [][]byte
		replaySource    = "buffer"
		persistedTail   [][]byte // cold-tier rows only; re-merged with a fresh buffer tail below
		maxPersistedSeq uint64
	)
	if buf := h.ReplayBuffer().EventsSinceFiltered(lastSeq, allowedChannelIDs); buf != nil {
		events = buf
		return events, replaySource, persistedTail, maxPersistedSeq
	}
	// Phase B Step 7 — try cold-tier replay from the EventStore before
	// giving up and forcing a full ready re-sync.
	if esp := h.eventStore.Load(); esp != nil {
		es := *esp
		channelIDs := make([]int64, 0, len(allowedChannelIDs))
		for cid := range allowedChannelIDs {
			channelIDs = append(channelIDs, cid)
		}
		coldCap := h.maxColdReplayLimit()
		persisted, dbErr := es.GetEventsSinceForChannels(ctx, int64(lastSeq), channelIDs, coldCap) //nolint:gosec // lastSeq is a sequence counter bounded well below MaxInt64
		switch {
		case dbErr != nil:
			slog.Warn("ws handleReconnect: cold-tier replay query failed",
				"user_id", c.userID, "err", dbErr)
		case len(persisted) >= coldCap:
			// The query is "ORDER BY seq ASC LIMIT maxColdReplay", so a full
			// result means the gap exceeds the cap and the NEWEST events were
			// dropped. Replaying it would look like a complete resume to the
			// client — it tracks only max(seq) and cannot detect the hole —
			// silently losing state events that REST history never repairs.
			// Leave events nil so the fall-through forces a full ready.
			slog.Warn("ws handleReconnect: cold-tier replay hit the row cap, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq, "cap", coldCap)
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
				persistedTail, maxPersistedSeq = h.reconnectVetColdTail(ctx, c, es, lastSeq, persisted, allowedChannelIDs)
				if persistedTail != nil {
					events = persistedTail
					replaySource = "db"
				}
			}
		}
	}
	return events, replaySource, persistedTail, maxPersistedSeq
}

// reconnectVetColdTail turns a cold-tier result into a replayable tail, or
// returns nil when it cannot be trusted: the range it covers must have no
// interior gap, and the ring buffer must cover everything newer than its last
// row. The returned seq is the highest one in persisted.
func (h *Hub) reconnectVetColdTail(
	ctx context.Context, c *Client, es EventStore, lastSeq uint64,
	persisted []db.PersistedEvent, allowedChannelIDs map[int64]bool,
) ([][]byte, uint64) {
	persistedTail := make([][]byte, 0, len(persisted))
	for _, p := range persisted {
		persistedTail = append(persistedTail, p.Payload)
	}
	maxPersistedSeq := uint64(persisted[len(persisted)-1].Seq) //nolint:gosec // seq is a counter bounded well below MaxInt64

	// persisted is channel-filtered, so a hole in a channel
	// outside allowedChannelIDs would slip past a contiguity
	// check on persisted itself — and EventPersister can lose a
	// row outright (a full queue drops silently in Enqueue, a
	// per-row insert failure inside a batch flush is logged but
	// never surfaced here; see event_persister.go). Count the
	// UNFILTERED range (lastSeq, maxPersistedSeq] and require
	// every seq in it to be present. seq is the events table's
	// primary key, so the count can only come up short, never
	// over.
	expectedCount := maxPersistedSeq - lastSeq
	switch gapCount, gapErr := es.CountEventsInRange(ctx, int64(lastSeq), int64(maxPersistedSeq)); { //nolint:gosec // bounded well below MaxInt64
	case gapErr != nil:
		slog.Warn("ws handleReconnect: cold-tier contiguity probe failed, forcing full ready",
			"user_id", c.userID, "err", gapErr)
		persistedTail = nil
	case uint64(gapCount) != expectedCount: //nolint:gosec // bounded well below MaxInt64
		slog.Warn("ws handleReconnect: cold-tier replay has an interior gap, forcing full ready",
			"user_id", c.userID, "last_seq", lastSeq, "max_persisted_seq", maxPersistedSeq,
			"expected", expectedCount, "found", gapCount)
		persistedTail = nil
	}

	if persistedTail != nil {
		// The EventPersister flushes asynchronously, so cold rows can
		// lag the live seq: events broadcast after the last flush sit
		// only in the ring buffer. Confirm the buffer can cover
		// everything above the newest persisted row — the
		// authoritative re-read happens atomically with registerNow
		// below, but a hole here must still force a full ready
		// rather than a replay with a silent gap at its end.
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
	}
	return persistedTail, maxPersistedSeq
}

// reconnectRegister re-reads the ring-buffer-derived portion of the replay and
// registers c inside the SAME h.seqMu critical section deliverBroadcast uses,
// so no seq can be allocated in between (see the comment in handleReconnect).
// It returns the events to actually send; ok=false means one of the re-checks
// tripped and the caller must fall through to a full ready.
func (h *Hub) reconnectRegister(
	ctx context.Context, c *Client, lastSeq uint64, allowedChannelIDs map[int64]bool,
	replaySource string, persistedTail [][]byte, maxPersistedSeq uint64,
) ([][]byte, bool) {
	var events [][]byte
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
			return nil, false
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
			return nil, false
		}
	}
	if handleReconnectPreRegisterRaceHook != nil {
		handleReconnectPreRegisterRaceHook()
	}
	// Re-check the watermark one last time, right before registerNow makes
	// this connection reachable. RefreshChannelVisibility and
	// revokeUnreadableChannels both iterate h.clients to fan out a targeted,
	// unsequenced channel_create/channel_delete — a snapshot this
	// still-mid-handshake connection is absent from — and both only bump the
	// watermark afterward. Without this re-check, a visibility change that
	// lands anywhere between the entry check above and here is missed twice:
	// the fan-out can't reach an unregistered client, and the entry check has
	// already passed, so nothing else catches it before this resume commits
	// to permissions computed before the change (OC-0206).
	if h.mustFullResync(lastSeq) {
		h.seqMu.Unlock()
		slog.Warn("ws handleReconnect: visibility changed during handshake, forcing full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, false
	}
	h.registerNow(c, allowedChannelIDs)
	h.seqMu.Unlock()
	return events, true
}

// reconnectWriteReplay writes the resume handshake: auth_ok followed by the
// replayed events. A false return means a write failed, in which case the full
// unregisterFailedHandshake teardown has already run and conn is closed, so the
// caller must not start any pump (OC-0051).
func (h *Hub) reconnectWriteReplay(
	ctx context.Context, conn *websocket.Conn, c *Client, lastSeq uint64,
	events [][]byte, replaySource string,
) bool {
	// Replay succeeded — send auth_ok then missed events. The replay tier
	// is included in the payload so the client can attribute reconnect
	// behaviour without separate metric scraping.
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName, "replay_source", replaySource)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, replaySource)); err != nil {
		slog.Warn("ws: failed to send auth_ok (reconnect)", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return false
	}
	for _, evt := range events {
		if err := handshakeWrite(ctx, conn, evt); err != nil {
			slog.Warn("ws: failed to send replay event", "user_id", c.userID, "err", err)
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return false
		}
	}
	slog.Info("ws replay completed", "user_id", c.userID, "events_replayed", len(events), "from_seq", lastSeq, "source", replaySource)
	return true
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
		coldCap := h.maxColdReplayLimit()
		// Fetch one row past the cap so truncation is decided by the presence
		// of that extra row, not by len == cap: a complete window of exactly
		// coldCap rows is not truncated and must replay in full (Codex review
		// on #1436). A result of at most coldCap rows is therefore complete.
		persisted, err := es.GetEventsSinceForChannels(ctx, int64(afterSeq), []int64{chID}, coldCap+1) //nolint:gosec // afterSeq is a sequence counter bounded well below MaxInt64
		if err != nil {
			return nil
		}
		if len(persisted) > coldCap {
			// Same failure mode reconnectSelectReplay guards against above:
			// the query is "ORDER BY seq ASC LIMIT n", so a result past the
			// cap means the range exceeds it and any cap-sized window would
			// have silently dropped the NEWEST rows — for a voice room, quite
			// possibly the peer's voice_leave. Replaying a truncated window
			// would install a join whose matching leave was discarded, which
			// is worse than the documented best-effort miss this function
			// already returns on a plain lookup failure. A full ready isn't
			// available here (registerNow already ran before this supplement
			// runs), so nil is the correct degradation.
			slog.Warn("ws liveVoiceEventsSince: cold-tier supplement exceeds the row cap, skipping truncated window",
				"chID", chID, "after_seq", afterSeq, "cap", coldCap)
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
		// Do not stamp c.user.Status on a failed write: it would make the
		// auth_ok reply and the presence broadcast below both claim a value
		// that users.status disagrees with, and buildReady's ListMembers read
		// of users.status (via presentableMembers, which only ever downgrades
		// a connected user to offline, never upgrades one) would then never
		// self-correct for the rest of this session (OC-0298).
		return
	}
	c.user.Status = status
}

// announceConnectPresence fans out the status applyConnectStatus settled on,
// with the invisible mapping applied.
func (h *Hub) announceConnectPresence(c *Client) {
	h.QueuePresence(c.userID, c.user.Status, c.user.CustomStatus)
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
