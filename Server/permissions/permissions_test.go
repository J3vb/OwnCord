package permissions_test

import (
	"testing"

	"github.com/owncord/server/permissions"
)

// ─── Constant value tests ─────────────────────────────────────────────────────

// TestPermissionBitValues verifies every constant matches the SCHEMA.md bitfield.
func TestPermissionBitValues(t *testing.T) {
	cases := []struct {
		name     string
		got      int64
		expected int64
	}{
		{"SendMessages", permissions.SendMessages, 0x0001},
		{"ReadMessages", permissions.ReadMessages, 0x0002},
		{"AttachFiles", permissions.AttachFiles, 0x0020},
		{"AddReactions", permissions.AddReactions, 0x0040},
		{"UseSoundboard", permissions.UseSoundboard, 0x0100},
		{"ConnectVoice", permissions.ConnectVoice, 0x0200},
		{"SpeakVoice", permissions.SpeakVoice, 0x0400},
		{"UseVideo", permissions.UseVideo, 0x0800},
		{"ShareScreen", permissions.ShareScreen, 0x1000},
		{"ManageMessages", permissions.ManageMessages, 0x10000},
		{"ManageChannels", permissions.ManageChannels, 0x20000},
		{"KickMembers", permissions.KickMembers, 0x40000},
		{"BanMembers", permissions.BanMembers, 0x80000},
		{"MuteMembers", permissions.MuteMembers, 0x100000},
		{"ManageRoles", permissions.ManageRoles, 0x1000000},
		{"ManageServer", permissions.ManageServer, 0x2000000},
		{"ManageInvites", permissions.ManageInvites, 0x4000000},
		{"ViewAuditLog", permissions.ViewAuditLog, 0x8000000},
		{"Administrator", permissions.Administrator, 0x40000000},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.expected {
				t.Errorf("%s: got 0x%X, want 0x%X", tc.name, tc.got, tc.expected)
			}
		})
	}
}

// TestRoleIDConstants verifies the predefined role IDs match SCHEMA.md defaults.
func TestRoleIDConstants(t *testing.T) {
	cases := []struct {
		name     string
		got      int64
		expected int64
	}{
		{"OwnerRoleID", permissions.OwnerRoleID, 1},
		{"AdminRoleID", permissions.AdminRoleID, 2},
		{"ModeratorRoleID", permissions.ModeratorRoleID, 3},
		{"MemberRoleID", permissions.MemberRoleID, 4},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.expected {
				t.Errorf("%s: got %d, want %d", tc.name, tc.got, tc.expected)
			}
		})
	}
}

// TestOwnerRolePosition verifies the owner position sentinel value.
func TestOwnerRolePosition(t *testing.T) {
	if permissions.OwnerRolePosition != 100 {
		t.Errorf("OwnerRolePosition: got %d, want 100", permissions.OwnerRolePosition)
	}
}

// ─── HasPerm tests ────────────────────────────────────────────────────────────

func TestHasPerm_MatchingBitReturnsTrue(t *testing.T) {
	rolePerms := permissions.SendMessages | permissions.ReadMessages | permissions.ConnectVoice
	if !permissions.HasPerm(rolePerms, permissions.SendMessages) {
		t.Error("expected HasPerm to return true when bit is set")
	}
}

func TestHasPerm_MissingBitReturnsFalse(t *testing.T) {
	rolePerms := permissions.ReadMessages | permissions.ConnectVoice
	if permissions.HasPerm(rolePerms, permissions.SendMessages) {
		t.Error("expected HasPerm to return false when bit is not set")
	}
}

func TestHasPerm_ZeroPermsReturnsFalse(t *testing.T) {
	if permissions.HasPerm(0, permissions.SendMessages) {
		t.Error("expected HasPerm(0, ...) to return false")
	}
}

func TestHasPerm_ZeroRequiredReturnsFalse(t *testing.T) {
	// Requiring perm 0 should never match — 0 is not a valid permission bit.
	if permissions.HasPerm(permissions.Administrator, 0) {
		t.Error("expected HasPerm(..., 0) to return false for zero required perm")
	}
}

