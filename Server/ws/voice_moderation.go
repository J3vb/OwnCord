package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Voice moderation handlers: server mute, server deafen, move, disconnect.
//
// Mute, deafen and disconnect share one contract (voiceModTarget): MUTE_MEMBERS on
// the actor's role (Administrator bypasses), the actor must strictly outrank the
// target by role position (as ModerationService.requireOutranks), and the target
// must be in a voice channel. Move has its own bit, MOVE_MEMBERS, with no rank
// rule, and is the only way to move; the owner is skipped while the owner-only
// voice_owner_movable setting is off. Effects beyond the acting connection (the
// SFU, the target's socket) go through VoiceDeps.Mod.

// registerVoiceModerationV2 registers the four moderator voice commands.
func registerVoiceModerationV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceModMute, handleVoiceModMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceModDeafen, handleVoiceModDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceModMove, handleVoiceModMoveV2, deps)
	r.RegisterV2(MsgTypeVoiceModKick, handleVoiceModKickV2, deps)
}

// voiceModRole loads the member's effective role (top identity, OR of every held
// mask) through the permission cache when wired, else the live DB. Every failure
// is a denial: an unresolvable role must never authorize a moderation action.
func voiceModRole(ctx context.Context, d VoiceDeps, userID int64) (*db.Role, bool) {
	if d.PermSvc != nil {
		role, err := d.PermSvc.GetRoleForUser(ctx, userID)
		if err == nil && role != nil {
			return role.Effective(), true
		}
		return nil, false
	}
	if d.Reader == nil {
		return nil, false
	}
	role, err := d.Reader.GetMemberRoles(ctx, userID)
	if err != nil || role == nil {
		return nil, false
	}
	return role.Effective(), true
}

// voiceModRateLimited applies the shared per-action rate limit: each command fans
// a voice_state broadcast out to every client that can see the channel.
func voiceModRateLimited(d VoiceDeps, action string, userID int64) *Result {
	if d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key(action, userID), voiceModRateLimit, voiceModWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many voice moderation actions"}}
}

// requireTargetInChannel refuses when the target has moved on since the moderator's
// client rendered the row.
func requireTargetInChannel(state *db.VoiceState, channelID int64) *Result {
	if state.ChannelID == channelID {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
}

// voiceChannelDisconnector is the channel-scoped form of
// VoiceModerator.DisconnectFromVoice. The bare method takes no channel and evicts
// the target from whatever channel their connection is in at that instant, so a
// channel switch on the target's read-pump racing the moderator's DB round trips
// could redirect a kick or move onto a channel that was never checked, even a DM
// call the actor is not part of (what voiceModTarget's IsDMParticipant guard
// refuses). *Hub satisfies this optional extension and disconnectFromVoiceIn
// prefers it, falling back to the unscoped method for other implementations.
type voiceChannelDisconnector interface {
	DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool
}

// The production moderator must keep satisfying it: a silently failing type
// assertion would fall back to the unscoped method with nothing failing.
var _ voiceChannelDisconnector = (*Hub)(nil)

// voiceServerMuteLocker routes the manual voice_mod_mute onto the same per-user
// lock the timeout voice half uses. *Hub satisfies this optional extension; a Mod
// without it (a hand-built test double) falls back to an unlocked write.
type voiceServerMuteLocker interface {
	SetServerMuteLocked(ctx context.Context, userID, channelID int64, muted bool) (matched bool, joinedAt string, err error)
}

// The production moderator must keep satisfying it, or a manual mute would
// silently fall back to the unlocked write.
var _ voiceServerMuteLocker = (*Hub)(nil)

// disconnectFromVoiceIn evicts targetID from channelID, reporting false when the
// target has no connection on this node or already left that channel.
func disconnectFromVoiceIn(ctx context.Context, mod VoiceModerator, targetID, channelID int64) bool {
	if scoped, ok := mod.(voiceChannelDisconnector); ok {
		return scoped.DisconnectFromVoiceInChannel(ctx, targetID, channelID, voiceLeaveReasonModerator)
	}
	return mod.DisconnectFromVoice(ctx, targetID)
}

// voicePendingModFlagsSetter lets a server-driven leave (voice_mod_move) stash a
// moderator-imposed mute/deafen on the target's in-memory connection before the
// delete erases the voice_states row they normally live in. voiceJoinLeaveCurrent
// takes the stash back out when no row is left (currentChID == 0) and re-applies it
// as for a self-initiated switch: one guard in the shared consumer instead of a
// divergent restore path here. *Hub satisfies this optional extension.
type voicePendingModFlagsSetter interface {
	SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool
}

// The production moderator must keep satisfying it, or a server-driven move would
// silently drop the stashed flags.
var _ voicePendingModFlagsSetter = (*Hub)(nil)

// stashPendingModFlags is a best-effort no-op when mod lacks the extension or the
// target has no connection on this node; the eviction proceeds either way, so a
// missing implementation loses only the preservation. serverMutedBy carries a
// timeout's ownership through the stash as voiceJoinLeaveCurrent's snapshot does.
func stashPendingModFlags(mod VoiceModerator, targetID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) {
	if !serverMuted && !serverDeafened {
		return
	}
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, serverMuted, serverDeafened, serverMutedBy)
	}
}

