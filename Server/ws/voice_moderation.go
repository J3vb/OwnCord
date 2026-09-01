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
// All four share one authorization contract, enforced by voiceModTarget:
// MUTE_MEMBERS on the actor's role (Administrator bypasses), the actor must
// strictly outrank the target by role position (mirroring
// ModerationService.requireOutranks), and the target must currently be in a
// voice channel. Effects that reach past the acting connection — the SFU and
// the target's own socket — go through VoiceDeps.Mod.

// registerVoiceModerationV2 registers the four moderator voice commands.
// Called from registerVoiceControlsV2 so the deps struct is built once.
func registerVoiceModerationV2(r *HandlerRegistry, deps VoiceDeps) {
	r.RegisterV2(MsgTypeVoiceModMute, handleVoiceModMuteV2, deps)
	r.RegisterV2(MsgTypeVoiceModDeafen, handleVoiceModDeafenV2, deps)
	r.RegisterV2(MsgTypeVoiceModMove, handleVoiceModMoveV2, deps)
	r.RegisterV2(MsgTypeVoiceModKick, handleVoiceModKickV2, deps)
}

// voiceModRole loads a role through the permission cache when one is wired and
// falls back to the live DB otherwise. Every failure is a denial: an
// unresolvable role must never authorize a moderation action.
func voiceModRole(ctx context.Context, d VoiceDeps, userID int64) (*db.Role, bool) {
	if d.PermSvc != nil {
		role, err := d.PermSvc.GetRoleForUser(ctx, userID)
		if err == nil && role != nil {
			return role, true
		}
		return nil, false
	}
	if d.Reader == nil {
		return nil, false
	}
	role, err := d.Reader.GetRoleForUser(ctx, userID)
	if err != nil || role == nil {
		return nil, false
	}
	return role, true
}

// voiceModTarget runs the shared gate and returns the target's live voice
// state. Authorization is checked before the voice-state lookup so an actor
// without authority always sees FORBIDDEN and never learns who is in voice.
func voiceModTarget(ctx context.Context, d VoiceDeps, actorID, targetID int64) (*db.VoiceState, *Result) {
	if actorID == targetID {
		return nil, &Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "cannot moderate yourself"}}
	}

	actorRole, ok := voiceModRole(ctx, d, actorID)
	if !ok {
		return nil, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load actor role"}}
	}
	if !permissions.HasServerPerm(actorRole.Permissions, permissions.MuteMembers) {
		return nil, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing MUTE_MEMBERS permission"}}
	}
	targetRole, ok := voiceModRole(ctx, d, targetID)
	if !ok {
		return nil, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load target role"}}
	}
	// Administrator bypasses permission bits, never the hierarchy.
	if actorRole.Position <= targetRole.Position {
		return nil, &Result{Error: ClientError{
			Code:    ErrCodeForbidden,
			Message: "cannot moderate a user of equal or higher rank",
		}}
	}

	state, err := d.Voice.State(ctx, targetID)
	if err != nil {
		slog.Error("ws voiceModTarget State", "err", err, "target_id", targetID)
		return nil, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read voice state"}}
	}
	if state == nil {
		return nil, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	}

	// The decision is permissions.CanModerateVoice over the actor's subject in
	// the TARGET's channel: effective MUTE_MEMBERS there, so a role-layer or
	// user-layer deny on that channel holds (SEC-02), READ_MESSAGES so a room
	// hidden from the actor cannot be moderated, and for a DM call the actor's
	// own membership — voice_mod_kick and friends carry no channel id from
	// the client, so without that a moderator could reach into any two users'
	// DM call by targeting a user id alone. The DM refusal keeps the exact
	// shape of "target not in voice" so the actor learns nothing about a call
	// they are not in. The base-bit check above is only an early rejection
	// (it never admits): it keeps FORBIDDEN ahead of the voice-state lookup
	// for actors with no MUTE_MEMBERS at all, which also means a channel
	// allow cannot grant the bit to a role whose base lacks it.
	ch, err := d.Reader.GetChannel(ctx, state.ChannelID)
	if err != nil {
		slog.Error("ws voiceModTarget GetChannel", "err", err, "channel_id", state.ChannelID)
		return nil, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read channel"}}
	}
	if ch == nil {
		return nil, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	}
	sub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, actorID, ch, false)
	if subErr != nil {
		slog.Error("ws voiceModTarget channelSubject", "err", subErr, "channel_id", state.ChannelID)
		return nil, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to verify channel access"}}
	}
	switch modErr := permissions.CanModerateVoice(sub); {
	case errors.Is(modErr, permissions.ErrNotDMParticipant):
		return nil, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	case modErr != nil:
		return nil, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "missing MUTE_MEMBERS permission"}}
	}

	return state, nil
}