func TestHasPerm_MultipleBitsSetOnlyChecksRequired(t *testing.T) {
	// rolePerms has many bits; we ask about one that is present.
	rolePerms := permissions.SendMessages | permissions.ManageMessages | permissions.BanMembers
	if !permissions.HasPerm(rolePerms, permissions.ManageMessages) {
		t.Error("expected HasPerm to find ManageMessages in combined bitfield")
	}
}

func TestHasPerm_AllBitsSet(t *testing.T) {
	// 0x7FFFFFFF (Owner default) must satisfy every individual permission.
	allPerms := int64(0x7FFFFFFF)
	perms := []int64{
		permissions.SendMessages, permissions.ReadMessages, permissions.AttachFiles,
		permissions.AddReactions, permissions.UseSoundboard, permissions.ConnectVoice,
		permissions.SpeakVoice, permissions.UseVideo, permissions.ShareScreen,
		permissions.ManageMessages, permissions.ManageChannels, permissions.KickMembers,
		permissions.BanMembers, permissions.MuteMembers, permissions.ManageRoles,
		permissions.ManageServer, permissions.ManageInvites, permissions.ViewAuditLog,
		permissions.Administrator,
	}
	for _, p := range perms {
		if !permissions.HasPerm(allPerms, p) {
			t.Errorf("expected all-bits owner to have perm 0x%X", p)
		}
	}
}

// ─── HasAdmin tests ───────────────────────────────────────────────────────────

func TestHasAdmin_AdministratorBitSet(t *testing.T) {
	if !permissions.HasAdmin(permissions.Administrator) {
		t.Error("expected HasAdmin to return true when Administrator bit is set")
	}
}

func TestHasAdmin_AdministratorBitWithOthers(t *testing.T) {
	combined := permissions.SendMessages | permissions.Administrator | permissions.BanMembers
	if !permissions.HasAdmin(combined) {
		t.Error("expected HasAdmin to return true with Administrator bit among others")
	}
}

func TestHasAdmin_NoAdministratorBit(t *testing.T) {
	if permissions.HasAdmin(permissions.SendMessages | permissions.BanMembers) {
		t.Error("expected HasAdmin to return false without Administrator bit")
	}
}

func TestHasAdmin_ZeroPerms(t *testing.T) {
	if permissions.HasAdmin(0) {
		t.Error("expected HasAdmin(0) to return false")
	}
}

func TestHasAdmin_AdminRolePermsMissingBit(t *testing.T) {
	// Admin role default is 0x3FFFFFFF — bit 30 (Administrator) is NOT set.
	adminDefault := int64(0x3FFFFFFF)
	if permissions.HasAdmin(adminDefault) {
		t.Error("expected HasAdmin to return false for Admin role (0x3FFFFFFF lacks bit 30)")
	}
}

func TestHasAdmin_OwnerRolePermsHasBit(t *testing.T) {
	// Owner role default is 0x7FFFFFFF — bit 30 IS set.
	ownerDefault := int64(0x7FFFFFFF)
	if !permissions.HasAdmin(ownerDefault) {
		t.Error("expected HasAdmin to return true for Owner role (0x7FFFFFFF has bit 30)")
	}
}

// ─── EffectivePerms tests ─────────────────────────────────────────────────────

// EffectivePerms(rolePerm, allow, deny) = (rolePerm & ^deny) | allow

func TestEffectivePerms_NoOverrides(t *testing.T) {
	base := permissions.SendMessages | permissions.ReadMessages
	got := permissions.EffectivePerms(base, 0, 0)
	if got != base {
		t.Errorf("EffectivePerms with no overrides: got 0x%X, want 0x%X", got, base)
	}
}

func TestEffectivePerms_AllowAddsPermission(t *testing.T) {
	base := permissions.ReadMessages
	allow := permissions.SendMessages
	got := permissions.EffectivePerms(base, allow, 0)
	want := permissions.ReadMessages | permissions.SendMessages
	if got != want {
		t.Errorf("EffectivePerms allow: got 0x%X, want 0x%X", got, want)
	}
}

