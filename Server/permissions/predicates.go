package permissions

import (
	"errors"
	"fmt"
)

// One predicate per security property. Each is a pure function over an
// already-resolved Subject (no context, no store), so call sites cannot drift
// by re-deriving half the rule. A nil result is "allowed"; a non-nil one is a
// sentinel from this package (or wraps ErrPermissionDenied with the missing
// bit's name) so each caller keeps mapping denials to its own status codes.

// ErrArchived is returned for a write to, or a client surface for, an archived
// channel. History stays readable, so read paths do not consult it.
var ErrArchived = errors.New("channel is archived")

// ErrThreadLocked is returned for a post or reaction in a locked thread by a
// member without MANAGE_MESSAGES.
var ErrThreadLocked = errors.New("thread is locked")

// ErrBlocked is returned when either DM party has blocked the other.
var ErrBlocked = errors.New("user is blocked")

// ErrNotVoiceChannel is returned by CanJoinVoice for a channel type that has
// no voice room (text, announcement).
var ErrNotVoiceChannel = errors.New("not a voice channel")

// ErrNSFWUnacknowledged is returned by CanReadContent for a labelled channel
// the subject has not acknowledged. Every content path reports it identically;
// the caller maps it to its own status (403 NSFW_ACKNOWLEDGEMENT_REQUIRED on
// REST/attachments; the socket and search simply withhold the content).
var ErrNSFWUnacknowledged = errors.New("nsfw content not acknowledged")

// ErrTimedOut is returned by CanSendMessage, CanAddReaction and CanJoinVoice
// for a subject with an active timeout row: a time-boxed restriction distinct
// from a ban.
var ErrTimedOut = errors.New("user is timed out")

// ErrPasswordRequired is returned by CanPassChannelPassword for a voice channel
// that has a password the subject has not entered yet.
var ErrPasswordRequired = errors.New("channel password required")

// Subject is everything a channel predicate consults: the actor's role bits,
// both override layers for the one channel in question, the channel's flags,
// and — for a DM — the membership and block state the caller looked up. The
// zero value is a subject with no role and no membership, which every
// predicate refuses.
type Subject struct {
	// RolePerms is the OR of every held role's mask. It decides the
	// Administrator bypass and, when Layers is nil, is the base the single
	// role-layer formula runs over.
	RolePerms int64
	Override  ChannelOverride
	// Layers is the per-held-role breakdown for this one channel, set only
	// when the member holds two or more roles and at least one has an
	// override here. Nil means today's formula over RolePerms and
	// Override.Allow/Deny (every single-role member). When non-nil the role
	// layer is the OR over Layers and Override.Allow/Deny must be zero;
	// Override.UserAllow/UserDeny still apply after it.
	Layers  []RoleGrant
	Channel ChannelRef // Type and Archived; ID is not consulted
	// DMParticipant and DMBlocked are consulted only when Channel.Type is
	// "dm". DMBlocked means the 1:1 counterpart cannot be reached by this
	// actor (service.RequireDMReachable). Group DMs pass DMBlocked=false.
	DMParticipant bool
	DMBlocked     bool
	// NSFWAcknowledged is consulted only when Channel.NSFW is set: whether
	// THIS subject has acknowledged the channel's label. The caller resolves it
	// live, never from a cache, so a revocation takes effect on the next read.
	NSFWAcknowledged bool
	// TimedOut ("an active timeout row exists for this subject") is filled from
	// a live lookup by permissions.Checker.Subject and from the active-timeout
	// mirror by service.PermissionService.Subject, never from the 30s
	// permission cache and never for an Administrator. It gates CanSendMessage,
	// CanAddReaction and CanJoinVoice independent of every channel-scoped bit:
	// a timeout restricts the subject, not any one channel.
	TimedOut bool
}

