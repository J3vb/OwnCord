package ws

import (
	"context"
	"errors"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// voice_moderation_authorize.go — the shared gate behind the voice moderation
// commands (split out of voice_moderation.go).

// voiceModKind selects which authorization contract voiceModTarget applies.
type voiceModKind int

const (
	// voiceModKindMute is mute, deafen and disconnect: MUTE_MEMBERS and the
	// strict-outranks rule.
	voiceModKindMute voiceModKind = iota
	// voiceModKindMove is voice_mod_move: MOVE_MEMBERS only, at any rank (see
	// voiceModAuthorize).
	voiceModKindMove
)

// voiceModTarget runs the shared gate for mute, deafen and disconnect and
// returns the target's live voice state.
func voiceModTarget(ctx context.Context, d VoiceDeps, actorID, targetID int64) (*db.VoiceState, *Result) {
	state, _, r := voiceModAuthorize(ctx, d, actorID, targetID, voiceModKindMute)
	return state, r
}

// voiceOwnerMovable reads the owner-only voice_owner_movable setting: true
// while no row exists. A read failure, or no settings reader, fails closed
// (false) so the owner is never moved on a guess.
func voiceOwnerMovable(ctx context.Context, d VoiceDeps) bool {
	if d.Settings == nil {
		return false
	}
	stored, err := d.Settings.Setting(ctx, service.VoiceOwnerMovableKey)
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		slog.Error("ws voiceModTarget owner movable setting", "err", err)
		return false
	}
	return service.VoiceOwnerMovable(stored)
}

// voiceOwnerGuard refuses a MOVE_MEMBERS move of the owner while the owner
// switch is off.
func voiceOwnerGuard(ctx context.Context, d VoiceDeps, viaMoveMembers bool, targetRole *db.Role) *Result {
	if viaMoveMembers && permissions.IsOwner(targetRole.ID, targetRole.Position) && !voiceOwnerMovable(ctx, d) {
		return &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "the owner cannot be moved"}}
	}
	return nil
}

// voiceModAuthorize is the gate behind voiceModTarget. The returned bypass is
// true only for a move against a target at or above the actor's rank.
//
// Mute, deafen and disconnect: MUTE_MEMBERS and the strict-outranks rule.
//
// A move: MOVE_MEMBERS through AuthorizeVoiceMover, any rank, with the owner
// switch and the per-target limit applied by the caller. MUTE_MEMBERS and
// ADMINISTRATOR do not open a move, so taking MOVE_MEMBERS off a role stops
// it moving anyone. An actor without it gets the same refusal whether the
// target is in voice or not.
func voiceModAuthorize(ctx context.Context, d VoiceDeps, actorID, targetID int64, kind voiceModKind) (state *db.VoiceState, bypass bool, res *Result) {
	if actorID == targetID {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "cannot moderate yourself"}}
	}
	actorRole, ok := voiceModRole(ctx, d, actorID)
	if !ok {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load actor role"}}
	}
	targetRole, ok := voiceModRole(ctx, d, targetID)
	if !ok {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load target role"}}
	}
	move := kind == voiceModKindMove
	outranked := actorRole.Position <= targetRole.Position
	baseSub := permissions.Subject{RolePerms: actorRole.Permissions}
	if move {
		// The base bit alone: READ_MESSAGES may come from a channel allow,
		// which only the resolved subject in voiceModInChannel can see.
		if permissions.VoiceMoverBase(actorRole.Permissions) != nil {
			return nil, false, voiceModMissing(true)
		}
	} else if outranked {
		// Administrator bypasses permission bits, never the hierarchy; only a
		// move has no hierarchy.
		return nil, false, voiceModRankRefusal()
	}

	st, err := d.Voice.State(ctx, targetID)
	if err != nil {
		slog.Error("ws voiceModTarget State", "err", err, "target_id", targetID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read voice state"}}
	}
	if st == nil {
		return nil, false, voiceModNoSession(ctx, d, move, baseSub, targetRole)
	}
	return voiceModInChannel(ctx, d, actorID, st, move, outranked, targetRole)
}

func voiceModRankRefusal() *Result {
	return &Result{Error: ClientError{
		Code:    ErrCodeForbidden,
		Message: "cannot moderate a user of equal or higher rank",
	}}
}

func voiceModMissing(move bool) *Result {
	msg := "missing MUTE_MEMBERS permission"
	if move {
		msg = "missing MOVE_MEMBERS permission"
	}
	return &Result{Error: ClientError{Code: ErrCodeForbidden, Message: msg}}
}

func voiceModNotInVoice() *Result {
	return &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
}

