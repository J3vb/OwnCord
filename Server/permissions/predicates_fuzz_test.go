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
// Admin 1073741823, Moderator 3145727, Member 7779) against the channel
// types those journeys use.

// rawEffective is EffectivePerms/EffectiveChannelPerms written out as the
// formula their doc comments state, so the parity check does not lean on the
// helper it is meant to be independent of.
func rawEffective(rolePerms int64, o ChannelOverride) int64 {
	roleLayer := (rolePerms &^ o.Deny) | o.Allow
	return (roleLayer &^ o.UserDeny) | o.UserAllow
}

// rawHas is Subject.Has written out IN PRODUCTION'S ORDER, which is not the
// tidy one: the Administrator bypass is applied first and returns true
// unconditionally, so an administrator "holds" a zero permission even though
// HasPerm's own all-of rule says an empty mask is never held
// (HasPerm(Administrator, 0) == false). Only a non-administrator reaches the
// zero-perm refusal, and only then does the two-layer mask get consulted.
//
// Parity is this target's whole purpose, so the oracle keeps that ordering
// rather than the contract the doc comments imply.
// TestSubjectHasZeroPermIsAdminBypassed records the divergence as observed
// behaviour, and the item's evidence block carries the call-site survey
// showing no production caller passes 0 today.
func rawHas(rolePerms int64, o ChannelOverride, perm int64) bool {
	if rolePerms&Administrator != 0 {
		return true
	}
	if perm == 0 {
		return false
	}
	return rawEffective(rolePerms, o)&perm == perm
}

// TestSubjectHasZeroPermIsAdminBypassed records, as OBSERVED behaviour and not
// as a property anything should rely on, the one place Subject.Has and HasPerm
// disagree: Subject.Has applies the Administrator bypass before the zero-perm
// refusal, so an administrator holds the empty mask while HasPerm never does.
// No production call site passes 0 (every one names a permissions.* constant),
// so nothing turns on it today — but rawHas mirrors the ordering and this test
// is what says so out loud. If the ordering is ever deliberately changed,
// rawHas and this test move together.
func TestSubjectHasZeroPermIsAdminBypassed(t *testing.T) {
	if HasPerm(Administrator, 0) {
		t.Fatal("HasPerm(_, 0) = true; the all-of rule on an empty mask must stay false")
	}
	if !(Subject{RolePerms: Administrator}).Has(0) {
		t.Fatal("observed behaviour changed: Subject.Has(0) no longer returns true for an administrator — update rawHas and this test together")
	}
	if (Subject{RolePerms: ReadMessages}).Has(0) {
		t.Fatal("Subject.Has(0) = true for a non-administrator; only the Administrator bypass may reach that")
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
		mod    = int64(3145727)
		member = int64(7779)
	)
	types := []string{"text", "voice", "dm", "announcement", "", "TEXT"}
	roles := []int64{0, member, mod, admin, owner, -1, Administrator}
	for _, role := range roles {
		for _, typ := range types {
			f.Add(role, int64(0), int64(0), int64(0), int64(0), typ, false, false, false)
			f.Add(role, int64(0), ReadMessages, int64(0), int64(0), typ, false, true, false)
			f.Add(role, int64(0), int64(0), ManageMessages, SendMessages, typ, true, true, true)
			f.Add(role, ConnectVoice, MuteMembers, int64(0), ReadMessages, typ, true, false, true)
		}
	}

	f.Fuzz(func(t *testing.T,
		rolePerms, allow, deny, userAllow, userDeny int64,
		chanType string,
		archived, dmParticipant, dmBlocked bool,
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

		// Voice: the CONNECT bit first (so a channel type is never disclosed
		// to someone without it), then the room, then the archive.
		var wantVoice error
		switch {
		case !has(ConnectVoice):
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
