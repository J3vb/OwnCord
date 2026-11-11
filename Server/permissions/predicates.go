package permissions

import (
	"errors"
	"fmt"
)

// One predicate per security property, each a pure function over a resolved
// Subject. Nil means allowed; non-nil is a sentinel from this package or wraps
// ErrPermissionDenied with the missing bit, so callers map it to their own status.

// ErrArchived is returned for a write to, or client surface for, an archived channel.
var ErrArchived = errors.New("channel is archived")

// ErrThreadLocked is returned for a post or reaction in a locked thread without MANAGE_MESSAGES.
var ErrThreadLocked = errors.New("thread is locked")

// ErrBlocked is returned when either DM party has blocked the other.
var ErrBlocked = errors.New("user is blocked")

// ErrNotVoiceChannel is returned by CanJoinVoice for a channel type with no voice room.
var ErrNotVoiceChannel = errors.New("not a voice channel")

// ErrNSFWUnacknowledged is returned by CanReadContent for an unacknowledged labelled channel.
var ErrNSFWUnacknowledged = errors.New("nsfw content not acknowledged")

// ErrTimedOut is returned for a subject with an active timeout.
var ErrTimedOut = errors.New("user is timed out")

// ErrPasswordRequired is returned by CanPassChannelPassword when the channel password is not yet entered.
var ErrPasswordRequired = errors.New("channel password required")

// Subject is everything a channel predicate consults. The zero value has no
// role and no membership, which every predicate refuses.
type Subject struct {
	// RolePerms is the OR of every held role's mask.
	RolePerms int64
	Override  ChannelOverride
	// Layers is the per-role breakdown, set only for a multi-role member with an
	// override here. When non-nil the role layer is the OR over Layers and
	// Override.Allow/Deny must be zero; UserAllow/UserDeny still apply after.
	Layers  []RoleGrant
	Channel ChannelRef // Type and Archived; ID is not consulted
	// DMBlocked means the 1:1 counterpart cannot be reached (service.RequireDMReachable).
	DMParticipant bool
	DMBlocked     bool
	// NSFWAcknowledged is resolved live, never from a cache, so a revocation
	// takes effect on the next read.
	NSFWAcknowledged bool
	// TimedOut is never filled from the permission cache or for an Administrator;
	// it gates sends, reactions and voice joins regardless of channel bits.
	TimedOut bool
}

// Has reports whether the subject's effective permission holds every bit of
// perm. Administrator bypasses the overrides, but a zero perm is never held.
func (s Subject) Has(perm int64) bool {
	return perm != 0 && (HasAdmin(s.RolePerms) || HasPerm(s.EffectivePerms(), perm))
}

// EffectivePerms is the subject's resolved permission set before the Administrator bypass.
func (s Subject) EffectivePerms() int64 {
	if s.Layers != nil {
		return MemberChannelPerms(s.Layers, s.Override.UserAllow, s.Override.UserDeny)
	}
	return EffectiveChannelPerms(s.RolePerms, s.Override)
}

// missing wraps ErrPermissionDenied with the bit a caller names in its FORBIDDEN
// message; for a multi-bit perm, the one listed as the reason (SEND for READ|SEND).
func missing(named int64) error {
	return fmt.Errorf("%w: missing %s", ErrPermissionDenied, Name(named))
}

// dmMember refuses a non-participant; no role bypasses it.
func dmMember(s Subject) error {
	if !s.DMParticipant {
		return ErrNotDMParticipant
	}
	return nil
}

// CanViewChannel is channel visibility for the sidebar, ready payload, replay
// and fan-out. Permission is checked before the archive flag so an unauthorized
// caller learns nothing from the error; archived channels are hidden from everyone.
func CanViewChannel(s Subject) error {
	if s.Channel.Type == "dm" {
		return dmMember(s)
	}
	if !s.Has(ReadMessages) {
		return missing(ReadMessages)
	}
	if s.Channel.Archived {
		return ErrArchived
	}
	return nil
}