// voiceModNoSession answers a target with no voice session. Authorization
// before existence: with no session to
// build a channel Subject from, still run the SAME canonical authorizers (no
// second one) on a Subject built from just the actor's base role and a zero
// channel — their DM branch and channel-override layer are both no-ops
// against a zero Channel, so this reduces to exactly the base-bit check the
// full, in-voice path would fail on for the SAME actor regardless of channel.
// An actor holding neither bit gets the SAME 403 here as the in-voice failure,
// so a target in voice and one not in voice are byte-identical refusals —
// probing voice presence this way learns nothing. Only a holder ever reaches
// the VoiceError.
func voiceModNoSession(ctx context.Context, d VoiceDeps, move bool, baseSub permissions.Subject, targetRole *db.Role) *Result {
	if !move && permissions.AuthorizeVoiceModerator(baseSub) != nil {
		return voiceModMissing(move)
	}
	if r := voiceOwnerGuard(ctx, d, move, targetRole); r != nil {
		return r
	}
	return voiceModNotInVoice()
}

// voiceModInChannel authorizes the actor in the TARGET's channel (one
// canonical authorizer per bit): the actor's BASE
// role must hold the command's bit on its own, and the bit must be effective
// in the target's channel too, so a role-layer or user-layer deny on that
// channel holds; READ_MESSAGES so a room hidden from the actor
// cannot be moderated; and for a DM call the actor's own membership, since
// voice_mod_kick and friends carry no channel id from the client. The DM
// refusal keeps the exact shape of "target not in voice" so the actor learns
// nothing about a call they are not in.
func voiceModInChannel(ctx context.Context, d VoiceDeps, actorID int64, st *db.VoiceState, move, outranked bool, targetRole *db.Role) (*db.VoiceState, bool, *Result) {
	ch, err := d.Reader.GetChannel(ctx, st.ChannelID)
	if err != nil {
		slog.Error("ws voiceModTarget GetChannel", "err", err, "channel_id", st.ChannelID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read channel"}}
	}
	if ch == nil {
		return nil, false, voiceModNotInVoice()
	}
	sub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, actorID, ch, false)
	if subErr != nil {
		slog.Error("ws voiceModTarget channelSubject", "err", subErr, "channel_id", st.ChannelID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to verify channel access"}}
	}
	if move {
		// Any rank; the owner switch decides the owner.
		switch moverErr := permissions.AuthorizeVoiceMover(sub); {
		case errors.Is(moverErr, permissions.ErrNotDMParticipant):
			return nil, false, voiceModNotInVoice()
		case moverErr != nil:
			return nil, false, voiceModMissing(true)
		}
		if r := voiceOwnerGuard(ctx, d, true, targetRole); r != nil {
			return nil, false, r
		}
		return st, outranked, nil
	}
	// Mute, deafen and disconnect: the strict-outranks rule applies.
	switch modErr := permissions.AuthorizeVoiceModerator(sub); {
	case errors.Is(modErr, permissions.ErrNotDMParticipant):
		return nil, false, voiceModNotInVoice()
	case modErr != nil:
		return nil, false, voiceModMissing(move)
	}
	if outranked {
		return nil, false, voiceModRankRefusal()
	}
	return st, false, nil
}

// requireMoverCanSee refuses a move whose destination the mover cannot view.
// A hidden room answers exactly as a room that does not exist, so a move
// cannot place someone in, or reveal, a channel the mover cannot see. An
// archived destination is left to the target's CanJoinVoice check, which
// answers it; CanViewChannel reports it only to an actor who would otherwise
// see the room.
func requireMoverCanSee(ctx context.Context, d VoiceDeps, actorID int64, dest *db.Channel) *Result {
	sub, err := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, actorID, dest, false)
	if err != nil {
		slog.Error("ws handleVoiceModMoveV2 channelSubject", "err", err, "channel_id", dest.ID)
		return &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to check destination access"}}
	}
	if viewErr := permissions.CanViewChannel(sub); viewErr != nil && !errors.Is(viewErr, permissions.ErrArchived) {
		return &Result{Error: ClientError{Code: ErrCodeNotFound, Message: "channel not found"}}
	}
	return nil
}

// voiceModMoveTargetLimited applies the extra per-target limit to a move that
// relies on the MOVE_MEMBERS rank bypass (the target ranks at or above the
// mover), so one member cannot be bounced between rooms in a loop. It is
// spent after every other pre-flight check passes, so a refused move costs the
// target nothing; a move that then fails at eviction (the target left, or was
// reconnecting) still spends the token.
func voiceModMoveTargetLimited(d VoiceDeps, bypass bool, targetID int64) *Result {
	if !bypass || d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key("voice_mod_move_target", targetID), voiceModMoveTargetLimit, voiceModMoveTargetWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "this member was moved too recently"}}
}