// Has reports whether the subject's effective permission in the channel holds
// every bit of perm. Administrator bypasses both override layers, but a zero
// perm is never held, administrator included. This is the single value-taking
// bit predicate — Checker and PermissionService resolve a Subject and ask it.
func (s Subject) Has(perm int64) bool {
	return perm != 0 && (HasAdmin(s.RolePerms) || HasPerm(s.EffectivePerms(), perm))
}

// EffectivePerms is the subject's resolved permission set in the channel,
// before the Administrator bypass: the single role layer (Layers nil) or the
// OR over every held role's own layer, then the member override.
func (s Subject) EffectivePerms() int64 {
	if s.Layers != nil {
		return MemberChannelPerms(s.Layers, s.Override.UserAllow, s.Override.UserDeny)
	}
	return EffectiveChannelPerms(s.RolePerms, s.Override)
}

// missing wraps ErrPermissionDenied with the bit a caller would name in its
// own FORBIDDEN message. For a multi-bit perm the named bit is the last one
// the caller listed as the "reason" (SEND for READ|SEND).
func missing(named int64) error {
	return fmt.Errorf("%w: missing %s", ErrPermissionDenied, Name(named))
}

// dmMember refuses a non-participant. Every DM rule starts here and nothing
// about the role bypasses it — an administrator is not in someone else's DM.
func dmMember(s Subject) error {
	if !s.DMParticipant {
		return ErrNotDMParticipant
	}
	return nil
}

// CanViewChannel is visibility: what the sidebar lists, the ready payload
// carries, reconnect replay filters to, and channel-scoped fan-out reaches.
// Permission is checked before the archive flag so an unauthorized caller
// learns nothing about the channel from the error; archived channels are then
// hidden from everyone, admins included (they stay manageable from the admin
// panel, which does not use this predicate).
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

// IsChannelPrivate reports whether a channel is private: the default role
// cannot read it. defaultRolePerms is the default (is_default) role's base
// permissions and o the channel's override for that role; only the role layer
// applies, since a per-member override is per-viewer. It is Subject.Has, so an
// Administrator default role is never private and an override's allow still
// beats its deny. An archived channel is judged on permissions alone.
func IsChannelPrivate(defaultRolePerms int64, o ChannelOverride) bool {
	return !Subject{
		RolePerms: defaultRolePerms,
		Override:  ChannelOverride{Allow: o.Allow, Deny: o.Deny},
	}.Has(ReadMessages)
}

// CanAdmitSession decides whether a live socket may attach to a channel's
// stream (channel_focus, the post-Subscribe revalidation). It is
// CanViewChannel by definition: a session sees exactly what the user sees.
func CanAdmitSession(s Subject) error { return CanViewChannel(s) }

// CanSendMessage is the post policy: READ and SEND in the channel, MANAGE on
// top for announcement channels, never into an archive; for a DM, membership
// and no block in either direction. SendMessage, EditMessage, CanPost, the
// ready payload's can_send, the composer refresh and typing all delegate here.
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

// CanType is CanSendMessage: a typing indicator announces a post, so a
// member who cannot post cannot announce one.
func CanType(s Subject) error { return CanSendMessage(s) }

// CanAddReaction is ADD_REACTIONS in the channel (with READ_MESSAGES), never
// while timed out; for a DM, membership and no block. Reactions route through
// this rather than a bare bitmask check so they get the same timeout
// restriction a send does.
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

// CanDeleteMessage is the delete policy for one message. READ and MANAGE in
// the channel delete anyone's message, as a moderation action (asModerator);
// the author needs only READ, so a member whose SEND was taken away, or who is
// timed out, can still remove what they wrote, while a denied READ blocks it.
// In a DM membership is the whole rule and the delete is never a moderation
// action, so the store's ownership check still applies. The archive gate is
// the caller's shared write gate, not this predicate.
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

