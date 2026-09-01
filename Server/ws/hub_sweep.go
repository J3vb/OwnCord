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

// staleClientTimeout is the maximum duration a client can go without sending
// any message before being considered stale and disconnected. The client sends
// a ping every 30s, so 90s (3x) gives plenty of margin.
const staleClientTimeout = 90 * time.Second

// onStaleTick runs the cheap in-memory maintenance driven by the stale ticker.
func (h *Hub) onStaleTick() {
	h.sweepStaleClients()
	// Per-channel token buckets are created on first broadcast; prune idle
	// ones here or the bucket map grows for the process lifetime.
	h.topicLimiter.Cleanup(10 * time.Minute)
	h.refreshTelemetryGauges()
}

// refreshTelemetryGauges recomputes the connection and voice gauges from live
// client state. Periodic (30s tick, driven by the ctx-less Run loop) rather
// than event-driven: join/leave and register/unregister paths are spread
// across handlers, sweeps, and webhooks — many of them request-scoped, where
// a context.Background() instrumentation call would trip contextcheck — and a
// gauge only needs to be right at scrape time.
func (h *Hub) refreshTelemetryGauges() {
	participants := 0
	rooms := make(map[int64]struct{})
	h.mu.RLock()
	connected := len(h.clients)
	for _, c := range h.clients {
		if chID := c.getVoiceChID(); chID != 0 {
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

// kickClient forcibly removes a client from the hub and closes its send channel,
// which causes writePump to exit and the WebSocket connection to close.
// It is safe to call from any goroutine.
func (h *Hub) kickClient(c *Client) {
	h.mu.Lock()
	if current, ok := h.clients[c.userID]; ok && current == c {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()
	// closeSend BEFORE UnsubscribeAll: Subscribe's only re-take guard is
	// isSendClosed, so a Subscribe racing this kick either lands before the
	// close (and UnsubscribeAll below removes it) or sees the closed channel
	// and refuses. The reverse order leaves the dead client holding the topic.
	c.closeSend()
	h.pubsub.UnsubscribeAll(c)
}

// startSweep runs sweep on its own goroutine so the hub dispatch loop never
// blocks on the DB-heavy periodic sweeps (they already lock correctly for
// concurrent execution with the hub). inFlight guarantees a sweep never runs
// concurrently with itself: a tick arriving while the previous run is still
// going is dropped, and the next tick retries.
func (h *Hub) startSweep(inFlight *atomic.Bool, sweep func()) {
	if !inFlight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer inFlight.Store(false)
		sweep()
	}()
}

// sweepStaleClients iterates over all connected clients and kicks any that
// have not sent a message within staleClientTimeout.
func (h *Hub) sweepStaleClients() {
	now := time.Now()
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.clients {
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

// sweepRevokedSessions iterates all connected clients and kicks any whose
// session has been deleted, expired, or whose user has been banned. This
// provides time-based session enforcement for idle WebSocket connections
// that never trigger the message-count-based check (BUG-109).
func (h *Hub) sweepRevokedSessions() {
	// Hub run-loop sweeper — no request tie.
	ctx := context.Background()

	h.mu.RLock()
	snapshot := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.tokenHash != "" {
			snapshot = append(snapshot, c)
		}
	}
	h.mu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	// One batched lookup for every connected client instead of a query per
	// client per sweep. The expiry and ban rules behind the verdicts are
	// AuthService's — the same ones the handshake applies — so a live session
	// and a resuming one cannot disagree about what "still valid" means.
	hashes := make([]string, len(snapshot))
	for i, c := range snapshot {
		hashes[i] = c.tokenHash
	}
	verdicts, err := h.authn.SweepSessions(ctx, hashes)
	if err != nil {
		// A failed batch lookup says nothing about any individual session —
		// kicking everyone on a transient DB error would be a mass disconnect.
		// Skip this sweep; the next tick retries.
		slog.Warn("session sweep: batch session lookup failed", "err", err)
		return
	}

	for _, c := range snapshot {
		// A hash the authenticator did not answer for reads as the map's
		// zero value, which is SessionRevoked by design: fail closed.
		switch verdicts[c.tokenHash] {
		case service.SessionRevoked:
			slog.Info("session sweep: revoked/expired session, disconnecting",
				"user_id", c.userID)
			h.kickClient(c)
		case service.SessionBanned:
			slog.Info("session sweep: banned user, disconnecting",
				"user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
		case service.SessionLive:
		}
	}
}

// sweepStaleVoiceEvictRevoked is sweepStaleVoiceStates' permission stage: it
// re-checks CONNECT_VOICE for every client currently in voice and evicts the
// ones who no longer hold it.
func (h *Hub) sweepStaleVoiceEvictRevoked(ctx context.Context) {
	// Revocation must evict a live session, not merely block the next join.
	// Nothing else in ws re-validates voice permissions for a connection that
	// stays open, so a user stripped of CONNECT_VOICE kept their SFU session
	// until they disconnected. Checked once a minute, and only for the handful
	// of clients actually in voice.
	h.mu.RLock()
	inVoice := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.getVoiceChID() != 0 {
			inVoice = append(inVoice, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range inVoice {
		chID := c.getVoiceChID()
		if chID == 0 {
			continue
		}
		allowed, err := h.voiceStillAllowed(ctx, c.userID, chID)
		if err != nil {
			// A transient read failure (I/O error, lock contention, a
			// maintenance window) is not a revocation — hasChannelAccess and
			// permissions.Checker.HasChannelPerm both collapse any DB error
			// to "denied", which would otherwise evict every in-voice
			// participant on one bad read. Skip this client this tick; the
			// next tick retries. Mirrors sweepRevokedSessions' guard on its
			// own batch lookup below.
			slog.Warn("sweepStaleVoiceStates: permission check failed, skipping this tick",
				"user_id", c.userID, "channel_id", chID, "err", err)
			continue
		}
		if allowed {
			continue
		}
		// The permission check is a DB round-trip; a voice_join to a
		// still-permitted channel may have committed while it ran. The
		// eviction is conditional on the client still being in the checked
		// channel — never on whatever channel it is in by now.
		if !h.handleVoiceLeaveIfStillIn(ctx, c, chID) {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: evicted participant whose CONNECT_VOICE was revoked",
			"user_id", c.userID, "channel_id", chID)
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing CONNECT_VOICE permission"))
	}
}

// sweepStaleVoiceStates queries all voice_states rows and removes any that
// don't match a connected client's voiceChID. This catches ghost users that
// slip through the primary cleanup paths (registerNow, readPump defer,
// LiveKit webhook).
func (h *Hub) sweepStaleVoiceStates() {
	// Hub run-loop sweeper — no request tie.
	ctx := context.Background()

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
		c, ok := h.clients[vs.UserID]
		if !ok || c.getVoiceChID() != vs.ChannelID {
			stale = append(stale, struct {
				userID    int64
				channelID int64
				joinedAt  string
			}{vs.UserID, vs.ChannelID, vs.JoinedAt})
		}
	}
	h.mu.RUnlock()

	for _, s := range stale {
		if sweepStaleVoiceJoinRaceHook != nil {
			sweepStaleVoiceJoinRaceHook(s.userID, s.channelID, s.joinedAt)
		}

		// Re-check the live client immediately before deleting (OC-0017).
		// voice_join.go commits the row before it calls c.setVoiceState
		// (BUG-088's ordering), so a join can commit and get snapshotted as a
		// ghost above — with c.setVoiceState landing after that snapshot but
		// before this delete runs. If the client's current voice state now
		// agrees with the row we are about to delete, the join has caught up
		// and this is no longer stale: deleting it would leave the client
		// "in voice" in memory with no DB row, the one ghost state nothing
		// else heals.
		h.mu.RLock()
		liveClient, liveOK := h.clients[s.userID]
		h.mu.RUnlock()
		if liveOK {
			if liveChID, liveJoinedAt := liveClient.getVoiceState(); liveChID == s.channelID && liveJoinedAt == s.joinedAt {
				continue
			}
		}

		// Channel-conditional delete: only removes the row if it still points
		// at the channel we snapshotted. If the user rejoined or moved between
		// the snapshot and now, the delete is a no-op and we skip the broadcast.
		deleted, err := h.voice.LeaveIfMatch(ctx, s.userID, s.channelID, s.joinedAt)
		if err != nil {
			slog.Error("sweepStaleVoiceStates: LeaveIfMatch failed",
				"err", err, "user_id", s.userID, "channel_id", s.channelID)
			continue
		}
		if !deleted {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: removed ghost voice state",
			"user_id", s.userID, "channel_id", s.channelID)
		h.broadcastVoiceEvent(ctx, s.channelID, buildVoiceLeave(s.channelID, s.userID))
		// Re-elect the key holder now that this ghost row is gone — every
		// other path that removes a voice participant does this
		// (finishVoiceLeave, the LiveKit webhook, registerNow,
		// handleVoiceJoin). Without it, a departed user stripped out here
		// while still named as key holder leaves the remaining lowest-uid
		// participant self-promoting and rotating the room key locally, and
		// its voice_e2ee_offers are rejected with NOT_KEY_HOLDER until the
		// next join/leave in the channel. No locks are held here, matching
		// the webhook call site.
		h.updateKeyHolder(s.channelID)
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(ctx, s.channelID, s.userID, s.joinedAt)
		}
	}
}

// sweepStaleVoiceJoinRaceHook, when non-nil, runs once per stale entry,
// immediately before sweepStaleVoiceStates acts on it. Test-only (always nil
// in production): it pins the BUG-088 follow-on window (OC-0017) where a
// voice_join's DB commit (voice_join.go's JoinVoiceChannelIfCapacity) and its
// c.setVoiceState call are not atomic — a join can commit its row, get
// snapshotted as a ghost by the h.clients scan above (the joiner's client
// still shows voiceChID 0 at that instant), and only call c.setVoiceState
// after the snapshot but before this loop deletes the row it just committed.
// Too narrow a window to land reliably by staggering real goroutines, so
// tests use this hook to reproduce it deterministically.
var sweepStaleVoiceJoinRaceHook func(userID, channelID int64, joinedAt string)

// voiceStillAllowed is the sweep's error-aware re-run of the join gate: it
// distinguishes a genuine refusal (permissions.CanJoinVoice over the live
// subject — the bit revoked, the channel archived or deleted, DM membership
// or block state changed) from a DB read failure. sweepStaleVoiceStates
// needs that distinction: unlike a handler answering one client's request,
// it evicts a live voice session on "denied", so a transient read failure
// must not be treated as a revocation. Deliberately read live, never through
// the cached PermissionService: this is the last-line backstop, and staying
// authoritative for a change that somehow bypassed the invalidation hooks is
// worth the handful of reads a minute it costs for the clients in voice.
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
	return permissions.CanJoinVoice(sub) == nil, nil
}

// cleanupVoiceRaceClearHook, when non-nil, runs immediately before
// CleanupVoiceForChannel clears a still-matching client's voice state.
// Test-only (always nil in production): the window it pins is two separate
// voiceMu acquisitions with no I/O between them, too narrow to land reliably
// by staggering real goroutines, so tests use this hook to reproduce a
// voice_join racing in at exactly that point deterministically.
var cleanupVoiceRaceClearHook func(*Client)

// CleanupVoiceForChannel removes all voice participants from the given channel.
// Called when a channel is deleted.
func (h *Hub) CleanupVoiceForChannel(channelID int64) {
	// Cleanup must complete even if the triggering request goes away.
	ctx := context.Background()
	// Get all users in the channel's voice state from DB.
	states, err := h.voice.ChannelStates(ctx, channelID)
	if err != nil {
		slog.Error("CleanupVoiceForChannel ChannelStates", "err", err, "channel_id", channelID)
		return
	}
	if len(states) == 0 {
		return
	}

	// Clean up DB state and LiveKit for each participant. Both the row delete
	// and the client-state clear are conditional on the participant still
	// being in THIS channel: a user who moved to another voice channel
	// between the snapshot above and this loop must not be clobbered.
	for _, vs := range states {
		if _, err := h.voice.LeaveIfMatch(ctx, vs.UserID, channelID, vs.JoinedAt); err != nil {
			slog.Error("CleanupVoiceForChannel LeaveIfMatch", "err", err, "user_id", vs.UserID, "channel_id", channelID)
		}

		// Clear client voice state and its voice-topic subscription. The
		// compare (still in this channel?) and the clear must be one atomic
		// operation — a getVoiceChID() read followed by a separate
		// unconditional clear leaves a window where a concurrent voice_join
		// to another channel commits in between and gets silently wiped
		// along with its own voice-topic subscription (OC-0050). Mirrors
		// sweepStaleVoiceStates' handleVoiceLeaveIfStillIn /
		// clearVoiceStateIfMatch and the LiveKit webhook's inline
		// compare-and-clear.
		h.mu.RLock()
		client, ok := h.clients[vs.UserID]
		h.mu.RUnlock()
		if ok {
			if cleanupVoiceRaceClearHook != nil {
				cleanupVoiceRaceClearHook(client)
			}
			if _, cleared := client.clearVoiceStateIfMatch(channelID); cleared {
				h.pubsub.Unsubscribe(client, VoiceTopic(channelID))
			}
		}

		// Remove from LiveKit (best-effort).
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(ctx, channelID, vs.UserID, vs.JoinedAt)
		}
	}

	// Broadcast voice_leave for each participant. All leaves target the same
	// channel, so resolve the READ audience once and reuse it per message.
	// The evicted participants themselves must always be in it (their client
	// state is already cleared, so broadcastVoiceEvent's participant union
	// cannot see them): the voice_leave is what drives their own E2EE
	// teardown, and voice membership never required READ_MESSAGES.
	//
	// Both callers of CleanupVoiceForChannel commit archived=1 to this
	// channel before evicting (OC-0022) — deliberately, so a concurrent
	// voice_join sees the archived gate — which means plain
	// channelReadAudience always finds the channel already archived and
	// always returns nobody here. Use the ignoring-archived resolver so the
	// bystanders who could see this channel and its voice roster a moment
	// ago still learn the call ended, not just the evicted participants.
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

	// Re-elect the key holder now that the room is torn down — every other
	// removal path does this (finishVoiceLeave, the LiveKit webhook,
	// registerNow, rollbackVoiceJoin, sweepStaleVoiceStates). All client
	// voice states for this channel were cleared above, so this deletes the
	// voiceKeyHolders entry; without it a deleted channel's entry lived for
	// the process lifetime (OC-0012). No locks are held here, as
	// updateKeyHolder requires.
	h.updateKeyHolder(channelID)
}