// clearPendingModFlags unconditionally wipes any stash. It cannot early-return on
// "both false" (false/false is the clear), so it calls the setter directly. Used
// when a move that stashed flags turns out not to have evicted anyone: otherwise a
// refused move leaves an unexpiring stash that the target's next unrelated
// voice_join would re-apply as a mute/deafen nobody ordered.
func clearPendingModFlags(mod VoiceModerator, targetID int64) {
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, false, false, nil)
	}
}

// handleVoiceModMuteV2 processes voice_mod_mute. The DB row is the authority for
// the UI; SFU permissions enforce the microphone restriction. A failed media
// update leaves the desired state for reconciliation and tells the moderator
// enforcement has not completed.
func handleVoiceModMuteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModMuteCmd)

	if r := voiceModRateLimited(d, "voice_mod_mute", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID)
	if r != nil {
		return *r
	}
	if r := requireTargetInChannel(state, c.ChannelID); r != nil {
		return *r
	}

	// The DB write and its paired SFU call run under the timeout path's per-user lock
	// when a locking Mod is wired (production always wires one); Mod-less test deps
	// fall back to the unlocked, SFU-less write.
	var matched bool
	var err error
	if locker, ok := d.Mod.(voiceServerMuteLocker); ok {
		matched, _, err = locker.SetServerMuteLocked(ctx, c.TargetID, state.ChannelID, c.Muted)
	} else {
		matched, err = d.Voice.SetServerMute(ctx, c.TargetID, state.ChannelID, c.Muted)
	}
	if err != nil {
		slog.Error("ws handleVoiceModMuteV2 SetServerMute", "err", err, "target_id", c.TargetID)
		if errors.Is(err, errVoiceMediaPending) {
			writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_mute", c.TargetID,
				fmt.Sprintf("server mute %s in channel %d; media update pending", onOff(c.Muted), state.ChannelID))
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "server mute saved, but the media update failed; please retry"}}
		}
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server mute"}}
	}
	if !matched {
		// The target's row moved off state.ChannelID between requireTargetInChannel's
		// snapshot and this write: same refusal, so the write never follows the target
		// onto a channel (including a DM call) nobody authorized it against.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_mute", c.TargetID,
		fmt.Sprintf("server mute %s in channel %d", onOff(c.Muted), state.ChannelID))
	slog.Info("voice server mute", "actor_id", info.UserID, "target_id", c.TargetID,
		"channel_id", state.ChannelID, "muted", c.Muted)

	return voiceStateBroadcast(ctx, d, c.TargetID)
}