// voiceModRateLimited applies the shared per-action rate limit. Each of these
// commands fans a voice_state broadcast out to every client that can see the
// channel, so a moderator must not be able to drive them in a tight loop.
func voiceModRateLimited(d VoiceDeps, action string, userID int64) *Result {
	if d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key(action, userID), voiceModRateLimit, voiceModWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "too many voice moderation actions"}}
}

// requireTargetInChannel refuses when the target has moved on since the
// moderator's client rendered the row that produced this command.
func requireTargetInChannel(state *db.VoiceState, channelID int64) *Result {
	if state.ChannelID == channelID {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
}

// voiceChannelDisconnector is the channel-scoped form of
// VoiceModerator.DisconnectFromVoice. The bare interface method takes no
// channel, so it evicts the target from whatever channel their live connection
// is in at that instant — not the channel voiceModTarget authorized against.
// A channel switch on the target's own read-pump goroutine, concurrent with
// the moderator's DB round trips, therefore redirects a kick or a move onto a
// channel that was never checked, up to and including a DM call the actor is
// not a participant of (the case voiceModTarget's IsDMParticipant guard
// exists to refuse).
//
// Widening VoiceModerator itself lives in deps.go; until then *Hub also
// satisfies this optional extension and disconnectFromVoiceIn prefers it,
// falling back to the unscoped method for any other implementation.
type voiceChannelDisconnector interface {
	DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64) bool
}

// disconnectFromVoiceIn evicts targetID from channelID, reporting false when
// the target has no connection on this node or has already left that channel.
func disconnectFromVoiceIn(ctx context.Context, mod VoiceModerator, targetID, channelID int64) bool {
	if scoped, ok := mod.(voiceChannelDisconnector); ok {
		return scoped.DisconnectFromVoiceInChannel(ctx, targetID, channelID)
	}
	return mod.DisconnectFromVoice(ctx, targetID)
}

// voicePendingModFlagsSetter lets a server-driven leave (voice_mod_move)
// stash a moderator-imposed mute/deafen on the target's in-memory connection
// before the delete below erases the voice_states row those flags normally
// live in. handleVoiceJoin's shared join helper (voiceJoinLeaveCurrent, in
// voice_join.go) takes the stash back out when there is no row left to read
// (currentChID == 0) and re-applies it exactly as it already does for a
// self-initiated channel switch — one guard in the shared consumer instead of
// a second, divergent restore path here.
//
// Widening VoiceModerator itself lives in deps.go; until then *Hub also
// satisfies this optional extension, mirroring voiceChannelDisconnector.
type voicePendingModFlagsSetter interface {
	SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool) bool
}

// stashPendingModFlags is a best-effort no-op when mod does not support the
// optional extension or the target has no connection on this node — the
// eviction that follows still proceeds either way, exactly as it did before
// this stash existed, so a missing implementation only loses the
// preservation, never blocks the move.
func stashPendingModFlags(mod VoiceModerator, targetID int64, serverMuted, serverDeafened bool) {
	if !serverMuted && !serverDeafened {
		return
	}
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, serverMuted, serverDeafened)
	}
}

// clearPendingModFlags unconditionally wipes any stash left by
// stashPendingModFlags. Unlike stashPendingModFlags it cannot early-return on
// "both false" — false/false IS the clear — so it calls the setter directly.
// Used when a move that stashed flags in anticipation of an eviction turns
// out not to have evicted anyone (OC-0278): without this, a refused move
// leaves an unbound, unexpiring stash that the target's next unrelated
// voice_join (taken with no live row to read the real flags from) would
// re-apply as a server mute/deafen nobody currently ordered.
func clearPendingModFlags(mod VoiceModerator, targetID int64) {
	if setter, ok := mod.(voicePendingModFlagsSetter); ok {
		setter.SetPendingVoiceModFlags(targetID, false, false)
	}
}

