package ws

// voice_afk.go: the AFK sweep and the AFK move. A member idle (livePresence.idleSince) in a
// server voice channel for the AFK timeout is moved to the AFK channel: a server-side
// eviction plus a client-driven re-join, announced by voice_moved with reason "afk". The
// re-join runs the ordinary join gate, so the sweep runs the same pre-flight and leaves a
// member in place when that join would be refused. No automatic return: the member's own
// join is user_initiated.

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// afkMovesPerSweep bounds how many members one sweep moves, spreading LiveKit and broadcast work over several
// ticks.
const afkMovesPerSweep = 25

// afkSweepSnapshotHook runs after the sweep snapshotted its candidates and before it acts. Test-only.
var afkSweepSnapshotHook func()

// afkAfterEvictHook runs between a member's eviction and the voice_moved send. Test-only.
var afkAfterEvictHook func()

// isIdleStatus lives here, not in client.go, so client.go keeps using db for its type only.
func isIdleStatus(status string) bool { return status == db.StatusIdle }

// afkCandidate is one idle voice member the sweep may move: the connection and channel it saw, and the idle
// stamp it judged by.
type afkCandidate struct {
	c         *Client
	fromCh    int64
	idleSince time.Time
}

// sweepAFK moves members idle past the AFK timeout to the AFK channel, from the 60 s voice ticker; it holds
// nothing between members.
func (h *Hub) sweepAFK(ctx context.Context) {
	afk, err := h.readers.Dispatch.GetAFKChannel(ctx)
	if err != nil {
		slog.Warn("voice afk: sweep read failed", "what", "afk channel", "err", err)
		return
	}
	if afk == nil || afk.Archived || afk.Type != "voice" {
		return
	}
	timeout, ok := h.afkTimeout(ctx)
	if !ok {
		return
	}
	cands := h.afkCandidates(afk.ID, afkNow().Add(-timeout))
	if len(cands) == 0 {
		return
	}
	if afkSweepSnapshotHook != nil {
		afkSweepSnapshotHook()
	}
	quota := afkQuota{}
	moved := 0
	for _, cand := range cands {
		if moved >= afkMovesPerSweep || ctx.Err() != nil {
			return
		}
		if !h.afkStillTarget(ctx, afk.ID) {
			return
		}
		if !h.afkMoveAllowed(ctx, afk, cand, &quota) {
			continue
		}
		if h.EvictForAFKMove(ctx, cand.c, cand.fromCh, cand.idleSince, afk.ID) {
			moved++
			quota.reserved++
		}
	}
}

// afkQuota tracks the AFK channel's room across one sweep: the count is read once and each
// eviction reserved on top, so members who re-join meanwhile are never counted twice.
type afkQuota struct {
	count    int
	haveRead bool
	reserved int
}

// afkStillTarget reports whether the AFK channel is still afkID and a live voice channel,
// so unsetting, replacing or archiving it mid-sweep stops further evictions.
func (h *Hub) afkStillTarget(ctx context.Context, afkID int64) bool {
	cur, err := h.readers.Dispatch.GetAFKChannel(ctx)
	return err == nil && cur != nil && cur.ID == afkID && !cur.Archived && cur.Type == "voice"
}

// afkTimeout reads the AFK timeout; a missing or unusable value is the default. A read
// failure skips the sweep, so an unreadable setting never moves anyone on a guess.
func (h *Hub) afkTimeout(ctx context.Context) (time.Duration, bool) {
	stored, err := h.settings.cache.Reader().Setting(ctx, service.AFKTimeoutKey)
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		slog.Warn("voice afk: sweep read failed", "what", "timeout setting", "err", err)
		return 0, false
	}
	return time.Duration(service.AFKTimeoutSeconds(stored)) * time.Second, true
}

// afkCandidates snapshots, under Hub.mu (R) alone, clients in a voice channel other than
// afkID idle since cutoff, longest idle first. It reads two leaf fields only (atomic
// presence pointer, voiceSlot.voiceMu): no I/O under the lock.
func (h *Hub) afkCandidates(afkID int64, cutoff time.Time) []afkCandidate {
	h.mu.RLock()
	var out []afkCandidate
	for _, c := range h.allClientsLocked() {
		ch := c.voice.channel()
		if ch == 0 || ch == afkID {
			continue
		}
		// AFK is judged on the connection holding the call: another device's activity must not move (or keep)
		// it.
		p := c.presence.Load()
		if p == nil || p.status != db.StatusIdle || p.idleSince.IsZero() || p.idleSince.After(cutoff) {
			continue
		}
		out = append(out, afkCandidate{c: c, fromCh: ch, idleSince: p.idleSince})
	}
	h.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].idleSince.Before(out[j].idleSince) })
	return out
}

