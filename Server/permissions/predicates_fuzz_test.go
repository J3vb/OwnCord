package permissions

import (
	"errors"
	"testing"
)

// Subject has no wire form — it is an in-memory value a caller resolves, so
// there is nothing to round-trip. What B2-5 established instead is PARITY:
// every call site that used to hand-roll a security rule now delegates to one
// predicate, and the parity tables in permissions/, service/ and ws/ pin each
// predicate's verdict case by case. This target is those tables continued by
// machine: it recomputes each verdict from the raw permission bits — the
// two-layer override formula written out longhand, not EffectiveChannelPerms
// — and demands the predicate agree, for arbitrary role bits, arbitrary
// override masks, arbitrary channel types and every combination of the
// archive and DM flags.
//
// The committed corpus is seeded from protocol/fixtures/epoch-1: the four
// role permission values the ready payload carries (Owner 2147483647,
// Admin 1073741823, Moderator 7340031, Member 7779) against the channel
// types those journeys use.

// rawEffective is EffectivePerms/EffectiveChannelPerms written out as the
// formula their doc comments state, so the parity check does not lean on the
// helper it is meant to be independent of.
func rawEffective(rolePerms int64, o ChannelOverride) int64 {
	roleLayer := (rolePerms &^ o.Deny) | o.Allow
	return (roleLayer &^ o.UserDeny) | o.UserAllow
}

// rawHas is Subject.Has written out longhand: the empty mask is never held
// (matching HasPerm), then the Administrator bypass, then the two-layer mask.
func rawHas(rolePerms int64, o ChannelOverride, perm int64) bool {
	if perm == 0 {
		return false
	}
	if rolePerms&Administrator != 0 {
		return true
	}
	return rawEffective(rolePerms, o)&perm == perm
}

// rawHasTwoRoles is Subject.Has for a member holding two roles, written out
// longhand: each role is resolved with its OWN channel override, the results
// are OR'd, the member override applies last, and Administrator in EITHER role
// bypasses. It leans on none of MemberChannelPerms, Layers or EffectivePerms.
func rawHasTwoRoles(r1, allow1, deny1, r2, allow2, deny2 int64, userAllow, userDeny, perm int64) bool {
	if perm == 0 {
		return false
	}
	if (r1|r2)&Administrator != 0 {
		return true
	}
	layer1 := (r1 &^ deny1) | allow1
	layer2 := (r2 &^ deny2) | allow2
	roleLayer := layer1 | layer2
	eff := (roleLayer &^ userDeny) | userAllow
	return eff&perm == perm
}

// TestSubjectHasZeroPermIsNeverHeld pins that Subject.Has agrees with HasPerm
// on the empty mask: it is never held, administrator or not, so a computed
// zero perm fails closed instead of passing the Administrator bypass.
func TestSubjectHasZeroPermIsNeverHeld(t *testing.T) {
	if HasPerm(Administrator, 0) {
		t.Fatal("HasPerm(_, 0) = true; the all-of rule on an empty mask must stay false")
	}
	if (Subject{RolePerms: Administrator}).Has(0) {
		t.Fatal("Subject.Has(0) = true for an administrator; a zero perm must never be held")
	}
	if (Subject{RolePerms: ReadMessages}).Has(0) {
		t.Fatal("Subject.Has(0) = true for a non-administrator")
	}
}

// wantErr asserts a predicate's verdict against the recomputed one: nil means
// allowed, anything else must be that sentinel (missing() wraps
// ErrPermissionDenied, so errors.Is is the right comparison).
func wantErr(t *testing.T, name string, s Subject, got, want error) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Fatalf("%s(%+v) = %v, want allowed", name, s, got)
	case want != nil && !errors.Is(got, want):
		t.Fatalf("%s(%+v) = %v, want %v", name, s, got, want)
	}
}