// handleVoiceModMuteV2 processes a voice_mod_mute command. The DB row is the
// authority for the UI; the SFU mute is what makes it more than cosmetic, so a
// LiveKit failure is logged but does not fail the action — the persisted
// server_muted still blocks the target's own unmute and is re-applied whenever
// the moderator retries.
func handleVoiceModMuteV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModMuteCmd)

	if r := voiceModRateLimited(d, "voice_mod_mute", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID())
	if r != nil {
		return *r
	}
	if r := requireTargetInChannel(state, c.ChannelID()); r != nil {
		return *r
	}

	matched, err := d.Voice.SetServerMute(ctx, c.TargetID(), state.ChannelID, c.Muted())
	if err != nil {
		slog.Error("ws handleVoiceModMuteV2 SetServerMute", "err", err, "target_id", c.TargetID())
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server mute"}}
	}
	if !matched {
		// The target's row moved off state.ChannelID between requireTargetInChannel's
		// snapshot and this write (OC-0005) -- same refusal requireTargetInChannel
		// itself gives for the non-racing case, so the write never follows the
		// target onto a channel (including a DM call) nobody authorized it against.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}
	if d.Mod != nil {
		if err := d.Mod.MuteParticipant(ctx, state.ChannelID, c.TargetID(), state.JoinedAt, c.Muted()); err != nil {
			slog.Warn("ws handleVoiceModMuteV2 MuteParticipant failed",
				"err", err, "target_id", c.TargetID(), "channel_id", state.ChannelID)
		}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_mute", c.TargetID(),
		fmt.Sprintf("server mute %s in channel %d", onOff(c.Muted()), state.ChannelID))
	slog.Info("voice server mute", "actor_id", info.UserID, "target_id", c.TargetID(),
		"channel_id", state.ChannelID, "muted", c.Muted())

	return voiceStateBroadcast(ctx, d, c.TargetID())
}

// voiceModDeafenPreMuteRaceHook, when non-nil, runs immediately after the
// deafen write matches and before the implied-mute write that follows it —
// the one-statement-wide window a concurrent channel switch would need to
// land in for OC-0034. Test-only (nil in production), mirroring the
// voiceJoinPostTokenRaceHook / cleanupVoiceRaceClearHook pattern used to pin
// the analogous races elsewhere.
var voiceModDeafenPreMuteRaceHook func(ctx context.Context, d VoiceDeps, targetID int64)

// handleVoiceModDeafenV2 processes a voice_mod_deafen command. Deafen has no
// SFU equivalent (it is about what the target plays back), so it is enforced by
// the target's client honoring server_deafened plus the server refusing their
// own undeafen while it is set.
func handleVoiceModDeafenV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModDeafenCmd)

	if r := voiceModRateLimited(d, "voice_mod_deafen", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID())
	if r != nil {
		return *r
	}
	if r := requireTargetInChannel(state, c.ChannelID()); r != nil {
		return *r
	}

	deafenMatched, err := d.Voice.SetServerDeafen(ctx, c.TargetID(), state.ChannelID, c.Deafened())
	if err != nil {
		slog.Error("ws handleVoiceModDeafenV2 SetServerDeafen", "err", err, "target_id", c.TargetID())
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server deafen"}}
	}
	if !deafenMatched {
		// The target's row moved off state.ChannelID between requireTargetInChannel's
		// snapshot and this write (OC-0005) -- refuse exactly as requireTargetInChannel
		// itself does for the non-racing case, before the implied mute below can
		// touch a channel nobody authorized it against.
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}
	if voiceModDeafenPreMuteRaceHook != nil {
		voiceModDeafenPreMuteRaceHook(ctx, d, c.TargetID())
	}
	// A server deafen implies a server mute at the SFU: a deafened user must
	// not keep talking into a room they cannot hear. Lifting the deafen must
	// lift that implied mute too, or the target stays SFU-muted and refused
	// their own unmute even after the deafen is gone. server_muted is a
	// single bool with no way to tell "explicit" from "deafen-implied" apart,
	// so an explicit-mute-then-deafen sequence has both lifted together by an
	// undeafen — accepted as the simplest correct behavior given the schema.
	muteMatched, err := d.Voice.SetServerMute(ctx, c.TargetID(), state.ChannelID, c.Deafened())
	if err != nil || !muteMatched {
		if err != nil {
			slog.Error("ws handleVoiceModDeafenV2 SetServerMute", "err", err, "target_id", c.TargetID())
		}
		d.Voice.RollbackServerDeafen(ctx, c.TargetID(), state.ChannelID, c.Deafened())
		if err != nil {
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to update server deafen"}}
		}
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in that voice channel"}}
	}
	if d.Mod != nil {
		if err := d.Mod.MuteParticipant(ctx, state.ChannelID, c.TargetID(), state.JoinedAt, c.Deafened()); err != nil {
			slog.Warn("ws handleVoiceModDeafenV2 MuteParticipant failed",
				"err", err, "target_id", c.TargetID(), "channel_id", state.ChannelID)
		}
	}

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_deafen", c.TargetID(),
		fmt.Sprintf("server deafen %s in channel %d", onOff(c.Deafened()), state.ChannelID))
	slog.Info("voice server deafen", "actor_id", info.UserID, "target_id", c.TargetID(),
		"channel_id", state.ChannelID, "deafened", c.Deafened())

	return voiceStateBroadcast(ctx, d, c.TargetID())
}