func TestEffectivePerms_DenyRemovesPermission(t *testing.T) {
	base := permissions.SendMessages | permissions.ReadMessages | permissions.ConnectVoice
	deny := permissions.ConnectVoice
	got := permissions.EffectivePerms(base, 0, deny)
	want := permissions.SendMessages | permissions.ReadMessages
	if got != want {
		t.Errorf("EffectivePerms deny: got 0x%X, want 0x%X", got, want)
	}
}

func TestEffectivePerms_AllowAndDenyTogether(t *testing.T) {
	// deny removes ConnectVoice; allow grants ManageMessages.
	base := permissions.SendMessages | permissions.ReadMessages | permissions.ConnectVoice
	allow := permissions.ManageMessages
	deny := permissions.ConnectVoice
	got := permissions.EffectivePerms(base, allow, deny)
	want := permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages
	if got != want {
		t.Errorf("EffectivePerms allow+deny: got 0x%X, want 0x%X", got, want)
	}
}

func TestEffectivePerms_AllowOverridesDeny(t *testing.T) {
	// When both allow and deny target the same bit, allow wins
	// because the formula applies deny first, then allow.
	base := permissions.SendMessages
	allow := permissions.ConnectVoice
	deny := permissions.ConnectVoice
	got := permissions.EffectivePerms(base, allow, deny)
	// deny strips ConnectVoice, then allow adds it back.
	want := permissions.SendMessages | permissions.ConnectVoice
	if got != want {
		t.Errorf("EffectivePerms allow overrides deny: got 0x%X, want 0x%X", got, want)
	}
}

func TestEffectivePerms_ZeroBase(t *testing.T) {
	allow := permissions.SendMessages | permissions.ReadMessages
	got := permissions.EffectivePerms(0, allow, 0)
	if got != allow {
		t.Errorf("EffectivePerms zero base: got 0x%X, want 0x%X", got, allow)
	}
}

func TestEffectivePerms_ZeroAll(t *testing.T) {
	got := permissions.EffectivePerms(0, 0, 0)
	if got != 0 {
		t.Errorf("EffectivePerms all zero: got 0x%X, want 0", got)
	}
}

func TestEffectivePerms_DenyAllGrantNone(t *testing.T) {
	base := int64(0x7FFFFFFF)
	deny := int64(0x7FFFFFFF)
	got := permissions.EffectivePerms(base, 0, deny)
	if got != 0 {
		t.Errorf("EffectivePerms deny all: got 0x%X, want 0", got)
	}
}

// ─── HasPerm — combined multi-bit checks ────────────────────────────────────

func TestHasPerm_RequiresAllBitsPresent(t *testing.T) {
	// Require both SendMessages AND ManageMessages; user only has SendMessages.
	rolePerms := permissions.SendMessages | permissions.ReadMessages
	combined := permissions.SendMessages | permissions.ManageMessages

	if permissions.HasPerm(rolePerms, combined) {
		t.Error("should fail when only some of the required bits are present")
	}
}

func TestHasPerm_CombinedBitsAllPresent(t *testing.T) {
	rolePerms := permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages
	combined := permissions.SendMessages | permissions.ManageMessages

	if !permissions.HasPerm(rolePerms, combined) {
		t.Error("should succeed when all required combined bits are present")
	}
}

// ─── EffectivePerms — channel override edge cases ───────────────────────────

func TestEffectivePerms_DenyAllThenAllowOne(t *testing.T) {
	base := permissions.SendMessages | permissions.ReadMessages | permissions.ConnectVoice
	deny := int64(0x7FFFFFFF)         // deny everything
	allow := permissions.ReadMessages // re-allow just ReadMessages

	eff := permissions.EffectivePerms(base, allow, deny)
	if eff != permissions.ReadMessages {
		t.Errorf("deny-all + allow-one: got 0x%X, want 0x%X", eff, permissions.ReadMessages)
	}
}

