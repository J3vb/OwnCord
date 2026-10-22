package permissions

import (
	"context"
	"math/rand/v2"
	"testing"
)

// A subject with Layers == nil is today's formula over RolePerms and the
// single role-layer override, for every single-role member.
func TestSubjectHas_LayersNilEqualsToday(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	perms := []int64{ReadMessages, SendMessages, ManageMessages, ConnectVoice, MuteMembers, ReadMessages | SendMessages}
	for range 4000 {
		role, a, d, ua, ud := rng.Int64(), rng.Int64(), rng.Int64(), rng.Int64(), rng.Int64()
		if rng.IntN(4) == 0 {
			role |= Administrator
		} else {
			role &^= Administrator
		}
		o := ChannelOverride{Allow: a, Deny: d, UserAllow: ua, UserDeny: ud}
		s := Subject{RolePerms: role, Override: o}
		for _, p := range perms {
			want := HasAdmin(role) || HasPerm(EffectiveChannelPerms(role, o), p)
			if got := s.Has(p); got != want {
				t.Fatalf("Subject{%#x,%+v}.Has(%#x) = %v, want %v", role, o, p, got, want)
			}
		}
		// One layer is the same formula: the layered path agrees with Nil.
		one := Subject{RolePerms: role, Override: ChannelOverride{UserAllow: ua, UserDeny: ud},
			Layers: []RoleGrant{{Perms: role, Allow: a, Deny: d}}}
		for _, p := range perms {
			if one.Has(p) != s.Has(p) {
				t.Fatalf("one-layer subject disagrees with the nil-layers subject at %#x", p)
			}
		}
	}
}

// A role only ever adds permissions: adding a held role never removes a bit
// the member already had in the channel.
func TestMemberChannelPerms_RoleOnlyAdds(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	for range 4000 {
		g1 := RoleGrant{Perms: rng.Int64(), Allow: rng.Int64(), Deny: rng.Int64()}
		g2 := RoleGrant{Perms: rng.Int64(), Allow: rng.Int64(), Deny: rng.Int64()}
		ua, ud := rng.Int64(), rng.Int64()
		one := MemberChannelPerms([]RoleGrant{g1}, 0, 0)
		both := MemberChannelPerms([]RoleGrant{g1, g2}, 0, 0)
		if one&^both != 0 {
			t.Fatalf("adding a role removed bits %#x", one&^both)
		}
		// Order of the held roles never matters.
		if MemberChannelPerms([]RoleGrant{g1, g2}, ua, ud) != MemberChannelPerms([]RoleGrant{g2, g1}, ua, ud) {
			t.Fatal("role order changed the verdict")
		}
	}
	// The motivating case: Member denies READ on a private channel, a
	// Moderator without an override there still reads it.
	member := RoleGrant{Perms: ReadMessages | SendMessages, Deny: ReadMessages}
	mod := RoleGrant{Perms: ReadMessages | MuteMembers}
	if MemberChannelPerms([]RoleGrant{member}, 0, 0)&ReadMessages != 0 {
		t.Fatal("Member alone must not read the private channel")
	}
	if MemberChannelPerms([]RoleGrant{member, mod}, 0, 0)&ReadMessages == 0 {
		t.Fatal("Member plus Moderator must read the private channel")
	}
}

// The member layer applies AFTER the OR of the role layers, so a member deny
// beats a bit any held role grants, and a member allow beats a member deny.
func TestMemberChannelPerms_UserLayerAfterRoleOR(t *testing.T) {
	r1 := RoleGrant{Perms: ReadMessages}
	r2 := RoleGrant{Perms: SendMessages}
	if got := MemberChannelPerms([]RoleGrant{r1, r2}, 0, SendMessages); got&SendMessages != 0 || got&ReadMessages == 0 {
		t.Fatalf("user deny must strip the bit a role grants (got %#x)", got)
	}
	if got := MemberChannelPerms([]RoleGrant{r1, r2}, ConnectVoice, SendMessages|ConnectVoice); got&ConnectVoice == 0 {
		t.Fatalf("user allow must beat user deny on the same bit (got %#x)", got)
	}
	if got := MemberChannelPerms([]RoleGrant{r1}, ManageMessages, 0); got&ManageMessages == 0 {
		t.Fatalf("user allow must add a bit no role has (got %#x)", got)
	}
}