// voiceModDeafenPreMuteRaceHook, when non-nil, runs right after the deafen write
// matches and before the implied-mute write: the one-statement window a concurrent
// channel switch would need. Test-only.
var voiceModDeafenPreMuteRaceHook func(ctx context.Context, d VoiceDeps, targetID int64)

// handleVoiceModDeafenV2 processes voice_mod_deafen. Deafen has no SFU equivalent
// (it is about playback), so it is enforced by the target's client honoring
// server_deafened plus the server refusing their own undeafen while set.
func handleVoiceModDeafenV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModDeafenCmd)

	if r := voiceModRateLimited(d, "voice_mod_deafen", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID)
	if r != nil {
		return *r
	}
	if r := requireTargetInChannel(state, c.ChannelID); r != nil {
		return *r
	}

	deafenMatched, err := d.Voice.SetServerDeafen(ctx, c.TargetID, state.ChannelID, c.Deafened)
	if err != nil {
		slog.Error("ws handleVoiceModDeafenV2 SetServerDeafen", "err", err, "target_id", c.TargetID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server deafen"}}
	}
	if !deafenMatched {
		// The target's row moved off state.ChannelID since requireTargetInChannel: refuse
		// before the implied mute below can touch a channel nobody authorized.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}
	if voiceModDeafenPreMuteRaceHook != nil {
		voiceModDeafenPreMuteRaceHook(ctx, d, c.TargetID)
	}
	// A server deafen implies a server mute at the SFU: a deafened user must not keep
	// talking into a room they cannot hear. Lifting the deafen must lift that mute
	// too, or the target stays SFU-muted and refused their own unmute. server_muted is
	// a single bool that cannot tell explicit from deafen-implied, so an
	// explicit-mute-then-deafen sequence has both lifted by an undeafen (accepted given
	// the schema). The implied mute's DB write and SFU call run under the same
	// per-user lock as the manual mute (SetServerMuteLocked), so it cannot interleave
	// with a timeout's mute/unmute for the same target. Unlocked fallback only for
	// Mod-less test deps.
	var muteMatched bool
	if locker, ok := d.Mod.(voiceServerMuteLocker); ok {
		muteMatched, _, err = locker.SetServerMuteLocked(ctx, c.TargetID, state.ChannelID, c.Deafened)
	} else {
		muteMatched, err = d.Voice.SetServerMute(ctx, c.TargetID, state.ChannelID, c.Deafened)
	}
	if err != nil || !muteMatched {
		if err != nil {
			slog.Error("ws handleVoiceModDeafenV2 SetServerMute", "err", err, "target_id", c.TargetID)
		}
		if errors.Is(err, errVoiceMediaPending) {
			// Both desired flags were saved; keep them together so a retry or periodic
			// reconciliation can finish the media update.
			writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_deafen", c.TargetID,
				fmt.Sprintf("server deafen %s in channel %d; media update pending", onOff(c.Deafened), state.ChannelID))
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "server deafen saved, but the media update failed; please retry"}}
		}
		d.Voice.RollbackServerDeafen(ctx, c.TargetID, state.ChannelID, c.Deafened)
		if err != nil {
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server deafen"}}
		}
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_deafen", c.TargetID,
		fmt.Sprintf("server deafen %s in channel %d", onOff(c.Deafened), state.ChannelID))
	slog.Info("voice server deafen", "actor_id", info.UserID, "target_id", c.TargetID,
		"channel_id", state.ChannelID, "deafened", c.Deafened)

	return voiceStateBroadcast(ctx, d, c.TargetID)
}

