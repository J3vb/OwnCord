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
// commands (WP 8.4a split it out of voice_moderation.go).

// voiceModKind selects which authorization contract voiceModTarget applies.
type voiceModKind int

const (
	// voiceModKindMute is mute, deafen and disconnect: MUTE_MEMBERS and the
	// strict-outranks rule.
	voiceModKindMute voiceModKind = iota
	// voiceModKindMove is voice_mod_move: MOVE_MEMBERS, no rank rule.
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

// voiceOwnerGuard refuses a move of the owner while the owner switch is off.
func voiceOwnerGuard(ctx context.Context, d VoiceDeps, move bool, targetRole *db.Role) *Result {
	if move && permissions.IsOwner(targetRole.ID, targetRole.Position) && !voiceOwnerMovable(ctx, d) {
		return &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "the owner cannot be moved"}}
	}
	return nil
}

// voiceModAuthorize is the gate behind voiceModTarget. For voiceModKindMove it
// authorizes with permissions.AuthorizeVoiceMover and applies no rank rule,
// except that a target holding the owner role is refused while the owner
// switch is off; outranked then reports whether the move relied on that
// missing rank rule (the target's position is at or above the actor's).
func voiceModAuthorize(ctx context.Context, d VoiceDeps, actorID, targetID int64, kind voiceModKind) (state *db.VoiceState, outranked bool, res *Result) {
	if actorID == targetID {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeBadRequest, Message: "cannot moderate yourself"}}
	}
	move := kind == voiceModKindMove
	authorize := permissions.AuthorizeVoiceModerator
	missingMsg := "missing MUTE_MEMBERS permission"
	if move {
		authorize = permissions.AuthorizeVoiceMover
		missingMsg = "missing MOVE_MEMBERS permission"
	}

	actorRole, ok := voiceModRole(ctx, d, actorID)
	if !ok {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load actor role"}}
	}
	targetRole, ok := voiceModRole(ctx, d, targetID)
	if !ok {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: "failed to load target role"}}
	}
	outranked = actorRole.Position <= targetRole.Position
	// Administrator bypasses permission bits, never the hierarchy. A move is
	// the one command with no hierarchy: its bit is the authority.
	if !move && outranked {
		return nil, false, &Result{Error: ClientError{
			Code:    ErrCodeForbidden,
			Message: "cannot moderate a user of equal or higher rank",
		}}
	}
	// ownerGuard runs once the actor is known to hold the authority, so a
	// caller without it learns nothing about who the owner is.
	ownerGuard := func() *Result { return voiceOwnerGuard(ctx, d, move, targetRole) }

	st, err := d.Voice.State(ctx, targetID)
	if err != nil {
		slog.Error("ws voiceModTarget State", "err", err, "target_id", targetID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read voice state"}}
	}
	if st == nil {
		// Authorization before existence (follow-up to round 4, Codex review):
		// with no session to build a channel Subject from, still run the SAME
		// canonical authorizer (no second one) on a Subject built from just the
		// actor's base role and a zero channel — CanModerateVoice's DM branch
		// and channel-override layer are both no-ops against a zero Channel, so
		// this reduces to exactly the base-bit-plus-ReadMessages/MuteMembers
		// check the full, in-voice path would fail on for the SAME actor
		// regardless of channel. An actor without the base bit gets the SAME
		// 403 here as the in-voice failure below, so a target in voice and one
		// not in voice are byte-identical refusals — probing voice presence
		// this way learns nothing. Only a holder (who would pass the full
		// channel check too, absent an unlucky channel-level deny) ever
		// reaches the VoiceError below. The move authorizer is the same
		// shape on MOVE_MEMBERS.
		if authorize(permissions.Subject{RolePerms: actorRole.Permissions}) != nil {
			return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: missingMsg}}
		}
		if r := ownerGuard(); r != nil {
			return nil, false, r
		}
		return nil, false, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	}

	// The decision is permissions.AuthorizeVoiceModerator (AuthorizeVoiceMover
	// for a move) over the actor's subject in the TARGET's channel (round 4,
	// Codex review Part C — one canonical authorizer, replacing this
	// function's own duplicate of the timeout voice half's
	// base-bit-plus-CanModerateVoice pair): the actor's BASE role must hold
	// the command's bit on its own, and effective MUTE_MEMBERS (MOVE_MEMBERS)
	// in the target's channel too, so a role-layer or user-layer deny on that
	// channel holds (SEC-02), READ_MESSAGES so a room hidden from the actor
	// cannot be moderated, and for a DM call the actor's own membership —
	// voice_mod_kick and friends carry no channel id from the client, so
	// without that a moderator could reach into any two users' DM call by
	// targeting a user id alone. The DM refusal keeps the exact shape of
	// "target not in voice" so the actor learns nothing about a call they are
	// not in.
	ch, err := d.Reader.GetChannel(ctx, st.ChannelID)
	if err != nil {
		slog.Error("ws voiceModTarget GetChannel", "err", err, "channel_id", st.ChannelID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to read channel"}}
	}
	if ch == nil {
		return nil, false, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	}
	sub, subErr := channelSubject(ctx, d.Reader, d.Permissions, d.PermSvc, actorID, ch, false)
	if subErr != nil {
		slog.Error("ws voiceModTarget channelSubject", "err", subErr, "channel_id", st.ChannelID)
		return nil, false, &Result{Error: ClientError{Code: ErrCodeInternal, Message: "failed to verify channel access"}}
	}
	switch modErr := authorize(sub); {
	case errors.Is(modErr, permissions.ErrNotDMParticipant):
		return nil, false, &Result{Error: ClientError{Code: ErrCodeVoiceError, Message: "user is not in a voice channel"}}
	case modErr != nil:
		return nil, false, &Result{Error: ClientError{Code: ErrCodeForbidden, Message: missingMsg}}
	}
	if r := ownerGuard(); r != nil {
		return nil, false, r
	}

	return st, move && outranked, nil
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
// relies on the missing rank rule (the target ranks at or above the mover), so
// one member cannot be bounced between rooms in a loop. Spent only once the
// move is about to happen, so a refused move costs the target nothing.
func voiceModMoveTargetLimited(d VoiceDeps, bypass bool, targetID int64) *Result {
	if !bypass || d.Limiter == nil {
		return nil
	}
	if d.Limiter.Allow(auth.Key("voice_mod_move_target", targetID), voiceModMoveTargetLimit, voiceModMoveTargetWindow) {
		return nil
	}
	return &Result{Error: ClientError{Code: ErrCodeRateLimited, Message: "this member was moved too recently"}}
}