// handleVoiceModMoveV2 processes a voice_mod_move command.
//
// The move is a server-driven leave followed by a client-driven re-join: the
// hub runs its voice-leave routine for the target (DB row, LiveKit participant,
// voice_leave broadcast) and then sends voice_moved, which the target's client
// answers with an ordinary voice_join for the destination. That keeps one
// implementation of the join sequence — capacity, token minting, key-holder
// election, existing-state fan-out — instead of a second, divergent copy here.
// The checks below are the pre-flight: they refuse a move the re-join would
// only bounce, so the target is never dropped from voice for nothing.
func handleVoiceModMoveV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModMoveCmd)

	if r := voiceModRateLimited(d, "voice_mod_move", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID())
	if r != nil {
		return *r
	}
	if state.ChannelID == c.ToChannelID() {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "user is already in that voice channel"}}
	}

	dest, err := d.Reader.GetChannel(ctx, c.ToChannelID())
	if err != nil {
		slog.Error("ws handleVoiceModMoveV2 GetChannel", "err", err, "channel_id", c.ToChannelID())
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read destination channel"}}
	}
	if dest == nil {
		return Result{Error: ClientError{Code: ErrCodeNotFound, Message: "channel not found"}}
	}
	if dest.Type != "voice" {
		return Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "destination is not a voice channel"}}
	}
	// The destination is gated on the TARGET's access with the same predicate
	// the re-join this move hands off to (handleVoiceJoin) will apply —
	// permissions.CanJoinVoice — so a move can neither place someone in a
	// channel they could not join themselves nor commit the destructive half
	// of the move for a re-join guaranteed to bounce (an archived channel).
	targetSub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, c.TargetID(), dest, false)
	if subErr != nil {
		slog.Error("ws handleVoiceModMoveV2 channelSubject", "err", subErr, "channel_id", c.ToChannelID())
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
	// Advisory capacity check with JoinVoiceChannelIfCapacity's semantics. The
	// atomic one still runs on the re-join; this one keeps the common case from
	// dropping the target into a channel that is already full.
	if dest.VoiceMaxUsers > 0 {
		count, cErr := d.Voice.CountInChannel(ctx, c.ToChannelID())
		if cErr != nil {
			slog.Error("ws handleVoiceModMoveV2 CountInChannel", "err", cErr, "channel_id", c.ToChannelID())
			return Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check channel capacity"}}
		}
		if count >= dest.VoiceMaxUsers {
			return Result{Error: ClientError{Code: ErrCodeChannelFull, Message: "voice channel is full"}}
		}
	}

	if d.Mod == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice moderation unavailable"}}
	}
	// Stash the target's server_muted/server_deafened (already loaded by
	// voiceModTarget above) on their live connection before the disconnect
	// below deletes the voice_states row those flags live in — see
	// voicePendingModFlagsSetter. The target's own re-join (handleVoiceJoin,
	// via voiceJoinLeaveCurrent in voice_join.go) has no row left to read
	// (currentChID == 0 by then) and takes this stash back out instead.
	stashPendingModFlags(d.Mod, c.TargetID(), state.ServerMuted, state.ServerDeafened)
	if !disconnectFromVoiceIn(ctx, d.Mod, c.TargetID(), state.ChannelID) {
		// No live connection on this node — the voice_states row is a ghost the
		// sweeper owns, and there is nobody to send voice_moved to — or the
		// target left the checked channel while this handler was deciding, in
		// which case the move must not follow them. Either way the eviction
		// that would have justified the stash above never happened, so undo
		// it (OC-0278): left in place, it has no expiry and no binding to
		// this move, and the target's next unrelated voice_join would consume
		// it as if a moderator had just muted them.
		clearPendingModFlags(d.Mod, c.TargetID())
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not connected"}}
	}
	d.Mod.SendToUser(c.TargetID(), buildVoiceMoved(c.ToChannelID()))

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_move", c.TargetID(),
		fmt.Sprintf("moved from channel %d to channel %d", state.ChannelID, c.ToChannelID()))
	slog.Info("voice moderator move", "actor_id", info.UserID, "target_id", c.TargetID(),
		"from_channel_id", state.ChannelID, "to_channel_id", c.ToChannelID())

	// handleVoiceLeave already broadcast voice_leave for the old channel; the
	// re-join broadcasts voice_state for the new one.
	return Result{}
}

