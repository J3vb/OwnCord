package permissions

import (
	"errors"
	"fmt"
)

// One predicate per security property (B2-5). Each is a pure function over a
// Subject the caller has already resolved — no context, no store — so a call
// site cannot drift by re-deriving half the rule: ready's can_send, the
// composer refresh, typing, the send path and the plugin gate all ask
// CanSendMessage the same question. A nil result is "allowed"; a non-nil one
// is a sentinel from this package (or wraps ErrPermissionDenied with the
// missing bit's name) so each call site keeps mapping denials to its own
// status codes and messages.

// ErrArchived is returned for a write to, or a client surface for, an archived
// channel. History stays readable, so read paths do not consult it.
var ErrArchived = errors.New("channel is archived")

// ErrThreadLocked is returned for a post or reaction in a locked thread by a
// member without MANAGE_MESSAGES (6.9c).
var ErrThreadLocked = errors.New("thread is locked")

// ErrBlocked is returned when either DM party has blocked the other.
var ErrBlocked = errors.New("user is blocked")

// ErrNotVoiceChannel is returned by CanJoinVoice for a channel type that has
// no voice room (text, announcement).
var ErrNotVoiceChannel = errors.New("not a voice channel")

// ErrNSFWUnacknowledged is returned by CanReadContent for a labelled channel
// the subject has not acknowledged (decision 13, BG-18's server half, B5-7).
// Every content path — REST reads, search, live/replayed socket delivery,
// attachment bytes — reports this identically; the caller maps it to its own
// status code (403 NSFW_ACKNOWLEDGEMENT_REQUIRED on the REST/attachment
// surfaces; the socket and search simply withhold the content).
var ErrNSFWUnacknowledged = errors.New("nsfw content not acknowledged")

// ErrTimedOut is returned by CanSendMessage, CanAddReaction and CanJoinVoice
// for a subject with an active timeout row (B5-9, decision 6): a time-boxed
// restriction distinct from a ban, checked through the predicates like every
// other property rather than a scattered per-handler check.
var ErrTimedOut = errors.New("user is timed out")

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
	// THIS subject has a row acknowledging the channel's label (B5-7). The
	// caller resolves it live, never from a cache — CanReadContent's whole
	// point is that a revocation takes effect on the very next read.
	NSFWAcknowledged bool
	// TimedOut ("an active timeout row exists for this subject") is filled
	// by permissions.Checker.Subject from a live lookup and by
	// service.PermissionService.Subject from its active-timeout mirror,
	// reloaded by every timeout write and judged against the clock (P5-O02)
	// — never from the 30s permission cache, and never for an Administrator
	// (B5-9, decision 6). It gates
	// CanSendMessage, CanAddReaction and CanJoinVoice independent of every
	// channel-scoped bit: a timeout is a restriction on the subject, not a
	// property of any one channel.
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

// IsChannelPrivate is the channel-level lock verdict (3D-6): a channel is
// private when the default role cannot read it. defaultRolePerms is the
// default (is_default) role's base permissions and o the channel's override
// for that role; only the role layer applies — a per-member override is
// per-viewer, and the verdict is the same for every recipient. It is
// Subject.Has, so an Administrator default role is never private and an
// override's allow still beats its deny. An archived channel is judged on its
// permissions alone: the lock describes who may read, not whether it is listed.
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

// CanType is CanSendMessage (S-01): a typing indicator announces a post, so a
// member who cannot post cannot announce one.
func CanType(s Subject) error { return CanSendMessage(s) }

// CanAddReaction is ADD_REACTIONS in the channel (with READ_MESSAGES), never
// while timed out; for a DM, membership and no block. AddReaction/
// RemoveReaction route through this instead of a bare HasChannelPerm bitmask
// check (B5-9), so reacting gets the same timeout restriction a send does —
// today's survey found the reaction handler resolved this bit inside
// effective perms with no predicate of its own.
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

// CanMentionRole is the @role ping policy (WP 6.3f-1): a role may be pinged
// when it is flagged mentionable, or when the author holds READ_MESSAGES and
// MENTION_EVERYONE in the channel (the same bits an @everyone needs). A refusal
// is not an error for the message: the caller leaves the token as plain text,
// raises no badge and lists the role nowhere. mentionable is the role's own
// flag, read by the caller.
func CanMentionRole(s Subject, mentionable bool) error {
	if mentionable || s.Has(ReadMessages|MentionEveryone) {
		return nil
	}
	return missing(MentionEveryone)
}

// CanJoinVoice gates the LiveKit credential: CONNECT_VOICE in the channel
// (required for DM calls too — the role bit was always demanded on top of
// membership, so this can only ever narrow), READ_MESSAGES for a non-DM
// channel so a room hidden from a member (CanViewChannel) is not joinable, a
// channel that has a room, for a DM membership plus no block, and no archive
// for either kind — the admin
// PATCH accepts `archived` for any channel type, and an evicted participant
// must not rejoin the archived room. Applies at join and to the target
// of a moderator move; a member already in the room (token refresh, the
// stale-voice sweep) is held to CanStayInVoice, which ignores the timeout.
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

// CanStayInVoice is CanJoinVoice for a member already in the room: every
// rule of the join gate except the timeout. A timeout's voice half is a
// server-mute applied only when the moderator could moderate voice
// (service.ModerationService.Timeout), so a timed-out member who is already
// in a room is not evicted — they cannot JOIN one (CanJoinVoice), but the
// session they hold ends only for a reason that would refuse it on its own:
// a lost CONNECT_VOICE or READ_MESSAGES, a ban or block, an archived or
// deleted channel. Used by the stale-voice sweep and the token refresh.
func CanStayInVoice(s Subject) error {
	s.TimedOut = false
	return CanJoinVoice(s)
}

