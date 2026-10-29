package permissions

import (
	"errors"
	"testing"
)

// Each predicate is one security property. The tables below are the property
// stated as cases; every call site that used to hand-roll a copy of the rule
// now delegates here and carries a parity test against these verdicts.

const (
	memberBits = ReadMessages | SendMessages | ConnectVoice
	modBits    = memberBits | ManageMessages | MuteMembers
)

func text(archived bool) ChannelRef { return ChannelRef{Type: "text", Archived: archived} }
func nsfwText(archived bool) ChannelRef {
	return ChannelRef{Type: "text", Archived: archived, NSFW: true}
}
func announcement() ChannelRef             { return ChannelRef{Type: "announcement"} }
func voice(archived bool) ChannelRef       { return ChannelRef{Type: "voice", Archived: archived} }
func dm() ChannelRef                       { return ChannelRef{Type: "dm"} }
func deny(bits int64) ChannelOverride      { return ChannelOverride{Deny: bits} }
func userDeny(bits int64) ChannelOverride  { return ChannelOverride{UserDeny: bits} }
func allow(bits int64) ChannelOverride     { return ChannelOverride{Allow: bits} }
func userAllow(bits int64) ChannelOverride { return ChannelOverride{UserAllow: bits} }

type predicateCase struct {
	name string
	s    Subject
	want error // nil = allowed; otherwise errors.Is(got, want)
}

func runPredicate(t *testing.T, name string, fn func(Subject) error, cases []predicateCase) {
	t.Helper()
	for i := range cases {
		c := &cases[i]
		got := fn(c.s)
		if c.want == nil && got != nil {
			t.Errorf("%s/%s: want allowed, got %v", name, c.name, got)
		}
		if c.want != nil && !errors.Is(got, c.want) {
			t.Errorf("%s/%s: want %v, got %v", name, c.name, c.want, got)
		}
	}
}

func TestCanViewChannel(t *testing.T) {
	runPredicate(t, "CanViewChannel", CanViewChannel, []predicateCase{
		{"member reads text", Subject{RolePerms: memberBits, Channel: text(false)}, nil},
		{"no role fails closed", Subject{Channel: text(false)}, ErrPermissionDenied},
		{"role deny READ hides", Subject{RolePerms: memberBits, Override: deny(ReadMessages), Channel: text(false)}, ErrPermissionDenied},
		{"user deny READ hides", Subject{RolePerms: memberBits, Override: userDeny(ReadMessages), Channel: text(false)}, ErrPermissionDenied},
		{"user allow beats role deny", Subject{RolePerms: memberBits, Override: ChannelOverride{Deny: ReadMessages, UserAllow: ReadMessages}, Channel: text(false)}, nil},
		{"admin bypasses deny", Subject{RolePerms: Administrator, Override: deny(ReadMessages), Channel: text(false)}, nil},
		{"archived hidden from members", Subject{RolePerms: memberBits, Channel: text(true)}, ErrArchived},
		{"archived hidden from admins", Subject{RolePerms: Administrator, Channel: text(true)}, ErrArchived},
		{"unauthorized never learns archived", Subject{Channel: text(true)}, ErrPermissionDenied},
		{"dm participant sees", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant blind, even admin", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm ignores block", Subject{Channel: dm(), DMParticipant: true, DMBlocked: true}, nil},
	})
}