// handleVoiceModKickV2 processes a voice_mod_kick command: the target is
// removed from the LiveKit room, their voice_states row is deleted and
// voice_leave is broadcast (all by the hub's voice-leave routine), then they
// are told why.
func handleVoiceModKickV2(ctx context.Context, cmd Command, info ClientInfo, deps any) Result {
	d := deps.(VoiceDeps)
	c := cmd.(VoiceModKickCmd)

	if r := voiceModRateLimited(d, "voice_mod_kick", info.UserID); r != nil {
		return *r
	}
	state, r := voiceModTarget(ctx, d, info.UserID, c.TargetID())
	if r != nil {
		return *r
	}

	if d.Mod == nil {
		return Result{Error: ClientError{Code: ErrCodeInternal, Message: "voice moderation unavailable"}}
	}
	// Scoped to the channel the gate above authorized: a target who switched
	// channels mid-decision must not be kicked out of the new one.
	if !disconnectFromVoiceIn(ctx, d.Mod, c.TargetID(), state.ChannelID) {
		return Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not connected"}}
	}
	d.Mod.SendToUser(c.TargetID(),
		buildVoiceDisconnected(state.ChannelID, "You were disconnected from voice by a moderator"))

	writeVoiceModAudit(ctx, d, info.UserID, "voice_mod_kick", c.TargetID(),
		fmt.Sprintf("disconnected from channel %d", state.ChannelID))
	slog.Info("voice moderator disconnect", "actor_id", info.UserID, "target_id", c.TargetID(),
		"channel_id", state.ChannelID)

	return Result{}
}

// writeVoiceModAudit records a moderation action. The row must survive a
// connection that dies right after the effect landed, so the write is detached
// from the dispatching context.
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

// ── Hub-side effects ────────────────────────────────────────────────────────

// MuteParticipant mutes or unmutes the target's published audio at the SFU.
// Satisfies VoiceModerator; reads h.livekit at call time so SetLiveKit's late
// wiring is picked up (same reason as GenerateToken).
func (h *Hub) MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error {
	if h.livekit == nil {
		return fmt.Errorf("voice not configured")
	}
	return h.livekit.MuteParticipantAudio(ctx, channelID, userID, voiceJoinToken, muted)
}

// DisconnectFromVoice runs the hub's voice-leave routine for another user's
// connection, which is what a moderator move or disconnect needs: DB row,
// LiveKit participant, topic unsubscribe, key-holder re-election and the
// voice_leave broadcast, in the one implementation that also serves the
// disconnect and channel-switch paths. Reports false when the user has no
// connection on this node.
func (h *Hub) DisconnectFromVoice(ctx context.Context, userID int64) bool {
	c := h.GetClient(userID)
	if c == nil {
		return false
	}
	h.handleVoiceLeave(ctx, c)
	return true
}

// DisconnectFromVoiceInChannel is DisconnectFromVoice conditioned on the
// channel the caller authorized against, satisfying voiceChannelDisconnector.
// The comparison and the clear happen together under the client's voiceMu
// (handleVoiceLeaveIfStillIn -> clearVoiceStateIfMatch), so a channel switch
// committed on the target's own goroutine after the moderator's checks either
// loses the race outright or is left untouched — never evicted in place of the
// channel that was checked. Reports false in both of those cases, which the
// callers already treat as "user is not connected".
func (h *Hub) DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64) bool {
	c := h.GetClient(userID)
	if c == nil {
		return false
	}
	return h.handleVoiceLeaveIfStillIn(ctx, c, channelID)
}

// SetPendingVoiceModFlags stashes a moderator-imposed mute/deafen on
// userID's live connection, satisfying voicePendingModFlagsSetter. Reports
// false when the user has no connection on this node — the same "nothing to
// do here" case DisconnectFromVoiceInChannel reports, since without a live
// *Client there is nowhere to stash the flags and no re-join on this node to
// consume them.
func (h *Hub) SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool) bool {
	c := h.GetClient(userID)
	if c == nil {
		return false
	}
	c.setPendingModFlags(serverMuted, serverDeafened)
	return true
}
