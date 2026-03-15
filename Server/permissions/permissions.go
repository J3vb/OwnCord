// Package permissions provides the canonical permission bit constants and
// role ID constants for the OwnCord server. All other packages must import
// from here instead of defining their own local copies.
package permissions

// ─── Permission bit constants (from SCHEMA.md) ───────────────────────────────

const (
	SendMessages   = int64(0x0001)     // bit 0
	ReadMessages   = int64(0x0002)     // bit 1
	AttachFiles    = int64(0x0020)     // bit 5
	AddReactions   = int64(0x0040)     // bit 6
	UseSoundboard  = int64(0x0100)     // bit 8
	ConnectVoice   = int64(0x0200)     // bit 9
	SpeakVoice     = int64(0x0400)     // bit 10
	UseVideo       = int64(0x0800)     // bit 11
	ShareScreen    = int64(0x1000)     // bit 12
	ManageMessages = int64(0x10000)    // bit 16
	ManageChannels = int64(0x20000)    // bit 17
	KickMembers    = int64(0x40000)    // bit 18
	BanMembers     = int64(0x80000)    // bit 19
	MuteMembers    = int64(0x100000)   // bit 20
	ManageRoles    = int64(0x1000000)  // bit 24
	ManageServer   = int64(0x2000000)  // bit 25
	ManageInvites  = int64(0x4000000)  // bit 26
	ViewAuditLog   = int64(0x8000000)  // bit 27
	Administrator  = int64(0x40000000) // bit 30 — bypasses all permission checks
)

// ─── Role ID constants (default roles inserted on first run) ─────────────────

const (
	OwnerRoleID     = int64(1)
	AdminRoleID     = int64(2)
	ModeratorRoleID = int64(3)
	MemberRoleID    = int64(4)
)

// OwnerRolePosition is the hierarchy position of the owner role. Roles with a
// position below this value cannot modify the owner role or perform privileged
// operations reserved for the owner.
const OwnerRolePosition = 100

// ─── Permission helper functions ─────────────────────────────────────────────

// HasPerm reports whether rolePerms contains all bits in requiredPerm.
// Returns false when requiredPerm is zero because zero is not a valid bit.
func HasPerm(rolePerms, requiredPerm int64) bool {
	if requiredPerm == 0 {
		return false
	}
	return rolePerms&requiredPerm == requiredPerm
}

// HasAdmin reports whether rolePerms includes the Administrator bit, which
// grants unconditional access to all operations.
func HasAdmin(rolePerms int64) bool {
	return rolePerms&Administrator != 0
}

// EffectivePerms computes the resolved permission set for a channel override.
// The formula matches Discord's channel override semantics:
//
//	effective = (rolePerm & ^deny) | allow
//
// deny is applied first (strips bits), then allow is applied (adds bits),
// so allow takes precedence over deny when both target the same bit.
func EffectivePerms(rolePerm, allow, deny int64) int64 {
	return (rolePerm &^ deny) | allow
}