func TestCanSendMessage(t *testing.T) {
	cases := []predicateCase{
		{"member posts in text", Subject{RolePerms: memberBits, Channel: text(false)}, nil},
		{"reader without SEND refused", Subject{RolePerms: ReadMessages, Channel: text(false)}, ErrPermissionDenied},
		{"SEND without READ refused", Subject{RolePerms: SendMessages, Channel: text(false)}, ErrPermissionDenied},
		{"role deny SEND refused", Subject{RolePerms: memberBits, Override: deny(SendMessages), Channel: text(false)}, ErrPermissionDenied},
		{"user deny SEND refused", Subject{RolePerms: memberBits, Override: userDeny(SendMessages), Channel: text(false)}, ErrPermissionDenied},
		{"announcement needs MANAGE", Subject{RolePerms: memberBits, Channel: announcement()}, ErrPermissionDenied},
		{"moderator posts in announcement", Subject{RolePerms: modBits, Channel: announcement()}, nil},
		{"override allow MANAGE enables announcement", Subject{RolePerms: memberBits, Override: allow(ManageMessages), Channel: announcement()}, nil},
		{"user allow MANAGE enables announcement", Subject{RolePerms: memberBits, Override: userAllow(ManageMessages), Channel: announcement()}, nil},
		{"admin bypasses on announcement", Subject{RolePerms: Administrator, Channel: announcement()}, nil},
		{"archived refuses members", Subject{RolePerms: memberBits, Channel: text(true)}, ErrArchived},
		{"archived refuses admins", Subject{RolePerms: Administrator, Channel: text(true)}, ErrArchived},
		{"unauthorized never learns archived", Subject{RolePerms: ReadMessages, Channel: text(true)}, ErrPermissionDenied},
		{"dm participant posts without role bits", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm blocked refused", Subject{Channel: dm(), DMParticipant: true, DMBlocked: true}, ErrBlocked},
	}
	runPredicate(t, "CanSendMessage", CanSendMessage, cases)
	// CanType is CanSendMessage by definition (S-01): a typing indicator is
	// the first half of a post, so it answers to the same rule.
	runPredicate(t, "CanType", CanType, cases)
}

func TestCanAdmitSession(t *testing.T) {
	// Session admission (channel_focus / topic subscribe) is visibility.
	cases := []predicateCase{
		{"member admitted", Subject{RolePerms: memberBits, Channel: text(false)}, nil},
		{"archived refused", Subject{RolePerms: memberBits, Channel: text(true)}, ErrArchived},
		{"dm participant admitted", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused", Subject{Channel: dm()}, ErrNotDMParticipant},
	}
	runPredicate(t, "CanAdmitSession", CanAdmitSession, cases)
	runPredicate(t, "CanViewChannel(parity)", CanViewChannel, cases)
}

func TestCanJoinVoice(t *testing.T) {
	runPredicate(t, "CanJoinVoice", CanJoinVoice, []predicateCase{
		{"member joins voice", Subject{RolePerms: memberBits, Channel: voice(false)}, nil},
		{"no CONNECT refused", Subject{RolePerms: ReadMessages, Channel: voice(false)}, ErrPermissionDenied},
		{"role deny CONNECT refused", Subject{RolePerms: memberBits, Override: deny(ConnectVoice), Channel: voice(false)}, ErrPermissionDenied},
		{"user deny CONNECT refused", Subject{RolePerms: memberBits, Override: userDeny(ConnectVoice), Channel: voice(false)}, ErrPermissionDenied},
		{"admin bypasses deny", Subject{RolePerms: Administrator, Override: deny(ConnectVoice), Channel: voice(false)}, nil},
		// A voice channel hidden by denying only READ_MESSAGES stays closed:
		// joining would put the member in a room they cannot see.
		{"role deny READ refused", Subject{RolePerms: memberBits, Override: deny(ReadMessages), Channel: voice(false)}, ErrPermissionDenied},
		{"user deny READ refused", Subject{RolePerms: memberBits, Override: userDeny(ReadMessages), Channel: voice(false)}, ErrPermissionDenied},
		{"CONNECT without READ refused", Subject{RolePerms: ConnectVoice, Channel: voice(false)}, ErrPermissionDenied},
		{"text channel is not voice", Subject{RolePerms: memberBits, Channel: text(false)}, ErrNotVoiceChannel},
		{"archived voice refused", Subject{RolePerms: memberBits, Channel: voice(true)}, ErrArchived},
		{"unauthorized never learns archived", Subject{RolePerms: ReadMessages, Channel: voice(true)}, ErrPermissionDenied},
		{"dm call needs CONNECT bit too", Subject{Channel: dm(), DMParticipant: true}, ErrPermissionDenied},
		{"dm participant with CONNECT joins", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm blocked refused", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true, DMBlocked: true}, ErrBlocked},
		// The admin PATCH accepts archived for any channel type, and the old
		// voice_join gate refused every archived channel — an evicted
		// participant must not rejoin an archived DM call (Codex P2, #1440).
		{"archived dm call refused", Subject{RolePerms: ConnectVoice, Channel: ChannelRef{Type: "dm", Archived: true}, DMParticipant: true}, ErrArchived},
		{"archived dm non-participant learns nothing", Subject{RolePerms: ConnectVoice, Channel: ChannelRef{Type: "dm", Archived: true}}, ErrNotDMParticipant},
	})
}

func TestCanModerateVoice(t *testing.T) {
	runPredicate(t, "CanModerateVoice", CanModerateVoice, []predicateCase{
		{"moderator with MUTE in channel", Subject{RolePerms: modBits, Channel: voice(false)}, nil},
		{"no MUTE refused", Subject{RolePerms: memberBits, Channel: voice(false)}, ErrPermissionDenied},
		{"role deny MUTE in this channel refused", Subject{RolePerms: modBits, Override: deny(MuteMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"user deny MUTE in this channel refused", Subject{RolePerms: modBits, Override: userDeny(MuteMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"channel hidden from moderator refused", Subject{RolePerms: modBits, Override: deny(ReadMessages), Channel: voice(false)}, ErrPermissionDenied},
		{"admin bypasses deny", Subject{RolePerms: Administrator, Override: deny(MuteMembers), Channel: voice(false)}, nil},
		{"dm call needs actor membership", Subject{RolePerms: modBits, Channel: dm()}, ErrNotDMParticipant},
		{"dm participant moderator allowed", Subject{RolePerms: modBits, Channel: dm(), DMParticipant: true}, nil},
		{"dm participant without MUTE refused", Subject{RolePerms: memberBits, Channel: dm(), DMParticipant: true}, ErrPermissionDenied},
	})
}

// TestAuthorizeVoiceModerator pins the round-4 canonical authorizer
// (Codex review Part C): the actor's BASE role must hold MUTE_MEMBERS on
// its own, a stricter gate than CanModerateVoice's channel-scoped OR
// alone — a channel override cannot manufacture voice-moderation authority
// a role never held at all.
func TestAuthorizeVoiceModerator(t *testing.T) {
	runPredicate(t, "AuthorizeVoiceModerator", AuthorizeVoiceModerator, []predicateCase{
		{"moderator with base MUTE_MEMBERS allowed", Subject{RolePerms: modBits, Channel: voice(false)}, nil},
		{"no MUTE_MEMBERS at all refused", Subject{RolePerms: memberBits, Channel: voice(false)}, ErrPermissionDenied},
		{"channel override alone cannot manufacture the base bit", Subject{RolePerms: memberBits, Override: allow(MuteMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"admin without the base bit allowed via the Administrator bypass", Subject{RolePerms: Administrator, Channel: voice(false)}, nil},
		{"base bit present but a channel deny still refuses", Subject{RolePerms: modBits, Override: deny(MuteMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"base bit present but channel hidden still refuses", Subject{RolePerms: modBits, Override: deny(ReadMessages), Channel: voice(false)}, ErrPermissionDenied},
	})
}

// TestAuthorizeVoiceMover pins WP 8.4a's move authorizer: the actor's BASE
// role must hold MOVE_MEMBERS (MUTE_MEMBERS no longer suffices), a channel
// override cannot manufacture it, a channel deny still holds, and
// Administrator passes the base gate.
func TestAuthorizeVoiceMover(t *testing.T) {
	const moverBits = memberBits | MoveMembers
	runPredicate(t, "AuthorizeVoiceMover", AuthorizeVoiceMover, []predicateCase{
		{"mover with base MOVE_MEMBERS allowed", Subject{RolePerms: moverBits, Channel: voice(false)}, nil},
		{"MUTE_MEMBERS alone refused", Subject{RolePerms: modBits, Channel: voice(false)}, ErrPermissionDenied},
		{"no bits refused", Subject{RolePerms: memberBits, Channel: voice(false)}, ErrPermissionDenied},
		{"channel override alone cannot manufacture the base bit", Subject{RolePerms: memberBits, Override: allow(MoveMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"admin without the base bit allowed via the Administrator bypass", Subject{RolePerms: Administrator, Channel: voice(false)}, nil},
		{"base bit present but a channel deny still refuses", Subject{RolePerms: moverBits, Override: deny(MoveMembers), Channel: voice(false)}, ErrPermissionDenied},
		{"base bit present but channel hidden still refuses", Subject{RolePerms: moverBits, Override: deny(ReadMessages), Channel: voice(false)}, ErrPermissionDenied},
		{"dm non-participant refused", Subject{RolePerms: moverBits, Channel: dm()}, ErrNotDMParticipant},
	})
}

// TestCanMoveVoice pins the channel half of the move gate: READ_MESSAGES plus
// MOVE_MEMBERS effective in the channel.
func TestCanMoveVoice(t *testing.T) {
	runPredicate(t, "CanMoveVoice", CanMoveVoice, []predicateCase{
		{"holder allowed", Subject{RolePerms: ReadMessages | MoveMembers, Channel: voice(false)}, nil},
		{"MUTE_MEMBERS alone refused", Subject{RolePerms: ReadMessages | MuteMembers, Channel: voice(false)}, ErrPermissionDenied},
		{"MOVE_MEMBERS without READ refused", Subject{RolePerms: MoveMembers, Channel: voice(false)}, ErrPermissionDenied},
	})
}

func TestCanChangeOwnerGrantOnly(t *testing.T) {
	cases := []struct {
		name  string
		perms int64
		id    int64
		pos   int
		want  bool
	}{
		{"owner role", 0, OwnerRoleID, OwnerRolePosition, true},
		{"owner position on a renumbered role", 0, 77, OwnerRolePosition, true},
		{"administrator below the owner", Administrator, AdminRoleID, 80, true},
		{"manage roles holding the bit", ManageRoles | MoveMembers, ModeratorRoleID, 60, false},
		{"zero perms", 0, MemberRoleID, 40, false},
	}
	for _, c := range cases {
		if got := CanChangeOwnerGrantOnly(c.perms, c.id, c.pos); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// TestCanManageBackups pins WP 8.4c's gate for create, list and link: the
// owner (by role identity, no bit needed), a holder of MANAGE_BACKUPS, or an
// Administrator. MANAGE_SERVER and MANAGE_ROLES alone do not open it.
func TestCanManageBackups(t *testing.T) {
	cases := []struct {
		name  string
		perms int64
		id    int64
		pos   int
		want  bool
	}{
		{"owner without the bit", 0, OwnerRoleID, OwnerRolePosition, true},
		{"owner position on a renumbered role", 0, 77, OwnerRolePosition, true},
		{"holder of the bit", ManageBackups, 9, 50, true},
		{"holder via the OR of several roles", ReadMessages | ManageBackups, MemberRoleID, 40, true},
		{"administrator without the bit", Administrator, AdminRoleID, 80, true},
		{"manage server alone", ManageServer, 9, 50, false},
		{"manage roles alone", ManageRoles, 9, 50, false},
		{"zero perms", 0, MemberRoleID, 40, false},
	}
	for _, c := range cases {
		if got := CanManageBackups(c.perms, c.id, c.pos); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// TestCanChangeOwnerGrantOnly_ManageBackupsHolder: holding MANAGE_BACKUPS
// (with MANAGE_ROLES) is not enough to change it.
func TestCanChangeOwnerGrantOnly_ManageBackupsHolder(t *testing.T) {
	if CanChangeOwnerGrantOnly(ManageRoles|ManageBackups, ModeratorRoleID, 60) {
		t.Error("a MANAGE_ROLES holder of MANAGE_BACKUPS must not change owner-grant-only bits")
	}
}

// TestCanModerate pins the queue's gate: MODERATE_MEMBERS or Administrator,
// server-wide, and — unlike every channel predicate above — never moved by a
// channel override, because moderation authority is not a channel property.
func TestCanModerate(t *testing.T) {
	runPredicate(t, "CanModerate", CanModerate, []predicateCase{
		{"holder allowed", Subject{RolePerms: ModerateMembers}, nil},
		{"no bit refused", Subject{RolePerms: memberBits}, ErrPermissionDenied},
		{"admin without the bit allowed", Subject{RolePerms: Administrator}, nil},
		{"channel override cannot grant it", Subject{RolePerms: memberBits, Override: allow(ModerateMembers), Channel: text(false)}, ErrPermissionDenied},
		{"channel override cannot strip it", Subject{RolePerms: ModerateMembers, Override: deny(ModerateMembers), Channel: text(false)}, nil},
	})
}

func TestCanManageChannels(t *testing.T) {
	runPredicate(t, "CanManageChannels", CanManageChannels, []predicateCase{
		{"holder allowed", Subject{RolePerms: ManageChannels}, nil},
		{"administrator without the bit allowed", Subject{RolePerms: Administrator}, nil},
		{"no bit refused", Subject{RolePerms: memberBits}, ErrPermissionDenied},
		{"zero subject refused", Subject{}, ErrPermissionDenied},
		{"channel override cannot grant it", Subject{RolePerms: memberBits, Override: allow(ManageChannels), Channel: text(false)}, ErrPermissionDenied},
		{"channel override cannot strip it", Subject{RolePerms: ManageChannels, Override: deny(ManageChannels), Channel: text(false)}, nil},
	})
}

// TestCanAddReaction pins the reaction gate (B5-9): ADD_REACTIONS with
// READ_MESSAGES, timed out refused unconditionally, and the same DM
// membership/block rule every other channel predicate applies.
func TestCanAddReaction(t *testing.T) {
	const reactBits = ReadMessages | AddReactions
	runPredicate(t, "CanAddReaction", CanAddReaction, []predicateCase{
		{"member reacts in text", Subject{RolePerms: reactBits, Channel: text(false)}, nil},
		{"reader without ADD_REACTIONS refused", Subject{RolePerms: ReadMessages, Channel: text(false)}, ErrPermissionDenied},
		{"ADD_REACTIONS without READ refused", Subject{RolePerms: AddReactions, Channel: text(false)}, ErrPermissionDenied},
		{"role deny ADD_REACTIONS refused", Subject{RolePerms: reactBits, Override: deny(AddReactions), Channel: text(false)}, ErrPermissionDenied},
		{"user deny ADD_REACTIONS refused", Subject{RolePerms: reactBits, Override: userDeny(AddReactions), Channel: text(false)}, ErrPermissionDenied},
		{"admin bypasses deny", Subject{RolePerms: Administrator, Override: deny(AddReactions), Channel: text(false)}, nil},
		{"dm participant reacts without role bits", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm blocked refused", Subject{Channel: dm(), DMParticipant: true, DMBlocked: true}, ErrBlocked},
		{"timed out refused in a channel", Subject{RolePerms: reactBits, Channel: text(false), TimedOut: true}, ErrTimedOut},
		{"timed out refused in a dm", Subject{Channel: dm(), DMParticipant: true, TimedOut: true}, ErrTimedOut},
		{"timed out beats admin", Subject{RolePerms: Administrator, Channel: text(false), TimedOut: true}, ErrTimedOut},
	})
}

// TestTimedOutSubject pins the TimedOut property on the two other predicates
// it gates: a blanket refusal ahead of every other check (B5-9, decision 6).
func TestTimedOutSubject(t *testing.T) {
	runPredicate(t, "CanSendMessage/timedOut", CanSendMessage, []predicateCase{
		{"timed out refused in text", Subject{RolePerms: memberBits, Channel: text(false), TimedOut: true}, ErrTimedOut},
		{"timed out refused in dm", Subject{Channel: dm(), DMParticipant: true, TimedOut: true}, ErrTimedOut},
		{"not timed out unaffected", Subject{RolePerms: memberBits, Channel: text(false)}, nil},
	})
	runPredicate(t, "CanJoinVoice/timedOut", CanJoinVoice, []predicateCase{
		{"timed out refused before CONNECT_VOICE is even checked", Subject{Channel: voice(false), TimedOut: true}, ErrTimedOut},
		{"timed out refused in a dm call", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true, TimedOut: true}, ErrTimedOut},
	})
}

func TestCanStayInVoice(t *testing.T) {
	runPredicate(t, "CanStayInVoice", CanStayInVoice, []predicateCase{
		{"timed out member keeps the seat", Subject{RolePerms: ConnectVoice | ReadMessages, Channel: voice(false), TimedOut: true}, nil},
		{"timed out dm call keeps the seat", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true, TimedOut: true}, nil},
		{"timed out without CONNECT_VOICE is still refused", Subject{RolePerms: ReadMessages, Channel: voice(false), TimedOut: true}, ErrPermissionDenied},
		{"timed out in an archived channel is still refused", Subject{RolePerms: ConnectVoice | ReadMessages, Channel: voice(true), TimedOut: true}, ErrArchived},
		{"timed out and blocked is still refused", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true, DMBlocked: true, TimedOut: true}, ErrBlocked},
	})
}

func TestCanReadContent(t *testing.T) {
	runPredicate(t, "CanReadContent", CanReadContent, []predicateCase{
		{"unlabelled channel needs no ack", Subject{RolePerms: memberBits, Channel: text(false)}, nil},
		{"labelled and acknowledged", Subject{RolePerms: memberBits, Channel: nsfwText(false), NSFWAcknowledged: true}, nil},
		{"labelled and not acknowledged", Subject{RolePerms: memberBits, Channel: nsfwText(false)}, ErrNSFWUnacknowledged},
		// Decision 13: no bit and no admin bypass skips the consent gate — an
		// administrator without a row is refused exactly like anyone else.
		{"admin without a row is refused", Subject{RolePerms: Administrator, Channel: nsfwText(false)}, ErrNSFWUnacknowledged},
		{"admin with a row is allowed", Subject{RolePerms: Administrator, Channel: nsfwText(false), NSFWAcknowledged: true}, nil},
		// Visibility is checked first: an unauthorized caller learns nothing
		// about the label, and archived still hides content entirely.
		{"no role fails closed before the label is even consulted", Subject{Channel: nsfwText(false)}, ErrPermissionDenied},
		{"archived labelled channel is ErrArchived, not the NSFW sentinel", Subject{RolePerms: memberBits, Channel: nsfwText(true)}, ErrArchived},
		// DMs cannot be labelled; a participant with no ack sees no gate.
		{"dm participant needs no ack", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant learns nothing", Subject{Channel: dm()}, ErrNotDMParticipant},
	})
}

// TestSubjectHas pins the one generic predicate every other one is built on:
// Administrator bypasses overrides, everything else is the resolved two-layer
// mask, and a zero perm is never held (matching HasPerm).
func TestSubjectHas(t *testing.T) {
	s := Subject{RolePerms: memberBits, Override: ChannelOverride{Deny: SendMessages, UserAllow: ManageMessages}}
	if !s.Has(ReadMessages) || s.Has(SendMessages) || !s.Has(ManageMessages) || s.Has(ReadMessages|SendMessages) {
		t.Fatal("Has must apply both override layers and be ALL-of")
	}
	if s.Has(0) {
		t.Fatal("zero perm is never held")
	}
	if !(Subject{RolePerms: Administrator, Override: deny(AllPerms)}).Has(ManageServer) {
		t.Fatal("Administrator bypasses overrides")
	}
}

func TestCanDeleteMessage(t *testing.T) {
	cases := []struct {
		name     string
		s        Subject
		isAuthor bool
		wantMod  bool
		want     error
	}{
		{"author with READ only deletes", Subject{RolePerms: ReadMessages, Channel: text(false)}, true, false, nil},
		{"author without SEND deletes", Subject{RolePerms: memberBits, Override: deny(SendMessages), Channel: text(false)}, true, false, nil},
		{"timed-out author deletes", Subject{RolePerms: memberBits, Channel: text(false), TimedOut: true}, true, false, nil},
		{"author denied READ refused", Subject{RolePerms: memberBits, Override: deny(ReadMessages), Channel: text(false)}, true, false, ErrPermissionDenied},
		{"member cannot delete others", Subject{RolePerms: memberBits, Channel: text(false)}, false, false, ErrPermissionDenied},
		{"moderator deletes others as moderation", Subject{RolePerms: modBits, Channel: text(false)}, false, true, nil},
		{"moderator deleting own is still moderation", Subject{RolePerms: modBits, Channel: text(false)}, true, true, nil},
		{"MANAGE without READ refused", Subject{RolePerms: ManageMessages, Channel: text(false)}, false, false, ErrPermissionDenied},
		{"channel deny MANAGE leaves author path", Subject{RolePerms: modBits, Override: deny(ManageMessages), Channel: text(false)}, true, false, nil},
		{"admin bypasses deny", Subject{RolePerms: Administrator, Override: deny(ReadMessages), Channel: text(false)}, false, true, nil},
		{"dm participant deletes, never as moderation", Subject{RolePerms: Administrator, Channel: dm(), DMParticipant: true}, false, false, nil},
		{"dm non-participant refused, even admin", Subject{RolePerms: Administrator, Channel: dm()}, true, false, ErrNotDMParticipant},
	}
	for _, c := range cases {
		gotMod, err := CanDeleteMessage(c.s, c.isAuthor)
		if c.want == nil && err != nil {
			t.Errorf("%s: want allowed, got %v", c.name, err)
		}
		if c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s: want %v, got %v", c.name, c.want, err)
		}
		if gotMod != c.wantMod {
			t.Errorf("%s: asModerator = %v, want %v", c.name, gotMod, c.wantMod)
		}
	}
}

func TestCanPinMessage(t *testing.T) {
	runPredicate(t, "CanPinMessage", CanPinMessage, []predicateCase{
		{"moderator pins", Subject{RolePerms: modBits, Channel: text(false)}, nil},
		{"member without MANAGE refused", Subject{RolePerms: memberBits, Channel: text(false)}, ErrPermissionDenied},
		{"role deny MANAGE refuses a moderator", Subject{RolePerms: modBits, Override: deny(ManageMessages), Channel: text(false)}, ErrPermissionDenied},
		{"user deny MANAGE refuses a moderator", Subject{RolePerms: modBits, Override: userDeny(ManageMessages), Channel: text(false)}, ErrPermissionDenied},
		{"role allow MANAGE lets a member pin", Subject{RolePerms: memberBits, Override: allow(ManageMessages), Channel: text(false)}, nil},
		{"user allow MANAGE lets a member pin", Subject{RolePerms: memberBits, Override: userAllow(ManageMessages), Channel: text(false)}, nil},
		{"user allow beats role deny", Subject{RolePerms: modBits, Override: ChannelOverride{Deny: ManageMessages, UserAllow: ManageMessages}, Channel: text(false)}, nil},
		{"deny READ refuses a moderator", Subject{RolePerms: modBits, Override: deny(ReadMessages), Channel: text(false)}, ErrPermissionDenied},
		{"MANAGE without READ refused", Subject{RolePerms: ManageMessages, Channel: text(false)}, ErrPermissionDenied},
		{"admin bypasses a deny", Subject{RolePerms: Administrator, Override: deny(ReadMessages | ManageMessages), Channel: text(false)}, nil},
		{"timed-out non-DM moderator is allowed", Subject{RolePerms: modBits, Channel: text(false), TimedOut: true}, nil},
		{"timed-out non-DM member still refused", Subject{RolePerms: memberBits, Channel: text(false), TimedOut: true}, ErrPermissionDenied},
		{"announcement follows the same rule", Subject{RolePerms: modBits, Channel: announcement()}, nil},
		{"dm participant pins without MANAGE", Subject{Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused, even admin", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm blocked refused", Subject{Channel: dm(), DMParticipant: true, DMBlocked: true}, ErrBlocked},
		{"dm timed out refused", Subject{Channel: dm(), DMParticipant: true, TimedOut: true}, ErrTimedOut},
		{"dm non-participant beats blocked", Subject{Channel: dm(), DMBlocked: true, TimedOut: true}, ErrNotDMParticipant},
		{"dm blocked beats timed out", Subject{Channel: dm(), DMParticipant: true, DMBlocked: true, TimedOut: true}, ErrBlocked},
		{"zero subject refused", Subject{}, ErrPermissionDenied},
	})
}

func TestCanMentionRole(t *testing.T) {
	runPredicate(t, "CanMentionRole", func(s Subject) error { return CanMentionRole(s, false) }, []predicateCase{
		{"member without the bit", Subject{RolePerms: memberBits, Channel: text(false)}, ErrPermissionDenied},
		{"MENTION_EVERYONE and READ", Subject{RolePerms: memberBits | MentionEveryone, Channel: text(false)}, nil},
		{"MENTION_EVERYONE without READ", Subject{RolePerms: SendMessages | MentionEveryone, Channel: text(false)}, ErrPermissionDenied},
		{"channel deny of MENTION_EVERYONE", Subject{RolePerms: memberBits | MentionEveryone, Override: deny(MentionEveryone), Channel: text(false)}, ErrPermissionDenied},
		{"channel allow of MENTION_EVERYONE", Subject{RolePerms: memberBits, Override: allow(MentionEveryone), Channel: text(false)}, nil},
		{"administrator", Subject{RolePerms: Administrator, Channel: text(false)}, nil},
		{"no role fails closed", Subject{Channel: text(false)}, ErrPermissionDenied},
	})
	// A mentionable role is pingable by anyone, bits or not.
	if err := CanMentionRole(Subject{RolePerms: memberBits, Channel: text(false)}, true); err != nil {
		t.Errorf("mentionable role refused a plain member: %v", err)
	}
	if err := CanMentionRole(Subject{}, true); err != nil {
		t.Errorf("mentionable role refused the zero subject: %v", err)
	}
}

func TestVoiceMoverBase(t *testing.T) {
	cases := []struct {
		name  string
		perms int64
		ok    bool
	}{
		{"move bit alone", MoveMembers, true},
		{"administrator", Administrator, true},
		{"mute only", MuteMembers | ReadMessages, false},
		{"none", 0, false},
	}
	for _, tc := range cases {
		if got := VoiceMoverBase(tc.perms) == nil; got != tc.ok {
			t.Errorf("%s: VoiceMoverBase(%#x) ok = %v, want %v", tc.name, tc.perms, got, tc.ok)
		}
	}
}

// ownerTypeCase is one row of the WP 8.4d predicate tables.
type ownerTypeCase struct {
	name  string
	perms int64
	id    int64
	pos   int
	want  bool
}

// ownerTierRows are the rows every owner-tier predicate shares, parameterised
// by its own bit: the owner by identity, the explicit holder, and the
// Administrator WITHOUT the bit, who must be refused (the seeded Admin has
// ADMINISTRATOR, and these actions were owner-only before they were bits).
func ownerTierRows(bit int64) []ownerTypeCase {
	return []ownerTypeCase{
		{"owner without the bit", 0, OwnerRoleID, OwnerRolePosition, true},
		{"owner position on a renumbered role", 0, 77, OwnerRolePosition, true},
		{"holder of the bit", bit, 9, 50, true},
		{"holder via the OR of several roles", ReadMessages | bit, MemberRoleID, 40, true},
		{"administrator without the bit", Administrator, AdminRoleID, 80, false},
		{"administrator with every other bit", AllPerms &^ bit, AdminRoleID, 80, false},
		{"manage roles and server alone", ManageRoles | ManageServer, 9, 50, false},
		{"zero perms", 0, MemberRoleID, 40, false},
	}
}

func TestOwnerTierPredicates(t *testing.T) {
	preds := []struct {
		name string
		bit  int64
		fn   func(int64, int64, int) bool
	}{
		{"CanRestoreBackups", RestoreBackups, CanRestoreBackups},
		{"CanManageConfig", ManageConfig, CanManageConfig},
		{"CanManageUpdates", ManageUpdates, CanManageUpdates},
		{"CanManageTokens", ManageTokens, CanManageTokens},
		{"CanIssueRecovery", IssueRecovery, CanIssueRecovery},
	}
	for _, p := range preds {
		for _, c := range ownerTierRows(p.bit) {
			if got := p.fn(c.perms, c.id, c.pos); got != c.want {
				t.Errorf("%s %s: got %v, want %v", p.name, c.name, got, c.want)
			}
		}
		// A different owner-tier bit never opens this predicate.
		for _, other := range []int64{RestoreBackups, ManageConfig, ManageUpdates, ManageTokens, IssueRecovery, ManageBackups} {
			if other == p.bit {
				continue
			}
			if p.fn(other, 9, 50) {
				t.Errorf("%s opened by unrelated bit 0x%X", p.name, other)
			}
		}
	}
}

func TestCanListBackups(t *testing.T) {
	cases := []ownerTypeCase{
		{"owner", 0, OwnerRoleID, OwnerRolePosition, true},
		{"manage backups holder", ManageBackups, 9, 50, true},
		{"restore backups holder", RestoreBackups, 9, 50, true},
		{"administrator without either bit", Administrator, AdminRoleID, 80, true},
		{"manage config alone", ManageConfig, 9, 50, false},
		{"zero perms", 0, MemberRoleID, 40, false},
	}
	for _, c := range cases {
		if got := CanListBackups(c.perms, c.id, c.pos); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// TestAdministratorTierPredicates: VIEW_DIAGNOSTICS and ERASE_ACCOUNTS keep
// the Administrator bypass (an Administrator already had both powers) and the
// bit lets a role without ADMINISTRATOR do just that one thing.
func TestAdministratorTierPredicates(t *testing.T) {
	preds := []struct {
		name string
		bit  int64
		fn   func(int64) bool
	}{
		{"CanViewDiagnostics", ViewDiagnostics, CanViewDiagnostics},
		{"CanEraseAccounts", EraseAccounts, CanEraseAccounts},
	}
	for _, p := range preds {
		for _, c := range []struct {
			name  string
			perms int64
			want  bool
		}{
			{"holder of the bit", p.bit, true},
			{"administrator without the bit", Administrator, true},
			{"manage server alone", ManageServer, false},
			{"the other tier's bit", (ViewDiagnostics | EraseAccounts) &^ p.bit, false},
			{"zero perms", 0, false},
		} {
			if got := p.fn(c.perms); got != c.want {
				t.Errorf("%s %s: got %v, want %v", p.name, c.name, got, c.want)
			}
		}
	}
}

// TestCanChangeOwnerOnlyGrant: only the owner changes an owner-tier bit; an
// Administrator, a MANAGE_ROLES holder and a holder of the bit do not.
func TestCanChangeOwnerOnlyGrant(t *testing.T) {
	if !CanChangeOwnerOnlyGrant(OwnerRoleID, OwnerRolePosition) {
		t.Error("the owner must be able to change owner-only grant bits")
	}
	if !CanChangeOwnerOnlyGrant(77, OwnerRolePosition) {
		t.Error("the owner position must be able to change owner-only grant bits")
	}
	for _, c := range []struct {
		name string
		id   int64
		pos  int
	}{{"administrator role", AdminRoleID, 80}, {"moderator role", ModeratorRoleID, 60}, {"custom role", 9, 50}} {
		if CanChangeOwnerOnlyGrant(c.id, c.pos) {
			t.Errorf("%s must not change owner-only grant bits", c.name)
		}
	}
}

// TestCanChangeOwnerGrantOnly_AdministratorTierBits: an Administrator may
// change VIEW_DIAGNOSTICS and ERASE_ACCOUNTS (they sit in OwnerGrantOnly) but
// a MANAGE_ROLES holder may not.
func TestCanChangeOwnerGrantOnly_AdministratorTierBits(t *testing.T) {
	if !CanChangeOwnerGrantOnly(Administrator, AdminRoleID, 80) {
		t.Error("an Administrator must be able to change administrator-tier bits")
	}
	if CanChangeOwnerGrantOnly(ManageRoles|ViewDiagnostics|EraseAccounts, ModeratorRoleID, 60) {
		t.Error("a MANAGE_ROLES holder of the bits must not change administrator-tier bits")
	}
}