// IsChannelPrivate reports whether the default role cannot read the channel.
// Only the role layer applies, since a member override is per-viewer; an
// archived channel is judged on permissions alone.
func IsChannelPrivate(defaultRolePerms int64, o ChannelOverride) bool {
	return !Subject{
		RolePerms: defaultRolePerms,
		Override:  ChannelOverride{Allow: o.Allow, Deny: o.Deny},
	}.Has(ReadMessages)
}

// CanAdmitSession is CanViewChannel for a live socket attaching to a channel.
func CanAdmitSession(s Subject) error { return CanViewChannel(s) }

// CanSendMessage is the post policy: READ and SEND, plus MANAGE for
// announcements, never into an archive; for a DM, membership and no block.
func CanSendMessage(s Subject) error {
	if s.TimedOut {
		return ErrTimedOut
	}
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
		if s.DMBlocked {
			return ErrBlocked
		}
		return nil
	}
	if !s.Has(ReadMessages | SendMessages) {
		return missing(SendMessages)
	}
	if s.Channel.Type == "announcement" && !s.Has(ManageMessages) {
		return missing(ManageMessages)
	}
	if s.Channel.Archived {
		return ErrArchived
	}
	if s.Channel.ThreadLocked && !s.Has(ManageMessages) {
		return ErrThreadLocked
	}
	return nil
}

// CanType is CanSendMessage.
func CanType(s Subject) error { return CanSendMessage(s) }

// CanAddReaction is ADD_REACTIONS with READ_MESSAGES, never while timed out.
func CanAddReaction(s Subject) error {
	if s.TimedOut {
		return ErrTimedOut
	}
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
		if s.DMBlocked {
			return ErrBlocked
		}
		return nil
	}
	if !s.Has(ReadMessages | AddReactions) {
		return missing(AddReactions)
	}
	if s.Channel.ThreadLocked && !s.Has(ManageMessages) {
		return ErrThreadLocked
	}
	return nil
}

// CanDeleteMessage is the delete policy: READ and MANAGE delete anyone's
// message (asModerator); the author needs only READ, so a muted or timed-out
// author can still delete their own. In a DM membership is the whole rule.
func CanDeleteMessage(s Subject, isAuthor bool) (asModerator bool, err error) {
	if s.Channel.Type == "dm" {
		return false, dmMember(s)
	}
	if s.Has(ReadMessages | ManageMessages) {
		return true, nil
	}
	if isAuthor && s.Has(ReadMessages) {
		return false, nil
	}
	return false, missing(ManageMessages)
}

// CanPinMessage is the pin policy: READ and MANAGE, deliberately ignoring the
// timeout; in a DM, membership, then block, then timeout.
func CanPinMessage(s Subject) error {
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
		if s.DMBlocked {
			return ErrBlocked
		}
		if s.TimedOut {
			return ErrTimedOut
		}
		return nil
	}
	if !s.Has(ReadMessages | ManageMessages) {
		return missing(ManageMessages)
	}
	return nil
}

// CanMentionRole allows an @role ping when the role is mentionable or the
// author holds READ_MESSAGES and MENTION_EVERYONE.
func CanMentionRole(s Subject, mentionable bool) error {
	if mentionable || s.Has(ReadMessages|MentionEveryone) {
		return nil
	}
	return missing(MentionEveryone)
}

// CanPassChannelPassword is the extra lock on a password-protected voice
// channel for a member's own join; it passes when unprotected, already
// granted, or the subject holds MANAGE_CHANNELS.
func CanPassChannelPassword(s Subject, protected, granted bool) error {
	if !protected || granted || s.Has(ManageChannels) {
		return nil
	}
	return ErrPasswordRequired
}

// CanJoinVoice gates the LiveKit credential: CONNECT_VOICE, READ_MESSAGES for a
// non-DM channel (a hidden room is not joinable), a channel with a room, for a
// DM membership and no block, and no archive (an evicted participant must not
// rejoin). Members already in the room use CanStayInVoice.
func CanJoinVoice(s Subject) error {
	if s.TimedOut {
		return ErrTimedOut
	}
	if !s.Has(ConnectVoice) {
		return missing(ConnectVoice)
	}
	if s.Channel.Type != "dm" && !s.Has(ReadMessages) {
		return missing(ReadMessages)
	}
	switch s.Channel.Type {
	case "dm":
		if err := dmMember(s); err != nil {
			return err
		}
		if s.DMBlocked {
			return ErrBlocked
		}
	case "voice":
	default:
		return ErrNotVoiceChannel
	}
	if s.Channel.Archived {
		return ErrArchived
	}
	return nil
}

