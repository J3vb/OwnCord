package ws

// voice_afk.go — WP 6.10b: the AFK sweep and the AFK move.
//
// A member who has been idle (presence status idle, livePresence.idleSince)
// in a server voice channel for the AFK timeout is moved to the AFK channel.
// The move is the moderator move's shape: a server-side eviction plus a
// client-driven re-join, announced by voice_moved with reason "afk". The
// re-join runs the ordinary join gate, so the sweep runs the same pre-flight
// first and leaves a member where they are when that join would be refused.
// There is no automatic return: the member's own join is user_initiated.

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

// afkMovesPerSweep bounds how many members one sweep moves, so a sweep that
// finds a large idle crowd spreads the LiveKit and broadcast work over
// several ticks.
const afkMovesPerSweep = 25

// afkSweepSnapshotHook, when non-nil, runs after the sweep has snapshotted its
// candidates and before it acts on them. Test-only (always nil in production):
// it holds the window in which a member returns or switches channel.
var afkSweepSnapshotHook func()

// afkCandidate is one idle voice member the sweep may move: the connection it
// saw, the channel it saw it in, and the idle stamp it judged by.
type afkCandidate struct {
	c         *Client
	fromCh    int64
	idleSince time.Time
}

// sweepAFK moves members idle past the AFK timeout to the AFK channel. It is
// started from the 60 s voice ticker (startSweep) and holds nothing between
// members.
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
	moved := 0
	for _, cand := range cands {
		if moved >= afkMovesPerSweep || ctx.Err() != nil {
			return
		}
		if !h.afkMoveAllowed(ctx, afk, cand) {
			continue
		}
		if h.EvictForAFKMove(ctx, cand.c, cand.fromCh, cand.idleSince, afk.ID) {
			moved++
		}
	}
}

// afkTimeout reads the AFK timeout. A missing or unusable stored value is the
// default; a read failure skips the sweep (false), so an unreadable setting
// never moves anyone on a guess.
func (h *Hub) afkTimeout(ctx context.Context) (time.Duration, bool) {
	stored, err := h.settings.Setting(ctx, service.AFKTimeoutKey)
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		slog.Warn("voice afk: sweep read failed", "what", "timeout setting", "err", err)
		return 0, false
	}
	return time.Duration(service.AFKTimeoutSeconds(stored)) * time.Second, true
}

// afkCandidates snapshots, under Hub.mu (R) alone, the clients in a voice
// channel other than afkID whose presence has been idle since cutoff or
// earlier, longest idle first. It reads two leaf fields only (the atomic
// presence pointer and voiceSlot.voiceMu): no I/O under the lock.
func (h *Hub) afkCandidates(afkID int64, cutoff time.Time) []afkCandidate {
	h.mu.RLock()
	var out []afkCandidate
	for _, c := range h.clients {
		ch := c.voice.channel()
		if ch == 0 || ch == afkID {
			continue
		}
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

// afkMoveAllowed is the pre-flight: the source must be a server voice channel
// (a DM or group call is never moved) and the member must be able to join the
// AFK channel themselves, with room in it — the checks the moderator move
// makes (handleVoiceModMoveV2), so a member is not dropped from voice for a
// re-join that would bounce. A refusal leaves the member where they are.
func (h *Hub) afkMoveAllowed(ctx context.Context, afk *db.Channel, cand afkCandidate) bool {
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
	count, err := h.voice.CountInChannel(ctx, afk.ID)
	if err != nil || count >= capacity {
		slog.Debug("voice afk: AFK channel full or unreadable, member left in place", "user_id", userID, "err", err)
		return false
	}
	return true
}

// EvictForAFKMove evicts c from fromCh because it has been idle since
// idleSince, then tells it to re-join the AFK channel afkID. It reports
// whether c was evicted and notified.
//
// Under c's membership lock (Hub.begin, voiceMember, rank 1) it requires that
// c is still the registered connection (a parked or replaced connection is
// never touched, unlike the moderator path's leaveParkedVoice), that its
// presence is still idle with the same idleSince (it came back otherwise), and
// that it is still in fromCh (clearIfChannel); it reads the moderator flags
// from the voice_states row inside the same hold and stashes them, so a prior
// moderator mute survives the move. None of the checks passing leaves nothing
// stashed. After the lock is released it blocks the automatic return to
// fromCh and sends voice_moved; a send that fails (the client is
// reconnecting) clears the stash and leaves the member out of voice.
//
// Lock order: voiceMember, then only the leaves the moderator move already
// takes (Hub.mu (R) in GetClient, PubSub.mu, voiceSlot.voiceMu) and the DB
// read; no lock is added, so lock_order.go is unchanged. voiceMod is NOT
// taken: under voiceMember it would wait behind a LiveKit RPC (user_locks.go).
// The window it would close, a moderator mute committing between the flag read
// and the row delete and being lost, already exists on the moderator move, and
// inside the AFK channel the member cannot publish anyway. No audit row: the
// move is the server's, not a moderator's.
func (h *Hub) EvictForAFKMove(ctx context.Context, c *Client, fromCh int64, idleSince time.Time, afkID int64) bool {
	if !h.afkEvict(ctx, c, fromCh, idleSince) {
		return false
	}
	blockVoiceRejoin(h, c.userID, fromCh)
	if !h.SendToUser(c.userID, buildVoiceMoved(afkID, voiceMovedReasonAFK)) {
		clearPendingModFlags(h, c.userID)
		slog.Info("voice afk move: member was reconnecting, removed from voice instead of moved",
			"user_id", c.userID, "from_channel_id", fromCh)
		return false
	}
	slog.Info("voice afk move", "user_id", c.userID, "from_channel_id", fromCh, "to_channel_id", afkID)
	return true
}

// afkEvict is the membership-locked half of EvictForAFKMove.
func (h *Hub) afkEvict(ctx context.Context, c *Client, fromCh int64, idleSince time.Time) bool {
	txn := h.begin(c.userID)
	defer txn.end()
	if h.GetClient(c.userID) != c {
		return false
	}
	if p := c.presence.Load(); p == nil || p.status != db.StatusIdle || !p.idleSince.Equal(idleSince) {
		return false
	}
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