// handleVoiceModMoveV2 processes voice_mod_move.
//
// The move is a server-driven leave followed by a client-driven re-join: the hub
// runs its voice-leave routine for the target (DB row, LiveKit participant,
// voice_leave broadcast), then sends voice_moved and the target's client answers
// with an ordinary voice_join. That keeps one implementation of the join sequence
// (capacity, token, key-holder election, state fan-out). The checks below are
// pre-flight, refusing a move the re-join would only bounce so the target is never
// dropped from voice for nothing.
func handleVoiceModMoveV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModMoveCmd)

	if r := voiceModRateLimited(d, "voice_mod_move", info.UserID); r != nil {
		return *r
	}
	state, bypass, r := voiceModAuthorize(ctx, d, info.UserID, c.TargetID, voiceModKindMove)
	if r != nil {
		return *r
	}
	if state.ChannelID == c.ToChannelID {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "user is already in that voice channel"}}
	}

	dest, err := d.Reader.GetChannel(ctx, c.ToChannelID)
	if err != nil {
		slog.Error("ws handleVoiceModMoveV2 GetChannel", "err", err, "channel_id", c.ToChannelID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read destination channel"}}
	}
	if dest == nil {
		return Result{Error: ClientError{Code: ErrCodeNotFound, Message: "channel not found"}}
	}
	if r := requireMoverCanSee(ctx, d, info.UserID, dest); r != nil {
		return *r
	}
	if dest.Type != "voice" {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "destination is not a voice channel"}}
	}
	// Gate the destination on the target's access with the same predicate the
	// re-join (handleVoiceJoin) applies, permissions.CanJoinVoice, so a move can
	// neither place someone in a channel they could not join nor commit the
	// destructive half for a re-join guaranteed to bounce (an archived channel).
	targetSub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, c.TargetID, dest, false)
	if subErr != nil {
		slog.Error("ws handleVoiceModMoveV2 channelSubject", "err", subErr, "channel_id", c.ToChannelID)
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check destination access"}}
	}
	switch joinErr := permissions.CanJoinVoice(targetSub); {
	case errors.Is(joinErr, permissions.ErrArchived):
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "channel is archived"}}
	case joinErr != nil:
		return Result{Error: ClientError{
			Code:    ErrCodeForbidden,
			Message: "user cannot connect to that voice channel",
		}}
	}
	// Advisory capacity check with JoinVoiceChannelIfCapacity's semantics; the atomic
	// one still runs on the re-join. This keeps the common case from dropping the
	// target into a full channel. The cap is the one the target's own re-join is held
	// to, so a target who moderates voice there is not refused.
	if destCap := voiceJoinCapacity(targetSub, dest.VoiceMaxUsers); destCap > 0 {
		count, cErr := d.Voice.CountInChannel(ctx, c.ToChannelID)
		if cErr != nil {
			slog.Error("ws handleVoiceModMoveV2 CountInChannel", "err", cErr, "channel_id", c.ToChannelID)
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check channel capacity"}}
		}
		if count >= destCap {
			return Result{Error: ClientError{Code: ErrCodeChannelFull, Message: "voice channel is full"}}
		}
	}

	if d.Mod == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice moderation unavailable"}}
	}
	if r := voiceModMoveTargetLimited(d, bypass, c.TargetID); r != nil {
		return *r
	}
	// Evict the target and, in the same membership transaction, stash their
	// server_muted/server_deafened (loaded by voiceModTarget) on their live connection:
	// the disconnect deletes the voice_states row those flags live in
	// (voiceMoveEvictor). The target's re-join has no row left to read and takes the
	// stash back out.
	if !evictForMove(ctx, d.Mod, c.TargetID, state.ChannelID, state.ServerMuted, state.ServerDeafened, state.ServerMutedBy) {
		// Nobody was evicted: no live connection on this node (the row is a ghost the
		// sweeper owns), or the target left the checked channel meanwhile and the move
		// must not follow them. evictForMove left no stash behind; one with no expiry
		// would be consumed by the target's next unrelated voice_join as if a moderator
		// had just muted them.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not connected"}}
	}
	blockVoiceRejoin(d.Mod, c.TargetID, state.ChannelID)
	// The target's re-join would ask a password-protected destination for its
	// password, which a move never does: the grant is stored now that the
	// target is evicted, and a failure takes the same branch as a failed send.
	if !moveGrantStored(ctx, d.Reader, dest.JoinLocked, c.ToChannelID, c.TargetID) ||
		!d.Mod.SendToVoiceDevice(c.TargetID, buildVoiceMoved(c.ToChannelID, "", info.UserID)) {
		clearPendingModFlags(d.Mod, c.TargetID)
		writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_kick", c.TargetID,
			fmt.Sprintf("disconnected from channel %d (reconnecting, not moved to channel %d)", state.ChannelID, c.ToChannelID))
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user was reconnecting; removed from voice instead of moved"}}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_move", c.TargetID,
		fmt.Sprintf("moved from channel %d to channel %d", state.ChannelID, c.ToChannelID))
	slog.Info("voice moderator move", "actor_id", info.UserID, "target_id", c.TargetID,
		"from_channel_id", state.ChannelID, "to_channel_id", c.ToChannelID)

	// handleVoiceLeave already broadcast voice_leave for the old channel; the re-join
	// broadcasts voice_state for the new one.
	return Result{}
}