// afkMoveAllowed is the pre-flight: the source must be a server voice channel (never a DM
// or group call) and the member must be able to join the AFK channel with room in it (the
// handleVoiceModMoveV2 checks), so nobody is dropped for a re-join that would bounce.
// quota carries the room left across the sweep.
func (h *Hub) afkMoveAllowed(ctx context.Context, afk *db.Channel, cand afkCandidate, quota *afkQuota) bool {
	userID := cand.c.userID
	src, err := h.readers.Dispatch.GetChannel(ctx, cand.fromCh)
	if err != nil || src == nil || src.Type != "voice" {
		return false
	}
	sub, err := channelSubject(ctx, h.readers.Dispatch, h.permChecker, h.perms, userID, afk, true)
	if err != nil {
		slog.Debug("voice afk: permission lookup failed, member left in place", "user_id", userID, "err", err)
		return false
	}
	if joinErr := permissions.CanJoinVoice(sub); joinErr != nil {
		slog.Debug("voice afk: member cannot join the AFK channel, left in place", "user_id", userID, "reason", joinErr)
		return false
	}
	capacity := voiceJoinCapacity(sub, afk.VoiceMaxUsers)
	if capacity <= 0 {
		return true
	}
	// A member moved earlier joins the AFK channel only once its client answers voice_moved, so
	// each move is reserved on top of a single count read.
	if !quota.haveRead {
		count, err := h.voice.CountInChannel(ctx, afk.ID)
		if err != nil {
			slog.Debug("voice afk: AFK channel count unreadable, member left in place", "user_id", userID, "err", err)
			return false
		}
		quota.count, quota.haveRead = count, true
	}
	if quota.count+quota.reserved >= capacity {
		slog.Debug("voice afk: AFK channel full, member left in place", "user_id", userID)
		return false
	}
	return true
}

// EvictForAFKMove evicts c from fromCh because it has been idle since idleSince, then tells
// it to re-join afkID. Reports whether c was evicted: true also when the voice_moved send
// was refused, since the cost is paid and counts toward the sweep's limit. Under c's
// membership lock (Hub.begin, voiceMember, rank 1) it requires c to be still the registered
// connection (a parked or replaced one is never touched), still idle with the same
// idleSince, and still in fromCh (clearIfChannel); it reads the moderator flags from the
// row in the same hold and stashes them so a prior moderator mute survives. After unlock it
// blocks the automatic return and sends voice_moved; a failed send (client reconnecting)
// clears the stash and leaves the member out of voice. Lock order: voiceMember, then only
// the leaves the moderator move takes (Hub.mu (R), PubSub.mu, voiceSlot.voiceMu) and the DB
// read, plus a TRY-lock of voiceHub.mod, which follows voiceMember. Never waited for: a
// blocking take under voiceMember would sit behind a LiveKit RPC (voicestate/userlocks.go).
// Held across the flag read and row delete it stops a moderator mute committing between the
// two; when moderation is in flight the candidate is skipped and the next tick retries. No
// audit row: the move is the server's.
func (h *Hub) EvictForAFKMove(ctx context.Context, c *Client, fromCh int64, idleSince time.Time, afkID int64) bool {
	if !h.afkEvict(ctx, c, fromCh, idleSince) {
		return false
	}
	blockVoiceRejoin(h, c.userID, fromCh)
	if afkAfterEvictHook != nil {
		afkAfterEvictHook()
	}
	// A move never asks for the AFK channel's password: the grant is stored now, and a failure leaves the
	// member out of voice like a failed send.
	gErr := grantPasswordForMove(ctx, h.readers.Dispatch, afkID, c.userID)
	if gErr != nil {
		slog.Warn("voice afk: granting the AFK channel password failed, member removed from voice instead of moved", "user_id", c.userID, "err", gErr)
	}
	if gErr != nil || !c.trySendMsg(buildVoiceMoved(afkID, voiceMovedReasonAFK, 0)) {
		clearPendingModFlags(h, c.userID)
		slog.Info("voice afk move: member was reconnecting, removed from voice instead of moved",
			"user_id", c.userID, "from_channel_id", fromCh)
		return true
	}
	slog.Info("voice afk move", "user_id", c.userID, "from_channel_id", fromCh, "to_channel_id", afkID)
	return true
}

func (h *Hub) afkEvict(ctx context.Context, c *Client, fromCh int64, idleSince time.Time) bool {
	txn := h.begin(c.userID)
	defer txn.end()
	if !h.isRegistered(c) {
		return false
	}
	if p := c.presence.Load(); p == nil || p.status != db.StatusIdle || !p.idleSince.Equal(idleSince) {
		return false
	}
	unlockMod, ok := h.voiceHub.mod.TryLock(c.userID)
	if !ok {
		return false
	}
	defer unlockMod()
	var flags modFlagStash
	state, err := h.voice.State(ctx, c.userID)
	if err != nil {
		slog.Warn("voice afk: sweep read failed", "what", "voice state", "user_id", c.userID, "err", err)
		return false
	}
	if state != nil && state.ChannelID == fromCh {
		flags = modFlagStash{muted: state.ServerMuted, deafened: state.ServerDeafened, mutedBy: state.ServerMutedBy}
	}
	return h.evictAndStash(ctx, txn, c, fromCh, flags, voiceLeaveReasonAFK)
}
