package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// staleClientTimeout is how long a client may go without sending any message or
// answering a protocol Ping before being kicked. pingPump refreshes activity on
// every Pong (25s) and closes a peer that misses one itself, so this is the
// backstop; the app-level ping (every 30s) covers old peers.
var staleClientTimeout = 90 * time.Second

func (h *Hub) onStaleTick() {
	h.sweepStaleClients()
	h.refreshTelemetryGauges()
	h.expireReplayTombstones()
}

// refreshTelemetryGauges recomputes the connection and voice gauges from live
// client state. Periodic rather than event-driven: join/leave and
// register/unregister are spread across request-scoped handlers where a
// context.Background() instrumentation call would trip contextcheck, and a gauge
// need only be right at scrape time.
func (h *Hub) refreshTelemetryGauges() {
	participants := 0
	rooms := make(map[int64]struct{})
	h.mu.RLock()
	connected := h.connectionCountLocked()
	for _, c := range h.allClientsLocked() {
		if chID := c.voice.channel(); chID != 0 {
			participants++
			rooms[chID] = struct{}{}
		}
	}
	h.mu.RUnlock()
	m := telemetry.NewAppMetrics()
	ctx := context.Background()
	m.WSActiveConnections.Set(ctx, float64(connected))
	m.VoiceParticipants.Set(ctx, float64(participants))
	m.VoiceActiveSessions.Set(ctx, float64(len(rooms)))
}

// kickClient removes a client from the hub and closes its send channel, so
// writePump exits and the connection closes. Safe from any goroutine.
func (h *Hub) kickClient(c *Client) {
	h.mu.Lock()
	h.removeClientLocked(c)
	h.mu.Unlock()
	// closeSend before UnsubscribeAll: Subscribe's only re-take guard is isSendClosed,
	// so a racing Subscribe either lands before the close (and UnsubscribeAll removes
	// it) or sees the closed channel and refuses. The reverse order leaves the dead
	// client holding the topic.
	c.closeSend()
	h.pubsub.UnsubscribeAll(c)
}

// kickClientTerminal is kickClient for a disconnect that refuses reconnection
// (ban, revoked or expired session): it marks c first so the read-loop teardown
// ends a voice call at once instead of parking it for a resume that cannot come.
func (h *Hub) kickClientTerminal(c *Client) {
	c.markTerminalKick()
	h.kickClient(c)
}

// sweepTimeout bounds one background sweep so a wedged DB or LiveKit call cannot
// hold a sweep (and its in-flight guard) forever. A var so tests can shorten it.
var sweepTimeout = 30 * time.Second

// sweepTailTimeout bounds the follow-up steps of a sweep action that already
// committed (broadcast, key-holder re-election, SFU removal). They run detached
// from the sweep's timeout so a committed delete is still announced, but end when
// the hub stops. 15s keeps it above the DB busy_timeout (5s) so a delete that waits
// out the lock still has budget to broadcast. A var so tests can shorten it.
var sweepTailTimeout = 15 * time.Second

func (h *Hub) sweepTailCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	tail, cancel := context.WithTimeout(context.WithoutCancel(ctx), sweepTailTimeout)
	stop := context.AfterFunc(h.life, cancel)
	return tail, func() {
		stop()
		cancel()
	}
}

// startSweep runs sweep on its own goroutine so the dispatch loop never blocks on
// DB-heavy sweeps. inFlight guarantees a sweep never overlaps itself: a tick
// arriving mid-run is dropped and the next retries. The sweep's ctx ends at
// sweepTimeout or when the hub stops, and Run waits for it before Done closes.
// Only Run calls this, so no Add can race the Wait in Run's exit.
func (h *Hub) startSweep(inFlight *atomic.Bool, sweep func(context.Context)) {
	if !inFlight.CompareAndSwap(false, true) {
		return
	}
	ctx, cancel := context.WithTimeout(h.life, sweepTimeout)
	h.sweeps.Go(func() {
		defer inFlight.Store(false)
		defer cancel()
		sweep(ctx)
	})
}