// handleVoiceModKickV2 processes voice_mod_kick: the hub's voice-leave routine
// removes the target from the LiveKit room, deletes the row and broadcasts
// voice_leave; then the target is told why.
func handleVoiceModKickV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModKickCmd)

	if r := voiceModRateLimited(d, "voice_mod_kick", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID)
	if r != nil {
		return *r
	}

	if d.Mod == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice moderation unavailable"}}
	}
	// Scoped to the channel the gate authorized: a target who switched channels
	// mid-decision must not be kicked out of the new one.
	if !disconnectFromVoiceIn(ctx, d.Mod, c.TargetID, state.ChannelID) {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not connected"}}
	}
	blockVoiceRejoin(d.Mod, c.TargetID, state.ChannelID)
	d.Mod.SendToVoiceDevice(c.TargetID,
		buildVoiceDisconnected(state.ChannelID, "You were disconnected from voice by a moderator"))

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_kick", c.TargetID,
		fmt.Sprintf("disconnected from channel %d", state.ChannelID))
	slog.Info("voice moderator disconnect", "actor_id", info.UserID, "target_id", c.TargetID,
		"channel_id", state.ChannelID)

	return Result{}
}

// writeVoiceModAudit records a moderation action. The row must survive a
// connection dying right after the effect landed, so it is written detached from
// the dispatching context.
func writeVoiceModAudit(ctx context.Context, d VoiceDeps, actorID int64, action string, targetID int64, detail string) {
	if d.Voice == nil {
		return
	}
	d.Voice.WriteModAudit(ctx, actorID, action, targetID, detail)
}

// onOff renders a boolean for an audit detail string.
func onOff(v bool) string {
	if v {
		return "on"
	}
	return "off"
}

// muteParticipantHookForTest, when non-nil, replaces the real LiveKit call.
// Test-only: the voice-mod lock's concurrency tests need a working SFU to prove a
// real mute survives a racing unmute, and h.livekit is nil in other ws tests, which
// would make "muted" unreachable.
var muteParticipantHookForTest func(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error

// MuteParticipant reconciles the target's publication permissions at the SFU.
// Reads h.livekit at call time so SetLiveKit's late wiring is picked up. Callers
// hold voiceMod across their state write and this permission update.
func (h *Hub) MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error {
	if muteParticipantHookForTest != nil {
		return muteParticipantHookForTest(ctx, channelID, userID, voiceJoinToken, muted)
	}
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, voiceJoinToken)
}