// sameVerdict reports whether two predicates answered identically. missing()
// builds a fresh error each call, so identity comparison would report a
// difference between two denials that are in fact the same one.
func sameVerdict(a, b error) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Error() == b.Error()
}

// FuzzPredicateParity checks every B2-5 predicate against the raw-bit
// computation it replaced, plus the two definitional identities the package
// documents: CanAdmitSession is CanViewChannel, and CanType is
// CanSendMessage.
func FuzzPredicateParity(f *testing.F) {
	// The four role permission values epoch-1's ready payload carries.
	const (
		owner  = int64(2147483647)
		admin  = int64(1073741823)
		mod    = int64(7340031)
		member = int64(7779)
	)
	types := []string{"text", "voice", "dm", "announcement", "", "TEXT"}
	roles := []int64{0, member, mod, admin, owner, -1, Administrator}
	for _, role := range roles {
		for _, typ := range types {
			f.Add(role, int64(0), int64(0), int64(0), int64(0), typ, false, false, false, int64(0), int64(0), int64(0), false)
			f.Add(role, int64(0), ReadMessages, int64(0), int64(0), typ, false, true, false, int64(0), int64(0), int64(0), false)
			f.Add(role, int64(0), int64(0), ManageMessages, SendMessages, typ, true, true, true, int64(0), int64(0), int64(0), false)
			f.Add(role, ConnectVoice, MuteMembers, int64(0), ReadMessages, typ, true, false, true, int64(0), int64(0), int64(0), false)
		}
	}

	// Two-role subjects: a member holding Member and Moderator, where Member
	// denies READ on a private channel and Moderator is not on that override.
	f.Add(member, int64(0), ReadMessages, int64(0), int64(0), "text", false, false, false, mod, int64(0), int64(0), true)
	f.Add(member, int64(0), ReadMessages, int64(0), ReadMessages, "text", false, false, false, mod, int64(0), int64(0), true)
	f.Add(member, int64(0), int64(0), int64(0), int64(0), "voice", false, false, false, int64(0), ConnectVoice, SendMessages, true)
	f.Add(int64(0), int64(0), int64(0), int64(0), int64(0), "text", false, false, false, Administrator, int64(0), ReadMessages, true)

	f.Fuzz(func(t *testing.T,
		rolePerms, allow, deny, userAllow, userDeny int64,
		chanType string,
		archived, dmParticipant, dmBlocked bool,
		role2Perms, allow2, deny2 int64, twoRoles bool,
	) {
		o := ChannelOverride{Allow: allow, Deny: deny, UserAllow: userAllow, UserDeny: userDeny}
		s := Subject{
			RolePerms:     rolePerms,
			Override:      o,
			Channel:       ChannelRef{Type: chanType, Archived: archived},
			DMParticipant: dmParticipant,
			DMBlocked:     dmBlocked,
		}
		has := func(perm int64) bool { return rawHas(rolePerms, o, perm) }
		if twoRoles {
			// The Subject a two-role member resolves to: the OR of the masks,
			// one layer per held role, only the member layer in Override.
			s.RolePerms = rolePerms | role2Perms
			s.Override = ChannelOverride{UserAllow: userAllow, UserDeny: userDeny}
			s.Layers = []RoleGrant{
				{Perms: rolePerms, Allow: allow, Deny: deny},
				{Perms: role2Perms, Allow: allow2, Deny: deny2},
			}
			has = func(perm int64) bool {
				return rawHasTwoRoles(rolePerms, allow, deny, role2Perms, allow2, deny2, userAllow, userDeny, perm)
			}
		}
		isDM := chanType == "dm"

		// Subject.Has is the one bit predicate every rule is built on.
		for _, perm := range []int64{0, ReadMessages, SendMessages, ManageMessages, ConnectVoice, MuteMembers, ReadMessages | SendMessages, ReadMessages | MuteMembers} {
			if s.Has(perm) != has(perm) {
				t.Fatalf("Subject.Has(%#x) on %+v = %v, raw-bit computation says %v", perm, s, s.Has(perm), has(perm))
			}
		}

		// Visibility: permission before archive, so an unauthorized caller
		// learns nothing about the channel; a DM answers to membership alone.
		var wantView error
		switch {
		case isDM && !dmParticipant:
			wantView = ErrNotDMParticipant
		case isDM:
			wantView = nil
		case !has(ReadMessages):
			wantView = ErrPermissionDenied
		case archived:
			wantView = ErrArchived
		}
		wantErr(t, "CanViewChannel", s, CanViewChannel(s), wantView)

		// Posting: READ+SEND, MANAGE on top for an announcement, never into
		// an archive; a DM needs membership and no block.
		var wantSend error
		switch {
		case isDM && !dmParticipant:
			wantSend = ErrNotDMParticipant
		case isDM && dmBlocked:
			wantSend = ErrBlocked
		case isDM:
			wantSend = nil
		case !has(ReadMessages | SendMessages):
			wantSend = ErrPermissionDenied
		case chanType == "announcement" && !has(ManageMessages):
			wantSend = ErrPermissionDenied
		case archived:
			wantSend = ErrArchived
		}
		wantErr(t, "CanSendMessage", s, CanSendMessage(s), wantSend)

		// Voice: the CONNECT bit first, then READ outside a DM (so a channel
		// type is never disclosed to someone without either), then the room,
		// then the archive.
		var wantVoice error
		switch {
		case !has(ConnectVoice):
			wantVoice = ErrPermissionDenied
		case !isDM && !has(ReadMessages):
			wantVoice = ErrPermissionDenied
		case isDM && !dmParticipant:
			wantVoice = ErrNotDMParticipant
		case isDM && dmBlocked:
			wantVoice = ErrBlocked
		case !isDM && chanType != "voice":
			wantVoice = ErrNotVoiceChannel
		case archived:
			wantVoice = ErrArchived
		}
		wantErr(t, "CanJoinVoice", s, CanJoinVoice(s), wantVoice)

		// Moderation authority in the TARGET's channel: DM membership first,
		// then effective READ+MUTE there. Archive does not gate it.
		var wantMod error
		switch {
		case isDM && !dmParticipant:
			wantMod = ErrNotDMParticipant
		case !has(ReadMessages | MuteMembers):
			wantMod = ErrPermissionDenied
		}
		wantErr(t, "CanModerateVoice", s, CanModerateVoice(s), wantMod)

		// Pinning, against the raw rule SetMessagePinned used: a DM answers
		// to membership, then block, then timeout; any other channel needs
		// effective READ+MANAGE and never consults the timeout.
		for _, timedOut := range []bool{false, true} {
			sp := s
			sp.TimedOut = timedOut
			var wantPin error
			switch {
			case isDM && !dmParticipant:
				wantPin = ErrNotDMParticipant
			case isDM && dmBlocked:
				wantPin = ErrBlocked
			case isDM && timedOut:
				wantPin = ErrTimedOut
			case isDM:
				wantPin = nil
			case !has(ReadMessages | ManageMessages):
				wantPin = ErrPermissionDenied
			}
			wantErr(t, "CanPinMessage", sp, CanPinMessage(sp), wantPin)
		}

		// The two definitional identities. A future edit that gives session
		// admission its own rule, or lets someone announce a post they cannot
		// make, breaks here rather than silently.
		if !sameVerdict(CanAdmitSession(s), CanViewChannel(s)) {
			t.Fatalf("CanAdmitSession(%+v) = %v but CanViewChannel = %v — session admission is visibility by definition", s, CanAdmitSession(s), CanViewChannel(s))
		}
		if !sameVerdict(CanType(s), CanSendMessage(s)) {
			t.Fatalf("CanType(%+v) = %v but CanSendMessage = %v — a typing indicator announces a post (S-01)", s, CanType(s), CanSendMessage(s))
		}
	})
}
