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

func text(archived bool) ChannelRef        { return ChannelRef{Type: "text", Archived: archived} }
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
	for _, c := range cases {
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
		{"text channel is not voice", Subject{RolePerms: memberBits, Channel: text(false)}, ErrNotVoiceChannel},
		{"archived voice refused", Subject{RolePerms: memberBits, Channel: voice(true)}, ErrArchived},
		{"unauthorized never learns archived", Subject{RolePerms: ReadMessages, Channel: voice(true)}, ErrPermissionDenied},
		{"dm call needs CONNECT bit too", Subject{Channel: dm(), DMParticipant: true}, ErrPermissionDenied},
		{"dm participant with CONNECT joins", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true}, nil},
		{"dm non-participant refused", Subject{RolePerms: Administrator, Channel: dm()}, ErrNotDMParticipant},
		{"dm blocked refused", Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true, DMBlocked: true}, ErrBlocked},
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