// CanModerate is the report queue and B5-9's moderator-action gate:
// MODERATE_MEMBERS or Administrator, server-wide. Deliberately independent of
// s.Has/EffectiveChannelPerms — moderation authority is not a channel
// property, and a channel override must never be able to grant or strip it.
// This is the canonical predicate path B5-8/B5-9 route through
// (Server/invariants/authz_chokepoint.go forbids a raw permissions.HasServerPerm
// call anywhere else for this decision).
func CanModerate(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ModerateMembers) {
		return nil
	}
	return missing(ModerateMembers)
}

// CanManageChannels is the gate on everything that edits the channel list and
// on the channel_categories view (WP 6.5a): MANAGE_CHANNELS or Administrator,
// server-wide. Like CanModerate it reads the role only; a per-channel override
// can neither grant nor strip it. The ws hub asks it at send time to decide
// which connected clients may be told the full category list, empty and
// hidden categories included.
func CanManageChannels(s Subject) error {
	if HasAdmin(s.RolePerms) || HasPerm(s.RolePerms, ManageChannels) {
		return nil
	}
	return missing(ManageChannels)
}

// CanModerateVoice is the actor's authority in the TARGET's channel:
// effective MUTE_MEMBERS there (so a per-channel deny holds — SEC-02), and
// READ_MESSAGES so a moderator can only act in a room they can see; a DM call
// additionally requires the actor to be a participant. Rank is not a
// permission and stays with the caller (the strict-outranks check).
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
// site needs ahead of CanModerateVoice, combined with the predicate itself
// into one canonical check (round 4, Codex review Part C — the pair was
// duplicated between ws.voiceModTarget and the timeout voice half's own
// authorization, each with its own raw HasServerPerm call). The actor's
// BASE role must hold MUTE_MEMBERS (or Administrator) on its own:
// CanModerateVoice's s.Has(MuteMembers) is a channel-scoped OR that a
// channel override CAN satisfy even when the base role lacks the bit
// (deliberate — B2-5, matching CanSendMessage's announcement-channel
// precedent) — but a channel-scoped allow must never be able to manufacture
// voice-moderation authority the actor's base role never held at all.
func AuthorizeVoiceModerator(s Subject) error {
	if !HasServerPerm(s.RolePerms, MuteMembers) {
		return missing(MuteMembers)
	}
	return CanModerateVoice(s)
}

// CanMoveVoice is the actor's authority to move a member out of the TARGET's
// channel: effective MOVE_MEMBERS there (so a per-channel deny holds) and
// READ_MESSAGES so the room is visible to the mover; a DM call additionally
// requires the actor to be a participant. Rank is deliberately not part of
// it: a mover may move any member. MOVE_MEMBERS must be held explicitly:
// ADMINISTRATOR does not stand in for it, so taking the bit off a role stops
// that role moving anyone (it still passes READ_MESSAGES).
func CanMoveVoice(s Subject) error {
	if s.Channel.Type == "dm" {
		if err := dmMember(s); err != nil {
			return err
		}
	}
	if !s.Has(ReadMessages) || !HasPerm(s.EffectivePerms(), MoveMembers) {
		return missing(MoveMembers)
	}
	return nil
}

// AuthorizeVoiceMover is the only authorizer of the move command: the
// actor's BASE role must hold MOVE_MEMBERS explicitly on its own, and
// CanMoveVoice must pass in the channel. A channel-scoped allow cannot
// manufacture move authority the base role never held. Neither MUTE_MEMBERS
// nor ADMINISTRATOR opens a move.
func AuthorizeVoiceMover(s Subject) error {
	if err := VoiceMoverBase(s.RolePerms); err != nil {
		return err
	}
	return CanMoveVoice(s)
}

// VoiceMoverBase is AuthorizeVoiceMover's base-role half on its own: the
// actor's roles hold MOVE_MEMBERS explicitly (ADMINISTRATOR is not enough).
// A caller that has not resolved the channel yet uses it to know the move
// path is open; the channel verdict still comes from AuthorizeVoiceMover on
// the resolved subject, since READ_MESSAGES may come from a channel allow.
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
// backups and issue a backup download link (and redeem it): the owner (by role
// identity, see IsOwner, no bit needed) or anyone whose effective roles hold
// MANAGE_BACKUPS (an Administrator passes like for every bit). Restore,
// delete, the full archive, the backup policy, updates, tokens and config are
// not part of it. topRoleID and topRolePosition are the principal's top role;
// rolePerms is the OR of every role they hold.
func CanManageBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasServerPerm(rolePerms, ManageBackups)
}

// CanReadContent is CanViewChannel plus B5-7's NSFW consent gate: a labelled
// channel returns no content — message bodies and metadata that carries them
// (history, around, pins, reaction users, search hits, live and replayed
// chat_message/chat_edited/reaction_update frames) and attachment bytes —
// until the subject's own row exists. It is CanViewChannel's caller that
// decides whether a channel is visible at all; this only adds the narrower
// consent question on top, so a channel that is not visible is still
// ErrNotDMParticipant/missing(ReadMessages)/ErrArchived, never this sentinel.
//
// Decision 13: no bit and no admin bypass skips this — a moderator or
// administrator acknowledges like anyone else, so the caller resolves
// NSFWAcknowledged from the row the same way for every subject.
func CanReadContent(s Subject) error {
	if err := CanViewChannel(s); err != nil {
		return err
	}
	if s.Channel.NSFW && !s.NSFWAcknowledged {
		return ErrNSFWUnacknowledged
	}
	return nil
}