// CanStayInVoice is CanJoinVoice minus the timeout: a timed-out member already
// in the room is server-muted, not evicted.
func CanStayInVoice(s Subject) error {
	s.TimedOut = false
	return CanJoinVoice(s)
}

// CanModerate gates the report queue and moderator actions: MODERATE_MEMBERS or
// Administrator, server-wide. Channel overrides must never grant or strip it.
func CanModerate(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ModerateMembers) {
		return nil
	}
	return missing(ModerateMembers)
}

// CanManageChannels gates editing the channel list: MANAGE_CHANNELS or
// Administrator; a channel override can neither grant nor strip it.
func CanManageChannels(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ManageChannels) {
		return nil
	}
	return missing(ManageChannels)
}

// CanModerateVoice is the actor's authority in the TARGET's channel: effective
// MUTE_MEMBERS (so a channel deny holds) and READ_MESSAGES; a DM call also
// requires participation. Rank stays with the caller.
func CanModerateVoice(s Subject) error {
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
	}
	if !s.Has(ReadMessages | MuteMembers) {
		return missing(MuteMembers)
	}
	return nil
}

// AuthorizeVoiceModerator is the canonical voice-moderation check: the actor's
// BASE role must hold MUTE_MEMBERS (or Administrator), because a channel-scoped
// allow must never manufacture authority the base role never held; then
// CanModerateVoice.
func AuthorizeVoiceModerator(s Subject) error {
	if !HasServerPerm(s.RolePerms, MuteMembers) {
		return missing(MuteMembers)
	}
	return CanModerateVoice(s)
}

// CanMoveVoice is the actor's authority to move a member out of the TARGET's
// channel: effective MOVE_MEMBERS (so a channel deny holds) and READ_MESSAGES;
// a DM call also requires participation. Rank is not part of it.
func CanMoveVoice(s Subject) error {
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
	}
	if !s.Has(ReadMessages | MoveMembers) {
		return missing(MoveMembers)
	}
	return nil
}

// AuthorizeVoiceMover is the only authorizer of the move command: the BASE role
// must hold MOVE_MEMBERS explicitly (a channel allow cannot manufacture it;
// neither MUTE_MEMBERS nor ADMINISTRATOR opens a move) and CanMoveVoice must pass.
func AuthorizeVoiceMover(s Subject) error {
	if err := VoiceMoverBase(s.RolePerms); err != nil {
		return err
	}
	return CanMoveVoice(s)
}

// VoiceMoverBase is AuthorizeVoiceMover's base-role half: MOVE_MEMBERS held explicitly.
func VoiceMoverBase(rolePerms int64) error {
	if !HasPerm(rolePerms, MoveMembers) {
		return missing(MoveMembers)
	}
	return nil
}

// CanChangeOwnerGrantOnly reports whether a principal may change the
// OwnerGrantOnly bits on a role or hand them out via a role: the owner or an
// Administrator; MANAGE_ROLES or the bit itself is not enough. topRoleID and
// topRolePosition are the principal's top role; rolePerms is the OR of all held roles.
func CanChangeOwnerGrantOnly(rolePerms, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasAdmin(rolePerms)
}

// CanManageBackups reports whether a principal may create or list backups and
// issue or redeem a download link: the owner or a MANAGE_BACKUPS holder
// (Administrator passes). Restore, delete and the full archive are not part of it.
func CanManageBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasServerPerm(rolePerms, ManageBackups)
}

// CanReadContent is CanViewChannel plus the NSFW consent gate; no bit or admin
// bypass skips it, and an invisible channel never yields this sentinel.
func CanReadContent(s Subject) error {
	if err := CanViewChannel(s); err != nil {
		return err
	}
	if s.Channel.NSFW && !s.NSFWAcknowledged {
		return ErrNSFWUnacknowledged
	}
	return nil
}
