// Package permissions provides the canonical permission bit constants and
// role ID constants for the OwnCord server. All other packages must import
// from here instead of defining their own local copies.
package permissions

// ─── Permission bit constants (from SCHEMA.md) ───────────────────────────────

const (
	SendMessages    = int64(0x0001)     // bit 0
	ReadMessages    = int64(0x0002)     // bit 1
	AttachFiles     = int64(0x0020)     // bit 5
	AddReactions    = int64(0x0040)     // bit 6
	ConnectVoice    = int64(0x0200)     // bit 9
	SpeakVoice      = int64(0x0400)     // bit 10
	UseVideo        = int64(0x0800)     // bit 11
	ShareScreen     = int64(0x1000)     // bit 12
	ManageMessages  = int64(0x10000)    // bit 16
	ManageChannels  = int64(0x20000)    // bit 17
	KickMembers     = int64(0x40000)    // bit 18
	BanMembers      = int64(0x80000)    // bit 19
	MuteMembers     = int64(0x100000)   // bit 20
	MentionEveryone = int64(0x200000)   // bit 21
	ManageRoles     = int64(0x1000000)  // bit 24
	ManageServer    = int64(0x2000000)  // bit 25
	ManageInvites   = int64(0x4000000)  // bit 26
	ViewAuditLog    = int64(0x8000000)  // bit 27
	Administrator   = int64(0x40000000) // bit 30 — bypasses all permission checks
)

// AllPerms is the union of every defined permission bit. Use it to mask
// externally supplied permission values so unknown bits are dropped.
const AllPerms = SendMessages | ReadMessages | AttachFiles | AddReactions |
	ConnectVoice | SpeakVoice | UseVideo | ShareScreen |
	ManageMessages | ManageChannels | KickMembers | BanMembers | MuteMembers |
	MentionEveryone | ManageRoles | ManageServer | ManageInvites | ViewAuditLog |
	Administrator

// AdminPerimeter is the set of bits that admits a principal to the /admin/api
// surface. Holding ANY one of them is enough to pass the perimeter; each route
// group then re-checks the specific bit it needs. ManageMessages and
// ManageInvites are excluded: neither has an admin-panel route.
const AdminPerimeter = Administrator | ManageChannels | ManageRoles |
	ManageServer | ViewAuditLog | KickMembers | BanMembers | MuteMembers

// bitNames maps each single permission bit to its SCHEMA.md name. Used for
// authorization error messages so the wording lives in one place.
var bitNames = map[int64]string{
	SendMessages:    "SEND_MESSAGES",
	ReadMessages:    "READ_MESSAGES",
	AttachFiles:     "ATTACH_FILES",
	AddReactions:    "ADD_REACTIONS",
	ConnectVoice:    "CONNECT_VOICE",
	SpeakVoice:      "SPEAK_VOICE",
	UseVideo:        "USE_VIDEO",
	ShareScreen:     "SHARE_SCREEN",
	ManageMessages:  "MANAGE_MESSAGES",
	ManageChannels:  "MANAGE_CHANNELS",
	KickMembers:     "KICK_MEMBERS",
	BanMembers:      "BAN_MEMBERS",
	MuteMembers:     "MUTE_MEMBERS",
	MentionEveryone: "MENTION_EVERYONE",
	ManageRoles:     "MANAGE_ROLES",
	ManageServer:    "MANAGE_SERVER",
	ManageInvites:   "MANAGE_INVITES",
	ViewAuditLog:    "VIEW_AUDIT_LOG",
	Administrator:   "ADMINISTRATOR",
}

// Name returns the SCHEMA.md name of a single permission bit, or "UNKNOWN" for
// a zero, multi-bit, or undefined value.
func Name(bit int64) string {
	if name, ok := bitNames[bit]; ok {
		return name
	}
	return "UNKNOWN"
}

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

// HasAnyPerm reports whether rolePerms contains at least one bit of mask.
// Unlike HasPerm (ALL-of) this is ANY-of; a zero mask is never satisfied.
// Administrator is NOT implied — callers that want the bypass pass a mask
// that already includes it (e.g. AdminPerimeter).
func HasAnyPerm(rolePerms, mask int64) bool {
	if mask == 0 {
		return false
	}
	return rolePerms&mask != 0
}

// HasAdmin reports whether rolePerms includes the Administrator bit, which
// grants unconditional access to all operations.
func HasAdmin(rolePerms int64) bool {
	return rolePerms&Administrator != 0
}

// HasServerPerm reports whether a role holds a SERVER-WIDE permission.
// Administrator bypasses. Channel overrides are deliberately NOT consulted —
// use Checker.HasChannelPerm/HasChannelPermBatch whenever a channel id exists.
// Multi-bit masks are ALL-of (every bit must be present), matching HasPerm.
func HasServerPerm(rolePerms, perm int64) bool {
	return HasAdmin(rolePerms) || HasPerm(rolePerms, perm)
}

// EffectivePerms computes the resolved permission set for ONE override layer.
// The formula matches Discord's channel override semantics:
//
//	effective = (rolePerm & ^deny) | allow
//
// deny is applied first (strips bits), then allow is applied (adds bits),
// so allow takes precedence over deny when both target the same bit.
//
// Prefer EffectiveChannelPerms, which applies both layers in order; this is the
// primitive it is built from.
func EffectivePerms(rolePerm, allow, deny int64) int64 {
	return (rolePerm &^ deny) | allow
}

// EffectiveChannelPerms resolves a member's permissions in ONE channel, in
// Discord's order:
//
//	base role permissions -> role override -> user override
//
// Each layer is EffectivePerms, so within a layer allow beats deny, and across
// layers the later (narrower) layer wins: a per-user deny beats a per-role
// allow, and a per-user allow beats a per-user deny.
//
// ADMINISTRATOR is deliberately NOT handled here — it is a bypass, not a bit
// that survives an override, and every caller short-circuits on HasAdmin before
// reaching this. Keeping the bypass at the call site means a channel override
// can still strip ADMINISTRATOR from a non-admin's computed mask (it never
// grants it) without this function quietly re-granting it.
//
// This is the single resolution formula: Checker.HasChannelPerm,
// Checker.HasChannelPermBatch (and through it VisibleChannelIDs) and
// service.PermissionService all route through it, so no call site can be left
// resolving only the role layer.
func EffectiveChannelPerms(basePerms int64, o ChannelOverride) int64 {
	roleLayer := EffectivePerms(basePerms, o.Allow, o.Deny)
	return EffectivePerms(roleLayer, o.UserAllow, o.UserDeny)
}
