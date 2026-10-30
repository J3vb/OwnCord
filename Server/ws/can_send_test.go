package ws

import (
	"encoding/json"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// grantsFor builds the member grants a test case describes: the role's mask
// and one channel's override (channel id 0, the id of a bare db.Channel). A nil
// role is the zero grants.
func grantsFor(role *db.Role, o db.ChannelOverride) permissions.MemberGrants {
	if role == nil {
		return permissions.MemberGrants{}
	}
	return permissions.MemberGrants{
		Perms: role.Permissions,
		Overrides: map[int64]permissions.ChannelOverride{
			0: {Allow: o.Allow, Deny: o.Deny, UserAllow: o.UserAllow, UserDeny: o.UserDeny},
		},
	}
}

// TestChannelCanSend locks the composer-gating rule the client relies on:
// it must mirror MessageService.checkSendPermission for non-DM channels.
func TestChannelCanSend(t *testing.T) {
	admin := &db.Role{Permissions: permissions.Administrator}
	member := &db.Role{Permissions: permissions.ReadMessages | permissions.SendMessages}
	reader := &db.Role{Permissions: permissions.ReadMessages}
	mod := &db.Role{Permissions: permissions.ReadMessages | permissions.SendMessages | permissions.ManageMessages}
	none := db.ChannelOverride{}

	cases := []struct {
		name     string
		role     *db.Role
		o        db.ChannelOverride
		ctype    string
		timedOut bool
		want     bool
	}{
		{"nil role fails closed", nil, none, "text", false, false},
		{"admin bypasses on text", admin, none, "text", false, true},
		{"admin bypasses on announcement", admin, none, "announcement", false, true},
		{"member can post in text", member, none, "text", false, true},
		{"reader without SEND cannot post", reader, none, "text", false, false},
		{"member without MANAGE cannot post in announcement", member, none, "announcement", false, false},
		{"moderator can post in announcement", mod, none, "announcement", false, true},
		{"override deny SEND blocks text", member, db.ChannelOverride{Deny: permissions.SendMessages}, "text", false, false},
		{"override allow MANAGE enables announcement", member, db.ChannelOverride{Allow: permissions.ManageMessages}, "announcement", false, true},
		// OC-0434: a timed-out member must not get can_send: true anywhere,
		// even where the un-timed-out role would otherwise pass. TimedOut is
		// checked ahead of everything else in permissions.CanSendMessage
		// (predicates_test.go's "timed out beats admin"), so it beats even an
		// Administrator role passed in directly here.
		{"timed out member cannot post in text", member, none, "text", true, false},
		{"timed out member cannot post in announcement despite MANAGE override", member, db.ChannelOverride{Allow: permissions.ManageMessages}, "announcement", true, false},
		{"timed out beats admin", admin, none, "text", true, false},
	}
	for _, c := range cases {
		if got := channelCanSend(grantsFor(c.role, c.o), c.ctype, c.timedOut); got != c.want {
			t.Errorf("%s: channelCanSend = %v, want %v", c.name, got, c.want)
		}
		// B2-5 parity: the affordance is the canonical send predicate.
		var bits int64
		if c.role != nil {
			bits = c.role.Permissions
		}
		want := permissions.CanSendMessage(permissions.Subject{
			RolePerms: bits, Override: grantsFor(c.role, c.o).Overrides[0], Channel: permissions.ChannelRef{Type: c.ctype}, TimedOut: c.timedOut,
		}) == nil
		if want != c.want {
			t.Errorf("%s: CanSendMessage = %v, channelCanSend table says %v", c.name, want, c.want)
		}
	}
}

// TestChannelCanModerateVoice locks the ready payload's can_moderate_voice
// affordance (B9 Q5) to the authorizer voiceModTarget enforces: base
// MUTE_MEMBERS, then effective READ|MUTE_MEMBERS after both override layers.
func TestChannelCanModerateVoice(t *testing.T) {
	admin := &db.Role{Permissions: permissions.Administrator}
	mod := &db.Role{Permissions: permissions.ReadMessages | permissions.ConnectVoice | permissions.MuteMembers}
	member := &db.Role{Permissions: permissions.ReadMessages | permissions.ConnectVoice}
	none := db.ChannelOverride{}

	cases := []struct {
		name string
		role *db.Role
		o    db.ChannelOverride
		want bool
	}{
		{"nil role fails closed", nil, none, false},
		{"admin bypasses", admin, none, true},
		{"admin bypasses a MUTE deny", admin, db.ChannelOverride{Deny: permissions.MuteMembers}, true},
		{"moderator allowed", mod, none, true},
		{"member without MUTE denied", member, none, false},
		{"role deny MUTE denies", mod, db.ChannelOverride{Deny: permissions.MuteMembers}, false},
		{"user deny MUTE denies", mod, db.ChannelOverride{UserDeny: permissions.MuteMembers}, false},
		{"role deny READ denies", mod, db.ChannelOverride{Deny: permissions.ReadMessages}, false},
		{"user allow beats role deny", mod, db.ChannelOverride{Deny: permissions.MuteMembers, UserAllow: permissions.MuteMembers}, true},
		// A channel allow must not manufacture authority the base role never
		// held: the server refuses it, so the affordance must too.
		{"channel allow without base bit denied", member, db.ChannelOverride{Allow: permissions.MuteMembers}, false},
	}
	for _, c := range cases {
		if got := channelCanModerateVoice(grantsFor(c.role, c.o), "voice"); got != c.want {
			t.Errorf("%s: channelCanModerateVoice = %v, want %v", c.name, got, c.want)
		}
		var bits int64
		if c.role != nil {
			bits = c.role.Permissions
		}
		want := permissions.AuthorizeVoiceModerator(permissions.Subject{
			RolePerms: bits, Override: grantsFor(c.role, c.o).Overrides[0], Channel: permissions.ChannelRef{Type: "voice"},
		}) == nil
		if want != c.want {
			t.Errorf("%s: AuthorizeVoiceModerator = %v, table says %v", c.name, want, c.want)
		}
	}
}

// TestBuildErrorMsgWithID echoes the request id so the client can correlate a
// failure with the specific command it sent; an empty id omits the field.
func TestBuildErrorMsgWithID(t *testing.T) {
	withID := buildErrorMsgWithID(ErrCodeSlowMode, "slow down", "req-42")
	var env struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(withID, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.ID != "req-42" {
		t.Errorf("id = %q, want req-42", env.ID)
	}
	if env.Payload.Code != ErrCodeSlowMode {
		t.Errorf("code = %q, want %q", env.Payload.Code, ErrCodeSlowMode)
	}

	// Empty request id falls back to the id-less envelope.
	noID := buildErrorMsgWithID(ErrCodeSlowMode, "slow down", "")
	var raw map[string]any
	if err := json.Unmarshal(noID, &raw); err != nil {
		t.Fatalf("unmarshal noID: %v", err)
	}
	if _, present := raw["id"]; present {
		t.Error("empty reqID should omit the id field")
	}
}

// TestAffordancesFor locks the five per-viewer verdicts to the predicates they
// delegate to, one case per distinguishing subject. The DM-typed and timed-out
// rows are the ones the rules diverge on: a DM verdict never involves MANAGE,
// and a timeout flips send and react but not pin or delete-others.
func TestAffordancesFor(t *testing.T) {
	const (
		member = permissions.ReadMessages | permissions.SendMessages | permissions.AddReactions
		mod    = member | permissions.ManageMessages | permissions.MuteMembers
	)
	textCh := permissions.ChannelRef{Type: "text"}
	dmCh := permissions.ChannelRef{Type: "dm"}
	cases := []struct {
		name string
		sub  permissions.Subject
		want channelAffordances
	}{
		{"zero subject is all false", permissions.Subject{}, channelAffordances{}},
		{"member", permissions.Subject{RolePerms: member, Channel: textCh},
			channelAffordances{CanSend: true, CanReact: true}},
		{"moderator", permissions.Subject{RolePerms: mod, Channel: textCh},
			channelAffordances{CanSend: true, CanModerateVoice: true, CanDeleteOthers: true, CanPin: true, CanReact: true}},
		{"moderator with a user deny of MANAGE", permissions.Subject{RolePerms: mod, Channel: textCh, Override: permissions.ChannelOverride{UserDeny: permissions.ManageMessages}},
			channelAffordances{CanSend: true, CanModerateVoice: true, CanReact: true}},
		{"role deny of ADD_REACTIONS", permissions.Subject{RolePerms: member, Channel: textCh, Override: permissions.ChannelOverride{Deny: permissions.AddReactions}},
			channelAffordances{CanSend: true}},
		{"administrator without MOVE_MEMBERS does not move", permissions.Subject{RolePerms: permissions.Administrator, Channel: textCh},
			channelAffordances{CanSend: true, CanModerateVoice: true, CanDeleteOthers: true, CanPin: true, CanReact: true}},
		{"administrator with MOVE_MEMBERS", permissions.Subject{RolePerms: permissions.Administrator | permissions.MoveMembers, Channel: textCh},
			channelAffordances{CanSend: true, CanModerateVoice: true, CanMoveVoice: true, CanDeleteOthers: true, CanPin: true, CanReact: true}},
		{"MOVE_MEMBERS without MUTE_MEMBERS moves but does not moderate", permissions.Subject{RolePerms: member | permissions.MoveMembers, Channel: textCh},
			channelAffordances{CanSend: true, CanMoveVoice: true, CanReact: true}},
		{"timed-out moderator keeps pin and delete-others", permissions.Subject{RolePerms: mod, Channel: textCh, TimedOut: true},
			channelAffordances{CanModerateVoice: true, CanDeleteOthers: true, CanPin: true}},
		{"DM participant: pin and react, never delete-others", permissions.Subject{Channel: dmCh, DMParticipant: true},
			channelAffordances{CanSend: true, CanPin: true, CanReact: true}},
		{"timed-out DM participant", permissions.Subject{Channel: dmCh, DMParticipant: true, TimedOut: true},
			channelAffordances{}},
		{"blocked DM participant", permissions.Subject{Channel: dmCh, DMParticipant: true, DMBlocked: true},
			channelAffordances{}},
		{"DM non-participant, even an administrator", permissions.Subject{RolePerms: permissions.Administrator, Channel: dmCh},
			channelAffordances{}},
	}
	for _, c := range cases {
		if got := affordancesFor(c.sub); got != c.want {
			t.Errorf("%s: affordancesFor = %+v, want %+v", c.name, got, c.want)
		}
	}
}