// ADMINISTRATOR in any held role bypasses every layer.
func TestAdminInAnyRoleBypasses(t *testing.T) {
	s := Subject{
		RolePerms: ReadMessages | Administrator, // OR of the two masks
		Override:  ChannelOverride{UserDeny: ReadMessages | SendMessages},
		Layers: []RoleGrant{
			{Perms: ReadMessages, Deny: ReadMessages},
			{Perms: Administrator},
		},
	}
	if !s.Has(ReadMessages|SendMessages|ManageChannels) || CanViewChannel(s) != nil {
		t.Fatal("an Administrator role below the top must bypass the other role's deny and the member deny")
	}
	if s.Has(0) {
		t.Fatal("a zero perm is never held, administrator included")
	}
}

// A member holding Member (READ denied on the private channel) and Moderator
// sees it; a Member-only user does not.
func TestVisibleChannelIDs_TwoRolesPrivateChannel(t *testing.T) {
	ck := NewChecker(newMockDB())
	channels := []ChannelRef{{ID: 1, Type: "text"}, {ID: 2, Type: "text"}}
	memberMask := ReadMessages | SendMessages
	modMask := ReadMessages | MuteMembers
	private := ChannelOverride{} // the member role's deny lives in the layer

	two := MemberGrants{
		Perms:     memberMask | modMask,
		Overrides: map[int64]ChannelOverride{2: private},
		Layers: map[int64][]RoleGrant{2: {
			{RoleID: 4, Perms: memberMask, Deny: ReadMessages},
			{RoleID: 3, Perms: modMask},
		}},
	}
	got := ck.VisibleChannelIDs(two, channels)
	if !got[1] || !got[2] {
		t.Fatalf("Member+Moderator must see both channels, got %v", got)
	}

	only := MemberGrants{Perms: memberMask, Overrides: map[int64]ChannelOverride{2: {Deny: ReadMessages}}}
	got = ck.VisibleChannelIDs(only, channels)
	if !got[1] || got[2] {
		t.Fatalf("Member alone must see #1 but not the private #2, got %v", got)
	}
}

// The live (uncached) path composes the same way as the batch path.
func TestCheckerSubject_TwoRolesLiveEqualsBatch(t *testing.T) {
	db := newMockDB()
	held := []RoleGrant{{RoleID: 3, Perms: ReadMessages | MuteMembers}, {RoleID: 4, Perms: ReadMessages | SendMessages}}
	db.channelPerms[chanRoleKey{10, 4}] = chanPerm{deny: ReadMessages}
	db.userPerms[chanUserKey{10, 7}] = chanPerm{deny: SendMessages}
	ck := NewChecker(db)

	sub, err := ck.Subject(context.Background(), held, 7, 10)
	if err != nil {
		t.Fatalf("Subject: %v", err)
	}
	if len(sub.Layers) != 2 {
		t.Fatalf("two roles with an override must resolve per role, got %+v", sub.Layers)
	}
	if !sub.Has(ReadMessages) || sub.Has(SendMessages) || !sub.Has(MuteMembers) {
		t.Fatalf("composition wrong: read=%v send=%v mute=%v", sub.Has(ReadMessages), sub.Has(SendMessages), sub.Has(MuteMembers))
	}
	// No role has an override there: no layers, the OR mask alone decides.
	sub, err = ck.Subject(context.Background(), held, 7, 11)
	if err != nil || sub.Layers != nil {
		t.Fatalf("no per-role override must leave Layers nil, got %+v, %v", sub.Layers, err)
	}
}

func TestExplain_PerRoleRows(t *testing.T) {
	s := Subject{
		RolePerms: memberBits | modBits,
		Channel:   text(false),
		Layers: []RoleGrant{
			{RoleID: 4, Perms: memberBits, Deny: ReadMessages},
			{RoleID: 3, Perms: modBits},
		},
	}
	d, err := Explain(ActionViewChannel, s)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Allowed {
		t.Fatalf("view must be allowed through the Moderator role: %+v", d)
	}
	if len(d.RoleBits) != 2 {
		t.Fatalf("want one row per held role for READ_MESSAGES, got %+v", d.RoleBits)
	}
	byRole := map[int64]RoleBitRule{}
	for _, r := range d.RoleBits {
		byRole[r.RoleID] = r
	}
	if r := byRole[4]; r.RoleOverride != "deny" || r.Effective {
		t.Errorf("Member row = %+v, want deny and not effective", r)
	}
	if r := byRole[3]; r.RoleOverride != "" || !r.Effective {
		t.Errorf("Moderator row = %+v, want no override and effective", r)
	}
	if !d.Bits[0].Effective {
		t.Errorf("effective bit = false, want true")
	}
	// A single-role subject keeps the single role-override column.
	d, _ = Explain(ActionViewChannel, Subject{RolePerms: memberBits, Override: deny(ReadMessages), Channel: text(false)})
	if d.RoleBits != nil || d.Bits[0].RoleOverride != "deny" {
		t.Errorf("single role must trace via RoleOverride only: %+v", d)
	}
}
