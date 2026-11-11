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

// voice_moderation_authorize.go: the shared gate behind the voice moderation commands.

type voiceModKind int

const (
	voiceModKindMute voiceModKind = iota
	// voiceModKindMove is voice_mod_move: MOVE_MEMBERS only, at any rank.
	voiceModKindMove
)

func voiceModTarget(ctx context.Context, d VoiceDeps, actorID, targetID int64) (*db.VoiceState, *Result) {
	state, _, r := voiceModAuthorize(ctx, d, actorID, targetID, voiceModKindMute)
	return state, r
}

// voiceOwnerMovable reads the owner-only voice_owner_movable setting: true while no row
// exists. A read failure or no reader fails closed (false): the owner is never moved on a guess.
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

func voiceOwnerGuard(ctx context.Context, d VoiceDeps, viaMoveMembers bool, targetRole *db.Role) *Result {
	if viaMoveMembers && permissions.IsOwner(targetRole.ID, targetRole.Position) && !voiceOwnerMovable(ctx, d) {
		return &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "the owner cannot be moved"}}
	}
	return nil
}

// voiceModAuthorize is the gate behind voiceModTarget. bypass is true only for a move
// against a target at or above the actor's rank. Mute, deafen and disconnect: MUTE_MEMBERS
// and the strict-outranks rule. A move: MOVE_MEMBERS through AuthorizeVoiceMover at any rank
// (owner switch and per-target limit are the caller's); MUTE_MEMBERS and ADMINISTRATOR do not
// open a move. An actor without it gets the same refusal whether or not the target is in voice.
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
		// The base bit alone: READ_MESSAGES may come from a channel allow, which only voiceModInChannel's
		// subject can see.
		if permissions.VoiceMoverBase(actorRole.Permissions) != nil {
			return nil, false, voiceModMissing(true)
		}
	} else if outranked {
		// Administrator bypasses permission bits, never the hierarchy; only a move has no hierarchy.
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

// voiceModNoSession answers a target with no voice session. Authorization comes before
// existence: it runs the SAME canonical authorizers on a Subject built from the actor's
// base role and a zero channel, reducing to the base-bit check the in-voice path would fail
// on. An actor holding neither bit gets the SAME 403 as the in-voice failure, so probing
// voice presence learns nothing; only a holder reaches the VoiceError.
func voiceModNoSession(ctx context.Context, d VoiceDeps, move bool, baseSub permissions.Subject, targetRole *db.Role) *Result {
	if !move && permissions.AuthorizeVoiceModerator(baseSub) != nil {
		return voiceModMissing(move)
	}
	if r := voiceOwnerGuard(ctx, d, move, targetRole); r != nil {
		return r
	}
	return voiceModNotInVoice()
}

// voiceModInChannel authorizes the actor in the TARGET's channel: the BASE role must hold
// the command's bit and it must be effective in that channel (a role- or user-layer deny
// holds); READ_MESSAGES, so a hidden room cannot be moderated; and for a DM call the actor's
// own membership (these commands carry no channel id). The DM refusal has the exact shape of
// "target not in voice" so the actor learns nothing about a call they are not in.
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

// requireMoverCanSee refuses a move whose destination the mover cannot view, answering as
// for a room that does not exist, so a move cannot place someone in or reveal a hidden
// channel. An archived destination is left to the target's CanJoinVoice check.
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

// voiceModMoveTargetLimited applies the extra per-target limit to a move relying on the
// MOVE_MEMBERS rank bypass, so one member cannot be bounced between rooms in a loop. Spent
// after every other pre-flight check passes, so a refused move costs nothing; a move that
// then fails at eviction still spends it.
func voiceModMoveTargetLimited(d VoiceDeps, bypass bool, targetID int64) *Result {
	if !bypass || d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key("voice_mod_move_target", targetID), voiceModMoveTargetLimit, voiceModMoveTargetWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "this member was moved too recently"}}
}
