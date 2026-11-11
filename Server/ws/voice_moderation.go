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
// Mute, deafen and disconnect share voiceModTarget's contract: MUTE_MEMBERS (Administrator
// bypasses), the actor strictly outranks the target by role position, and the target is in
// voice. Move needs only MOVE_MEMBERS (no rank rule) and skips the owner while
// voice_owner_movable is off. SFU and socket effects go through VoiceDeps.Mod.

func registerVoiceModerationV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceModMute, handleVoiceModMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceModDeafen, handleVoiceModDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceModMove, handleVoiceModMoveV2, deps)
	r.RegisterV2(MsgTypeVoiceModKick, handleVoiceModKickV2, deps)
}

// voiceModRole loads the member's effective role through the permission cache when wired,
// else the DB. Every failure is a denial: an unresolvable role must never authorize.
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

func voiceModRateLimited(d VoiceDeps, action string, userID int64) *Result {
	if d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key(action, userID), voiceModRateLimit, voiceModWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many voice moderation actions"}}
}

// requireTargetInChannel refuses when the target moved on since the moderator's client rendered the row.
func requireTargetInChannel(state *db.VoiceState, channelID int64) *Result {
	if state.ChannelID == channelID {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
}

// voiceChannelDisconnector is the channel-scoped DisconnectFromVoice. The bare method evicts
// from whatever channel the target is in at that instant, so a racing channel switch could
// redirect a kick or move onto an unchecked channel (even a DM call). *Hub satisfies it and
// disconnectFromVoiceIn prefers it.
type voiceChannelDisconnector interface {
	DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool
}

// Compile-time check: a failing assertion would silently fall back to the unscoped method.
var _ voiceChannelDisconnector = (*Hub)(nil)

// voiceServerMuteLocker routes the manual mute onto the per-user lock the timeout voice half
// uses. A Mod without it (test double) falls back to an unlocked write.
type voiceServerMuteLocker interface {
	SetServerMuteLocked(ctx context.Context, userID, channelID int64, muted bool) (matched bool, joinedAt string, err error)
}

var _ voiceServerMuteLocker = (*Hub)(nil)

// disconnectFromVoiceIn evicts targetID from channelID, false when the target has no
// connection here or already left that channel.
func disconnectFromVoiceIn(ctx context.Context, mod VoiceModerator, targetID, channelID int64) bool {
	if scoped, ok := mod.(voiceChannelDisconnector); ok {
		return scoped.DisconnectFromVoiceInChannel(ctx, targetID, channelID, voiceLeaveReasonModerator)
	}
	return mod.DisconnectFromVoice(ctx, targetID)
}

// voicePendingModFlagsSetter stashes a moderator-imposed mute/deafen on the target's
// connection before a server-driven leave deletes the voice_states row holding it;
// voiceJoinLeaveCurrent takes it back out when no row is left.
type voicePendingModFlagsSetter interface {
	SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool
}

var _ voicePendingModFlagsSetter = (*Hub)(nil)

// stashPendingModFlags is a best-effort no-op when mod lacks the extension or the target has
// no connection here; the eviction proceeds either way. serverMutedBy carries a timeout's
// ownership through the stash.
func stashPendingModFlags(mod VoiceModerator, targetID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) {
	if !serverMuted && !serverDeafened {
		return
	}
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, serverMuted, serverDeafened, serverMutedBy)
	}
}

// clearPendingModFlags unconditionally wipes any stash (false/false is the clear, so no
// early return). Used when a move that stashed flags evicted nobody: otherwise the target's
// next voice_join would re-apply a mute nobody ordered.
func clearPendingModFlags(mod VoiceModerator, targetID int64) {
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, false, false, nil)
	}
}

// handleVoiceModMuteV2 processes voice_mod_mute. The DB row is the UI authority and SFU
// permissions enforce it; a failed media update is left for reconciliation and reported.
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

	// The DB write and SFU call run under the per-user lock when a locking Mod is wired; Mod-less
	// test deps use the unlocked, SFU-less write.
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
		// The row moved off state.ChannelID since the snapshot: refuse, so the write never follows
		// the target onto an unauthorized channel.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_mute", c.TargetID,
		fmt.Sprintf("server mute %s in channel %d", onOff(c.Muted), state.ChannelID))
	slog.Info("voice server mute", "actor_id", info.UserID, "target_id", c.TargetID,
		"channel_id", state.ChannelID, "muted", c.Muted)

	return voiceStateBroadcast(ctx, d, c.TargetID)
}

// voiceModDeafenPreMuteRaceHook runs between the deafen write and the implied-mute write. Test-only.
var voiceModDeafenPreMuteRaceHook func(ctx context.Context, d VoiceDeps, targetID int64)

// handleVoiceModDeafenV2 processes voice_mod_deafen. Deafen has no SFU equivalent: the
// target's client honors server_deafened and the server refuses their own undeafen.
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
		// The row moved off state.ChannelID: refuse before the implied mute touches an unauthorized channel.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}
	if voiceModDeafenPreMuteRaceHook != nil {
		voiceModDeafenPreMuteRaceHook(ctx, d, c.TargetID)
	}
	// A server deafen implies a server mute at the SFU, and lifting it lifts that mute.
	// server_muted is one bool, so explicit-mute-then-deafen has both lifted by an undeafen
	// (accepted). The implied mute runs under the same per-user lock as the manual mute
	// (SetServerMuteLocked) so it cannot interleave with a timeout's mute; unlocked only for
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
			// Both flags were saved; keep them together so reconciliation can finish the media update.
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

// handleVoiceModMoveV2 processes voice_mod_move: a server-driven leave, then a client-driven
// re-join (voice_moved, then an ordinary voice_join), keeping one join implementation. The
// checks below are pre-flight so the target is never dropped from voice for a re-join that bounces.
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
	// Gate the destination with the re-join's predicate (permissions.CanJoinVoice), so a move
	// neither places someone in a channel they cannot join nor commits the destructive half
	// for a guaranteed bounce (archived channel).
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
	// Advisory capacity check; the atomic one still runs on the re-join. Uses the cap the
	// target's own re-join is held to, so a voice moderator there is not refused.
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
	// Evict the target and, in the same membership transaction, stash their server_muted/
	// server_deafened on the live connection: the disconnect deletes the row they live in, and
	// the re-join takes the stash back out.
	if !evictForMove(ctx, d.Mod, c.TargetID, state.ChannelID, state.ServerMuted, state.ServerDeafened, state.ServerMutedBy) {
		// Nobody was evicted (no live connection here, or the target left the checked channel).
		// evictForMove left no stash; an expiry-less one would be applied by the next unrelated voice_join.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not connected"}}
	}
	blockVoiceRejoin(d.Mod, c.TargetID, state.ChannelID)
	// A move never asks for the destination's password: the grant is stored now, and a failure
	// takes the same branch as a failed send.
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

	return Result{}
}

// handleVoiceModKickV2 processes voice_mod_kick: voice-leave removes the target, then they are told why.
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
	// Scoped to the authorized channel: a target who switched mid-decision must not be kicked from the new
	// one.
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

// writeVoiceModAudit records a moderation action, detached from the dispatching context so
// the row survives a connection dying right after the effect.
func writeVoiceModAudit(ctx context.Context, d VoiceDeps, actorID int64, action string, targetID int64, detail string) {
	if d.Voice == nil {
		return
	}
	d.Voice.WriteModAudit(ctx, actorID, action, targetID, detail)
}

func onOff(v bool) string {
	if v {
		return "on"
	}
	return "off"
}
