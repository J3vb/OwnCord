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

// ErrBlocked is returned when either DM party has blocked the other.
var ErrBlocked = errors.New("user is blocked")

// ErrNotVoiceChannel is returned by CanJoinVoice for a channel type that has
// no voice room (text, announcement).
var ErrNotVoiceChannel = errors.New("not a voice channel")

// Subject is everything a channel predicate consults: the actor's role bits,
// both override layers for the one channel in question, the channel's flags,
// and — for a DM — the membership and block state the caller looked up. The
// zero value is a subject with no role and no membership, which every
// predicate refuses.
type Subject struct {
	RolePerms int64
	Override  ChannelOverride
	Channel   ChannelRef // Type and Archived; ID is not consulted
	// DMParticipant and DMBlocked are consulted only when Channel.Type is
	// "dm". Group DMs pass DMBlocked=false — blocks are enforced at group
	// creation, not per message (service.requireDMNotBlocked).
	DMParticipant bool
	DMBlocked     bool
}

// Has reports whether the subject's effective permission in the channel holds
// every bit of perm. Administrator bypasses both override layers; a zero perm
// is never held. This is the single value-taking bit predicate — Checker and
// PermissionService resolve a Subject and ask it.
func (s Subject) Has(perm int64) bool {
	return HasAdmin(s.RolePerms) || HasPerm(EffectiveChannelPerms(s.RolePerms, s.Override), perm)
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

// CanAdmitSession decides whether a live socket may attach to a channel's
// stream (channel_focus, the post-Subscribe revalidation). It is
// CanViewChannel by definition: a session sees exactly what the user sees.
func CanAdmitSession(s Subject) error { return CanViewChannel(s) }

// CanSendMessage is the post policy: READ and SEND in the channel, MANAGE on
// top for announcement channels, never into an archive; for a DM, membership
// and no block in either direction. SendMessage, EditMessage, CanPost, the
// ready payload's can_send, the composer refresh and typing all delegate here.
func CanSendMessage(s Subject) error {
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
	return nil
}

// CanType is CanSendMessage (S-01): a typing indicator announces a post, so a
// member who cannot post cannot announce one.
func CanType(s Subject) error { return CanSendMessage(s) }

// CanJoinVoice gates the LiveKit credential: CONNECT_VOICE in the channel
// (required for DM calls too — the role bit was always demanded on top of
// membership, so this can only ever narrow), a channel that has a room, for
// a DM membership plus no block, and no archive for either kind — the admin
// PATCH accepts `archived` for any channel type, and an evicted participant
// must not rejoin the archived room. Applies at join, at token refresh, to
// the target of a moderator move, and in the stale-voice sweep.
func CanJoinVoice(s Subject) error {
	if !s.Has(ConnectVoice) {
		return missing(ConnectVoice)
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