// SetServerMuteLocked applies or clears the manual moderator mute, running the DB
// write and its paired LiveKit call under the same per-user lock the timeout
// voice half uses (MuteForTimeout / UnmuteForTimeout); a lock only one path took
// would serialize nothing. matched means as VoiceStore.SetServerMute's result
// (false: the row moved off channelID since authorization); joinedAt is the
// session's join token for the caller's SFU/broadcast use.
//
// An SFU failure is returned as errVoiceMediaPending; the persisted desired state
// is retained for retry and periodic reconciliation.
func (h *Hub) SetServerMuteLocked(ctx context.Context, userID, channelID int64, muted bool) (matched bool, joinedAt string, err error) {
	unlock := h.voiceMod.lock(userID)
	defer unlock()

	matched, err = h.voice.SetServerMute(ctx, userID, channelID, muted)
	if err != nil || !matched {
		return matched, "", err
	}
	if state, stateErr := h.voice.State(ctx, userID); stateErr == nil && state != nil {
		joinedAt = state.JoinedAt
	}
	if mpErr := h.MuteParticipant(ctx, channelID, userID, joinedAt, muted); mpErr != nil {
		slog.Warn("ws SetServerMuteLocked MuteParticipant failed", "err", mpErr, "user_id", userID, "channel_id", channelID)
		// Publish the saved desired state even though the caller returns an error: error
		// results short-circuit ordinary handler events and the client must know these
		// flags while the SFU update awaits retry.
		h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, muted)
		return matched, joinedAt, fmt.Errorf("%w: %w", errVoiceMediaPending, mpErr)
	}
	return matched, joinedAt, nil
}

// DisconnectFromVoice runs the hub's voice-leave routine for another user's
// connection (DB row, LiveKit participant, topic unsubscribe, key-holder
// re-election, voice_leave), the one implementation shared with disconnect and
// channel-switch. Reports false when the user has no connection on this node.
func (h *Hub) DisconnectFromVoice(ctx context.Context, userID int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	// The call is on one device: that connection leaves. With none holding a call the
	// only membership left may be a parked one.
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		left := h.leaveParkedVoice(ctx, txn, txn.takeParked(0), voiceLeaveReasonModerator)
		return left || h.isConnected(userID)
	}
	h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonModerator)
	h.noteModeratorExit(userID, c)
	return true
}

// DisconnectFromVoiceInChannel is DisconnectFromVoice conditioned on the channel
// the caller authorized against (voiceChannelDisconnector). The comparison and
// clear happen together under the client's voiceMu (handleVoiceLeaveIfStillIn ->
// voiceTxn.clearIfChannel), so a channel switch committed on the target's goroutine
// after the moderator's checks either loses the race or is left untouched, never
// evicted in place of the checked channel. False in both cases, which callers
// treat as not connected. reason is the voiceLeaveReason* constant for the log line.
func (h *Hub) DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool {
	txn := h.begin(userID)
	defer txn.end()
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		return h.leaveParkedVoice(ctx, txn, txn.takeParked(channelID), reason)
	}
	left := h.handleVoiceLeaveIfStillIn(ctx, txn, c, channelID, reason)
	if left {
		h.noteModeratorExit(userID, c)
	}
	return left
}

// SetPendingVoiceModFlags stashes a moderator-imposed mute/deafen on userID's voice
// connection under the member lock (voicePendingModFlagsSetter). Reports false
// when the user has no connection on this node: nowhere to stash, and no re-join
// here to consume it.
func (h *Hub) SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	// The stash rides the connection holding the call: its eviction and the target's
	// re-join consume it.
	c := h.voiceClient(userID)
	if c == nil {
		// No device holds a call: the newest connection takes the stash; the next
		// voice_join from any device collects it (voiceJoinMoveCall / voiceJoinLeaveCurrent).
		conns := h.clientsOf(userID)
		if len(conns) == 0 {
			return false
		}
		c = conns[len(conns)-1]
	}
	txn.stashModFlags(c, serverMuted, serverDeafened, serverMutedBy)
	return true
}