// CanPinMessage is the pin and unpin policy for a channel. A non-DM channel
// needs READ and MANAGE there; the timeout is deliberately not consulted, so a
// timed-out moderator keeps the verdict enforcement has always given them. In
// a DM, membership then no block then no timeout decide, in that order, and
// MANAGE is not involved. The archive gate is the caller's shared write gate,
// not this predicate, as for CanDeleteMessage.
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

// CanMentionRole is the @role ping policy: a role may be pinged when it is
// flagged mentionable, or when the author holds READ_MESSAGES and
// MENTION_EVERYONE in the channel. A refusal is not an error for the message:
// the caller leaves the token as plain text, raises no badge and lists the
// role nowhere. mentionable is the role's own flag, read by the caller.
func CanMentionRole(s Subject, mentionable bool) error {
	if mentionable || s.Has(ReadMessages|MentionEveryone) {
		return nil
	}
	return missing(MentionEveryone)
}

// CanPassChannelPassword is the extra lock on a password-protected voice
// channel, asked only when a member joins on their own (not for a moderator's
// move, the AFK move or a token refresh). It passes when the channel has no
// password, when the subject already entered the current one (granted), or
// when the subject holds MANAGE_CHANNELS in the channel (Subject.Has includes
// the Administrator bypass), since they can read and change the password
// anyway. Otherwise it answers ErrPasswordRequired. The role rules still
// decide whether the subject may join at all (CanJoinVoice).
func CanPassChannelPassword(s Subject, protected, granted bool) error {
	if !protected || granted || s.Has(ManageChannels) {
		return nil
	}
	return ErrPasswordRequired
}

// CanJoinVoice gates the LiveKit credential: CONNECT_VOICE in the channel
// (required for DM calls too, so this can only narrow), READ_MESSAGES for a
// non-DM channel so a room hidden from the member is not joinable, a channel
// that has a room, for a DM membership plus no block, and no archive for
// either kind (an evicted participant must not rejoin an archived room).
// Applies at join and to the target of a moderator move; a member already in
// the room (token refresh, stale-voice sweep) is held to CanStayInVoice, which
// ignores the timeout.
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

// CanStayInVoice is CanJoinVoice for a member already in the room: every rule
// of the join gate except the timeout. A timeout's voice half is a server-mute
// applied only when the moderator could moderate voice
// (service.ModerationService.Timeout), so a timed-out member already in a room
// is not evicted; their session ends only for a reason that would refuse it on
// its own (lost CONNECT_VOICE or READ_MESSAGES, ban or block, archived or
// deleted channel). Used by the stale-voice sweep and the token refresh.
func CanStayInVoice(s Subject) error {
	s.TimedOut = false
	return CanJoinVoice(s)
}

// CanModerate is the report queue and moderator-action gate: MODERATE_MEMBERS
// or Administrator, server-wide. Deliberately independent of
// s.Has/EffectiveChannelPerms: moderation authority is not a channel property,
// and a channel override must never grant or strip it. Server/invariants/
// authz_chokepoint.go forbids a raw permissions.HasServerPerm call elsewhere
// for this decision.
func CanModerate(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ModerateMembers) {
		return nil
	}
	return missing(ModerateMembers)
}

// CanManageChannels is the gate on everything that edits the channel list and
// on the channel_categories view: MANAGE_CHANNELS or Administrator,
// server-wide. Like CanModerate it reads the role only; a per-channel override
// can neither grant nor strip it. The ws hub asks it at send time to decide
// which clients may be told the full category list, empty and hidden
// categories included.
func CanManageChannels(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ManageChannels) {
		return nil
	}
	return missing(ManageChannels)
}

// CanModerateVoice is the actor's authority in the TARGET's channel: effective
// MUTE_MEMBERS there (so a per-channel deny holds) and READ_MESSAGES so a
// moderator can only act in a room they can see; a DM call also requires the
// actor to be a participant. Rank stays with the caller (the strict-outranks
// check).
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