func TestEffectivePerms_MultipleDenyMultipleAllow(t *testing.T) {
	base := permissions.SendMessages | permissions.ReadMessages | permissions.AttachFiles | permissions.ConnectVoice
	deny := permissions.SendMessages | permissions.ConnectVoice
	allow := permissions.ManageChannels | permissions.ManageMessages

	eff := permissions.EffectivePerms(base, allow, deny)

	// Should keep: ReadMessages, AttachFiles (not denied)
	// Should lose: SendMessages, ConnectVoice (denied)
	// Should gain: ManageChannels, ManageMessages (allowed)
	want := permissions.ReadMessages | permissions.AttachFiles | permissions.ManageChannels | permissions.ManageMessages
	if eff != want {
		t.Errorf("multi deny+allow: got 0x%X, want 0x%X", eff, want)
	}
}

// ─── Role hierarchy simulation ──────────────────────────────────────────────

func TestRoleHierarchy_OwnerHasMorePermsThanAdmin(t *testing.T) {
	ownerPerms := int64(0x7FFFFFFF) // Owner default
	adminPerms := int64(0x3FFFFFFF) // Admin default (no Administrator bit)

	if !permissions.HasAdmin(ownerPerms) {
		t.Error("owner should be admin")
	}
	if permissions.HasAdmin(adminPerms) {
		t.Error("admin role should NOT have Administrator bit")
	}

	// Owner can ManageServer via admin bypass.
	// Admin can ManageServer via direct bit.
	if !permissions.HasPerm(adminPerms, permissions.ManageServer) {
		t.Error("admin should have ManageServer bit directly")
	}
}

func TestRoleHierarchy_MemberLacksModPerms(t *testing.T) {
	memberPerms := int64(1635) // Default member permissions from schema

	modPerms := []int64{
		permissions.ManageMessages,
		permissions.ManageChannels,
		permissions.KickMembers,
		permissions.BanMembers,
		permissions.ManageRoles,
		permissions.ManageServer,
		permissions.Administrator,
	}

	for _, p := range modPerms {
		if permissions.HasPerm(memberPerms, p) {
			t.Errorf("member (0x%X) should not have permission 0x%X", memberPerms, p)
		}
	}
}

func TestRoleHierarchy_MemberHasBasicPerms(t *testing.T) {
	memberPerms := int64(1635) //nolint:gocritic // documenting the bitmask composition, not commented-out code

	basicPerms := []struct {
		name string
		perm int64
	}{
		{"SendMessages", permissions.SendMessages},
		{"ReadMessages", permissions.ReadMessages},
	}

	for _, tc := range basicPerms {
		t.Run(tc.name, func(t *testing.T) {
			if !permissions.HasPerm(memberPerms, tc.perm) {
				t.Errorf("member should have %s", tc.name)
			}
		})
	}
}

// ─── Permission bits are unique powers of 2 ─────────────────────────────────

func TestPermissionBits_AreDistinctPowersOfTwo(t *testing.T) {
	bits := []int64{
		permissions.SendMessages, permissions.ReadMessages, permissions.AttachFiles,
		permissions.AddReactions, permissions.UseSoundboard, permissions.ConnectVoice,
		permissions.SpeakVoice, permissions.UseVideo, permissions.ShareScreen,
		permissions.ManageMessages, permissions.ManageChannels, permissions.KickMembers,
		permissions.BanMembers, permissions.MuteMembers, permissions.ManageRoles,
		permissions.ManageServer, permissions.ManageInvites, permissions.ViewAuditLog,
		permissions.Administrator,
	}

	seen := make(map[int64]bool)
	for _, b := range bits {
		if b&(b-1) != 0 {
			t.Errorf("permission 0x%X is not a power of 2", b)
		}
		if seen[b] {
			t.Errorf("duplicate permission bit: 0x%X", b)
		}
		seen[b] = true
	}
}
