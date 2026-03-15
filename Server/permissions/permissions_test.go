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