// AuthorizeVoiceModerator is the base-bit gate every voice-moderation call
// site needs ahead of CanModerateVoice, combined with it into one canonical
// check. The actor's BASE role must hold MUTE_MEMBERS (or Administrator) on its
// own: CanModerateVoice's s.Has(MuteMembers) is a channel-scoped OR that an
// override can satisfy even when the base role lacks the bit (deliberate,
// matching CanSendMessage's announcement-channel precedent), but a
// channel-scoped allow must never manufacture voice-moderation authority the
// base role never held.
func AuthorizeVoiceModerator(s Subject) error {
	if !HasServerPerm(s.RolePerms, MuteMembers) {
		return missing(MuteMembers)
	}
	return CanModerateVoice(s)
}

// CanMoveVoice is the actor's authority to move a member out of the TARGET's
// channel: effective MOVE_MEMBERS there (so a per-channel deny holds) and
// READ_MESSAGES so the room is visible to the mover; a DM call also requires
// the actor to be a participant. Rank is deliberately not part of it. An
// Administrator ignores channel overrides here as everywhere; that the base
// role holds the bit explicitly is VoiceMoverBase's half.
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

// AuthorizeVoiceMover is the only authorizer of the move command: the actor's
// BASE role must hold MOVE_MEMBERS explicitly and CanMoveVoice must pass in the
// channel. A channel-scoped allow cannot manufacture move authority the base
// role never held. Neither MUTE_MEMBERS nor ADMINISTRATOR opens a move.
func AuthorizeVoiceMover(s Subject) error {
	if err := VoiceMoverBase(s.RolePerms); err != nil {
		return err
	}
	return CanMoveVoice(s)
}

// VoiceMoverBase is AuthorizeVoiceMover's base-role half on its own: the
// actor's roles hold MOVE_MEMBERS explicitly (ADMINISTRATOR is not enough). A
// caller that has not resolved the channel yet uses it to know the move path
// is open; the channel verdict still comes from AuthorizeVoiceMover, since
// READ_MESSAGES may come from a channel allow.
func VoiceMoverBase(rolePerms int64) error {
	if !HasPerm(rolePerms, MoveMembers) {
		return missing(MoveMembers)
	}
	return nil
}

// CanChangeOwnerGrantOnly reports whether a principal may add or remove the
// bits in OwnerGrantOnly on a role, or hand them out by assigning a role that
// carries them: the owner (by role identity, see IsOwner) or an
// Administrator. Holding MANAGE_ROLES, or the bit itself, is not enough.
// topRoleID and topRolePosition are the principal's top role; rolePerms is the
// OR of every role they hold.
func CanChangeOwnerGrantOnly(rolePerms, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasAdmin(rolePerms)
}

// CanManageBackups reports whether a principal may create a backup, list
// backups and issue or redeem a backup download link: the owner (by role
// identity, see IsOwner, no bit needed) or anyone whose effective roles hold
// MANAGE_BACKUPS (an Administrator passes like for every bit). Restore,
// delete, the full archive, the backup policy, updates, tokens and config are
// not part of it. topRoleID and topRolePosition are the principal's top role;
// rolePerms is the OR of every role they hold.
func CanManageBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasServerPerm(rolePerms, ManageBackups)
}

// CanReadContent is CanViewChannel plus the NSFW consent gate: a labelled
// channel returns no content (message bodies and metadata carrying them, live
// and replayed frames, attachment bytes) until the subject's own
// acknowledgement row exists. A channel that is not visible is still
// ErrNotDMParticipant/missing(ReadMessages)/ErrArchived, never this sentinel.
//
// No bit and no admin bypass skips this: a moderator or administrator
// acknowledges like anyone else, so the caller resolves NSFWAcknowledged from
// the row the same way for every subject.
func CanReadContent(s Subject) error {
	if err := CanViewChannel(s); err != nil {
		return err
	}
	if s.Channel.NSFW && !s.NSFWAcknowledged {
		return ErrNSFWUnacknowledged
	}
	return nil
}