// sweepStaleClients kicks any client silent for staleClientTimeout.
func (h *Hub) sweepStaleClients() {
	now := time.Now()
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.allClientsLocked() {
		if now.Sub(c.getLastActivity()) > staleClientTimeout {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range stale {
		slog.Warn("hub: closing stale connection (no activity)",
			"user_id", c.userID, "last_activity", c.getLastActivity())
		h.kickClient(c)
	}
}

// sweepRevokedSessions kicks any client whose session was deleted or expired or
// whose user was banned: time-based enforcement for idle sockets that never reach
// the message-count check.
func (h *Hub) sweepRevokedSessions(ctx context.Context) {
	h.mu.RLock()
	snapshot := make([]*Client, 0, len(h.clients))
	for _, c := range h.allClientsLocked() {
		if c.tokenHash != "" {
			snapshot = append(snapshot, c)
		}
	}
	h.mu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	// One batched lookup for every connected client. The expiry and ban rules are
	// SessionService's, the same as the handshake's, so a live and a resuming session
	// cannot disagree about validity.
	hashes := make([]string, len(snapshot))
	for i, c := range snapshot {
		hashes[i] = c.tokenHash
	}
	verdicts, err := h.authn.SweepSessions(ctx, hashes)
	if err != nil {
		// A failed batch lookup says nothing about any session; kicking everyone on a
		// transient DB error would be a mass disconnect. Skip; the next tick retries.
		slog.Warn("session sweep: batch session lookup failed", "err", err)
		return
	}

	for _, c := range snapshot {
		// A hash the authenticator did not answer reads as the zero value, SessionRevoked
		// by design: fail closed.
		h.applySessionVerdict(c, verdicts[c.tokenHash])
	}
}

// applySessionVerdict drops c when its session is revoked, expired or banned.
func (h *Hub) applySessionVerdict(c *Client, verdict service.SessionVerdict) {
	switch verdict {
	case service.SessionRevoked:
		slog.Info("session sweep: revoked/expired session, disconnecting",
			"user_id", c.userID)
		h.kickClientTerminal(c)
	case service.SessionBanned:
		slog.Info("session sweep: banned user, disconnecting",
			"user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
		h.kickClientTerminal(c)
	case service.SessionLive:
	}
}

// DisconnectIfSessionRevoked is the revoked-session sweep for one account, run
// now: after a password change or single-session revoke removes some sessions,
// each socket goes at once if its own session was among them. A failed lookup
// leaves it to the next sweep tick.
func (h *Hub) DisconnectIfSessionRevoked(userID int64) {
	var conns []*Client
	var hashes []string
	for _, c := range h.clientsOf(userID) {
		if c.tokenHash != "" {
			conns = append(conns, c)
			hashes = append(hashes, c.tokenHash)
		}
	}
	if len(conns) == 0 {
		return
	}
	verdicts, err := h.authn.SweepSessions(context.Background(), hashes)
	if err != nil {
		slog.Warn("session sweep: batch session lookup failed", "user_id", userID, "err", err)
		return
	}
	// Each device is judged by its own session; the account's other devices stay.
	for _, c := range conns {
		h.applySessionVerdict(c, verdicts[c.tokenHash])
	}
}

// sweepStaleVoiceStates removes voice_states rows that match no connected client's
// voiceChID, catching ghosts that slip through the primary cleanup paths
// (registerNow, readPump defer, LiveKit webhook).
func (h *Hub) sweepStaleVoiceStates(ctx context.Context) {
	h.sweepStaleVoiceEvictRevoked(ctx)

	allStates, err := h.voice.AllStates(ctx)
	if err != nil {
		slog.Warn("sweepStaleVoiceStates: AllStates failed", "err", err)
		return
	}
	if len(allStates) == 0 {
		return
	}

	h.mu.RLock()
	var stale []struct {
		userID    int64
		channelID int64
		joinedAt  string
	}
	for _, vs := range allStates {
		if !h.anyConnInVoiceChannelLocked(vs.UserID, vs.ChannelID) {
			stale = append(stale, struct {
				userID    int64
				channelID int64
				joinedAt  string
			}{vs.UserID, vs.ChannelID, vs.JoinedAt})
		}
	}
	h.mu.RUnlock()

	// A membership parked in the grace window has no live client, so the scan
	// classified it stale, but it is deliberately held for a resuming socket. Skip
	// the parked (user, channel) pairs; the grace timer owns their teardown. Snapshot
	// first so no grace lock is held while deleting rows.
	parked := h.voiceReg.voiceGrace.snapshot()

	for _, s := range stale {
		if ctx.Err() != nil {
			return
		}
		if parked[s.userID] == s.channelID {
			continue
		}
		if sweepStaleVoiceJoinRaceHook != nil {
			sweepStaleVoiceJoinRaceHook(s.userID, s.channelID, s.joinedAt)
		}

		if removed := h.sweepStaleVoiceEntry(ctx, s.userID, s.channelID, s.joinedAt); removed && h.livekit != nil {
			tailCtx, cancelTail := h.sweepTailCtx(ctx)
			_ = h.livekit.RemoveParticipant(tailCtx, s.channelID, s.userID, s.joinedAt)
			cancelTail()
		}
	}
}

// sweepStaleVoiceEntry removes one stale row under the user's voice lock, so a join
// between its row commit and c.voice.setState cannot interleave with the recheck
// and delete. It reports whether the row was removed; the caller does the SFU
// removal after the lock is released.
func (h *Hub) sweepStaleVoiceEntry(ctx context.Context, userID, channelID int64, joinedAt string) (removed bool) {
	txn := h.begin(userID)
	defer txn.end()

	// Re-check the live client right before deleting. voice_join commits the row before
	// c.voice.setState, so a join can commit and be snapshotted as a ghost. Under the
	// voice lock that join has finished; if the client's state agrees with the row, it
	// is not stale.
	for _, liveClient := range h.clientsOf(userID) {
		if liveChID, liveJoinedAt := liveClient.voice.state(); liveChID == channelID && liveJoinedAt == joinedAt {
			return false
		}
	}
	// A socket that dropped after the snapshot may have parked this membership in the
	// grace window; the grace timer owns it now.
	if h.voiceReg.voiceGrace.has(userID, channelID) {
		return false
	}

	if sweepStaleVoicePreDeleteRaceHook != nil {
		sweepStaleVoicePreDeleteRaceHook(userID, channelID, joinedAt)
	}

	// Channel-conditional delete: a no-op (and no broadcast) if the user rejoined or
	// moved since the snapshot.
	deleted, err := txn.deleteRow(ctx, channelID, joinedAt)
	if err != nil {
		slog.Error("sweepStaleVoiceStates: LeaveIfMatch failed",
			"err", err, "user_id", userID, "channel_id", channelID)
		return false
	}
	if !deleted {
		return false
	}
	slog.Warn("sweepStaleVoiceStates: removed ghost voice state",
		"user_id", userID, "channel_id", channelID)
	tailCtx, cancelTail := h.sweepTailCtx(ctx)
	defer cancelTail()
	h.broadcastVoiceEvent(tailCtx, channelID, userID, buildVoiceLeave(channelID, userID))
	// Re-elect the key holder now that this ghost row is gone, as every other
	// participant-removal path does. Otherwise a departed key holder leaves
	// voice_e2ee_offers rejected with NOT_KEY_HOLDER until the next join or leave.
	h.updateKeyHolder(channelID)
	return true
}

// sweepStaleVoiceJoinRaceHook, when non-nil, runs once per stale entry before
// sweepStaleVoiceStates acts on it. Test-only: it pins the window where a
// voice_join's DB commit and its c.voice.setState are not atomic, so a join can
// commit, be snapshotted as a ghost (the joiner's client still shows voiceChID 0)
// and set state only before this loop deletes the row it just committed. Too
// narrow to land with real goroutines.
var sweepStaleVoiceJoinRaceHook func(userID, channelID int64, joinedAt string)

// voiceStillAllowed is the sweep's error-aware re-run of the join gate: it
// separates a genuine refusal (permissions.CanStayInVoice over the live subject:
// the join gate minus the timeout; bit revoked, channel archived or deleted, DM
// membership or block changed) from a DB read failure. The sweep evicts a live
// session on "denied", so a transient read failure must not count as revocation.
// Read live, never via the cached PermissionService: this is the last-line
// backstop, and staying authoritative for a change that bypassed the invalidation
// hooks is worth a handful of reads a minute.
func (h *Hub) voiceStillAllowed(ctx context.Context, userID, channelID int64) (allowed bool, err error) {
	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil {
		return false, err
	}
	if ch == nil {
		return false, nil
	}
	sub, err := channelSubject(ctx, h.readers.Dispatch, h.permChecker, nil, userID, ch, true)
	if err != nil {
		return false, err
	}
	return permissions.CanStayInVoice(sub) == nil, nil
}

// cleanupVoiceRaceClearHook, when non-nil, runs right before CleanupVoiceForChannel
// clears a still-matching client's voice state. Test-only: the window is two
// voiceMu acquisitions with no I/O between them, too narrow to hit with real goroutines.
var cleanupVoiceRaceClearHook func(*Client)

// CleanupVoiceForChannel removes all voice participants from channelID (called
// when a channel is deleted).
func (h *Hub) CleanupVoiceForChannel(channelID int64) {
	// Must complete even if the triggering request goes away.
	ctx := context.Background()
	states, err := h.voice.ChannelStates(ctx, channelID)
	if err != nil {
		slog.Error("CleanupVoiceForChannel ChannelStates", "err", err, "channel_id", channelID)
		return
	}
	if len(states) == 0 {
		return
	}

	// Both the row delete and the client-state clear are conditional on the
	// participant still being in this channel: a user who moved to another voice
	// channel since the snapshot must not be clobbered.
	for _, vs := range states {
		txn := h.begin(vs.UserID)
		// The channel is going away: a token held by a parked entry dies with the row.
		txn.dropParked(channelID)
		if _, err := txn.deleteRow(ctx, channelID, vs.JoinedAt); err != nil {
			slog.Error("CleanupVoiceForChannel LeaveIfMatch", "err", err, "user_id", vs.UserID, "channel_id", channelID)
		}

		// Clear client voice state and its topic subscription. The compare and the clear
		// must be one atomic operation: a getVoiceChID() read then an unconditional clear
		// would wipe a concurrent voice_join to another channel and its subscription.
		// Mirrors handleVoiceLeaveIfStillIn and the webhook's clearExact.
		for _, client := range h.clientsOf(vs.UserID) {
			if cleanupVoiceRaceClearHook != nil {
				cleanupVoiceRaceClearHook(client)
			}
			txn.clearIfChannel(client, channelID)
		}
		txn.end()

		// Remove from LiveKit (best-effort) off this goroutine: the caller is the admin
		// archive/delete request and LiveKit can take seconds. The row and client state
		// are conditional on this exact join instance and the identity carries the join
		// token, so detaching is safe, as in finishVoiceLeave.
		h.removeLiveKitParticipantAsync(ctx, channelID, vs.UserID, vs.JoinedAt, "CleanupVoiceForChannel")
	}

	// Broadcast voice_leave for each participant, resolving the READ audience once.
	// The evicted participants must always be in it (their client state is already
	// cleared, so broadcastVoiceEvent's participant union cannot see them): the
	// voice_leave drives their E2EE teardown, and voice membership can outlive
	// READ_MESSAGES. Both callers commit archived=1 before evicting (so a concurrent
	// voice_join sees the archived gate), so plain channelReadAudience would always
	// return nobody; the ignoring-archived resolver lets bystanders who could see the
	// call a moment ago learn it ended.
	audience := h.channelReadAudienceIgnoringArchived(ctx, channelID)
	seen := make(map[int64]struct{}, len(audience))
	for _, uid := range audience {
		seen[uid] = struct{}{}
	}
	for _, vs := range states {
		if _, ok := seen[vs.UserID]; !ok {
			seen[vs.UserID] = struct{}{}
			audience = append(audience, vs.UserID)
		}
	}
	for _, vs := range states {
		h.broadcastChannelScopedTo(channelID, buildVoiceLeave(channelID, vs.UserID), audience, "voice event")
	}

	// Re-elect the key holder now that the room is torn down, as every removal path
	// does. All client voice states for the channel were cleared, so this deletes the
	// voiceKeyHolders entry (otherwise it lived for the process lifetime). No locks
	// are held, as updateKeyHolder requires.
	h.updateKeyHolder(channelID)
}
