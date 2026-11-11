// Package permissions holds the canonical permission bits and role IDs; other
// packages import them from here.
package permissions

const (
	SendMessages    = int64(0x0001)     // bit 0
	ReadMessages    = int64(0x0002)     // bit 1
	ManageConfig    = int64(0x0004)     // bit 2 — read and change the server's config overrides and restart it; owner tier
	ManageUpdates   = int64(0x0008)     // bit 3 — check for and apply server updates; owner tier
	ManageTokens    = int64(0x0010)     // bit 4 — mint, list and revoke the holder's own API tokens; owner tier
	AttachFiles     = int64(0x0020)     // bit 5
	AddReactions    = int64(0x0040)     // bit 6
	IssueRecovery   = int64(0x0080)     // bit 7 — issue a recovery credential to a member ranked below the holder; owner tier
	ViewDiagnostics = int64(0x0100)     // bit 8 — server logs, log level, support bundles and the attention panel; administrator tier
	ConnectVoice    = int64(0x0200)     // bit 9
	SpeakVoice      = int64(0x0400)     // bit 10
	UseVideo        = int64(0x0800)     // bit 11
	ShareScreen     = int64(0x1000)     // bit 12
	MoveMembers     = int64(0x2000)     // bit 13 — move any member between voice channels, whatever their rank; server-wide, outside AdminPerimeter
	ManageBackups   = int64(0x4000)     // bit 14 — create, list and download database backups; holds more than the perimeter read surface, so owner-grant-only
	RestoreBackups  = int64(0x8000)     // bit 15 — restore, delete and download backups and the full archive; owner tier
	ManageMessages  = int64(0x10000)    // bit 16
	ManageChannels  = int64(0x20000)    // bit 17
	KickMembers     = int64(0x40000)    // bit 18
	BanMembers      = int64(0x80000)    // bit 19
	MuteMembers     = int64(0x100000)   // bit 20
	MentionEveryone = int64(0x200000)   // bit 21
	ModerateMembers = int64(0x400000)   // bit 22 — warn and time out members, work the report queue
	ManageNicknames = int64(0x800000)   // bit 23 — set or clear another member's nickname; server-wide, outside AdminPerimeter
	ManageRoles     = int64(0x1000000)  // bit 24
	ManageServer    = int64(0x2000000)  // bit 25
	ManageInvites   = int64(0x4000000)  // bit 26
	ViewAuditLog    = int64(0x8000000)  // bit 27
	EraseAccounts   = int64(0x10000000) // bit 28 — erase a member's account, whatever the Administrator bit says; administrator tier
	Administrator   = int64(0x40000000) // bit 30 — bypasses all permission checks
)

// AllPerms is the union of every defined permission bit; mask external values with it.
const AllPerms = SendMessages | ReadMessages | ManageConfig | ManageUpdates | ManageTokens |
	AttachFiles | AddReactions | IssueRecovery | ViewDiagnostics |
	ConnectVoice | SpeakVoice | UseVideo | ShareScreen | MoveMembers | ManageBackups | RestoreBackups |
	ManageMessages | ManageChannels | KickMembers | BanMembers | MuteMembers |
	MentionEveryone | ModerateMembers | ManageNicknames | ManageRoles | ManageServer | ManageInvites | ViewAuditLog |
	EraseAccounts | Administrator

// AdminPerimeter is the set of bits that admits a principal to /admin/api;
// holding any one passes, and each route group re-checks its own bit.
// ModerateMembers is excluded so a warning-only moderator does not inherit the
// perimeter's read surface (/stats, /users, /me), which re-checks nothing.
// ManageBackups and the owner-type bits are inside it so holders can reach
// their routes.
const AdminPerimeter = Administrator | ManageChannels | ManageRoles |
	ManageServer | ViewAuditLog | KickMembers | BanMembers | MuteMembers | ManageBackups |
	OwnerTierBits | AdministratorTierBits

// OwnerTierBits are the owner-type bits. The gate is the owner or the bit held
// explicitly; Administrator does NOT bypass it, or every seeded Admin would gain owner powers.
const OwnerTierBits = RestoreBackups | ManageConfig | ManageUpdates | ManageTokens | IssueRecovery

// AdministratorTierBits are the owner-type bits whose actions an Administrator
// already had; Administrator keeps passing them.
const AdministratorTierBits = ViewDiagnostics | EraseAccounts

// OwnerGrantOnly is the mask of bits only the owner or an Administrator may
// grant via a role; ManageRoles is not enough.
const OwnerGrantOnly = MoveMembers | ManageBackups | OwnerTierBits | AdministratorTierBits

// OwnerOnlyGrant is the subset of OwnerGrantOnly only the owner may grant; an
// Administrator could otherwise give themself an owner-tier bit.
const OwnerOnlyGrant = OwnerTierBits

// bitNames maps each single permission bit to its schema name.
var bitNames = map[int64]string{
	SendMessages:    "SEND_MESSAGES",
	ReadMessages:    "READ_MESSAGES",
	ManageConfig:    "MANAGE_CONFIG",
	ManageUpdates:   "MANAGE_UPDATES",
	ManageTokens:    "MANAGE_TOKENS",
	AttachFiles:     "ATTACH_FILES",
	AddReactions:    "ADD_REACTIONS",
	IssueRecovery:   "ISSUE_RECOVERY",
	ViewDiagnostics: "VIEW_DIAGNOSTICS",
	ConnectVoice:    "CONNECT_VOICE",
	SpeakVoice:      "SPEAK_VOICE",
	UseVideo:        "USE_VIDEO",
	ShareScreen:     "SHARE_SCREEN",
	MoveMembers:     "MOVE_MEMBERS",
	ManageBackups:   "MANAGE_BACKUPS",
	RestoreBackups:  "RESTORE_BACKUPS",
	ManageMessages:  "MANAGE_MESSAGES",
	ManageChannels:  "MANAGE_CHANNELS",
	KickMembers:     "KICK_MEMBERS",
	BanMembers:      "BAN_MEMBERS",
	MuteMembers:     "MUTE_MEMBERS",
	MentionEveryone: "MENTION_EVERYONE",
	ModerateMembers: "MODERATE_MEMBERS",
	ManageNicknames: "MANAGE_NICKNAMES",
	ManageRoles:     "MANAGE_ROLES",
	ManageServer:    "MANAGE_SERVER",
	ManageInvites:   "MANAGE_INVITES",
	ViewAuditLog:    "VIEW_AUDIT_LOG",
	EraseAccounts:   "ERASE_ACCOUNTS",
	Administrator:   "ADMINISTRATOR",
}

// Name returns the schema name of a single permission bit, or "UNKNOWN".
func Name(bit int64) string {
	if name, ok := bitNames[bit]; ok {
		return name
	}
	return "UNKNOWN"
}

const (
	OwnerRoleID     = int64(1)
	AdminRoleID     = int64(2)
	ModeratorRoleID = int64(3)
	MemberRoleID    = int64(4)
)

// OwnerRolePosition is the hierarchy position of the owner role.
const OwnerRolePosition = 100

// IsOwner reports whether the role is the owner role. The seeded OwnerRoleID is
// accepted besides position so hand-edited positions still find the owner;
// call sites must use this, not compare ID or Position.
func IsOwner(roleID int64, position int) bool {
	return roleID == OwnerRoleID || position >= OwnerRolePosition
}

// HasPerm reports whether rolePerms contains all bits in requiredPerm; a zero requiredPerm is false.
func HasPerm(rolePerms, requiredPerm int64) bool {
	if requiredPerm == 0 {
		return false
	}
	return rolePerms&requiredPerm == requiredPerm
}

// HasAnyPerm reports whether rolePerms holds any bit of mask; zero is never satisfied.
func HasAnyPerm(rolePerms, mask int64) bool {
	if mask == 0 {
		return false
	}
	return rolePerms&mask != 0
}

// HasAdmin reports whether rolePerms includes the Administrator bit.
func HasAdmin(rolePerms int64) bool {
	return rolePerms&Administrator != 0
}

// HasServerPerm reports whether a role holds a server-wide permission (all-of
// for multi-bit masks). Administrator bypasses; channel overrides are NOT
// consulted, so use Checker.HasChannelPerm when a channel id exists.
func HasServerPerm(rolePerms, perm int64) bool {
	return HasAdmin(rolePerms) || HasPerm(rolePerms, perm)
}

// EffectivePerms resolves ONE layer as (rolePerm & ^deny) | allow; allow wins.
func EffectivePerms(rolePerm, allow, deny int64) int64 {
	return (rolePerm &^ deny) | allow
}

// EffectiveChannelPerms resolves a member's permissions in ONE channel: base
// role perms, then role override, then user override, each via EffectivePerms,
// so the narrower layer wins (a user deny beats a role allow).
//
// ADMINISTRATOR is NOT handled here: callers short-circuit on HasAdmin first,
// so an override never re-grants it. This is the single resolution formula all
// checkers and service.PermissionService route through.
func EffectiveChannelPerms(basePerms int64, o ChannelOverride) int64 {
	roleLayer := EffectivePerms(basePerms, o.Allow, o.Deny)
	return EffectivePerms(roleLayer, o.UserAllow, o.UserDeny)
}

// RoleGrant is one held role's base mask and its own channel override (zero when none).
type RoleGrant struct {
	Perms int64
	Allow int64
	Deny  int64
	// RoleID names the role for traces (Explain); the formula ignores it.
	RoleID int64
}

// MemberChannelPerms is EffectiveChannelPerms for a multi-role member: each
// role resolves with its own override, the results are OR'd, then the member's
// override applies, so a role only ever adds permissions.
func MemberChannelPerms(layers []RoleGrant, userAllow, userDeny int64) int64 {
	var roleLayer int64
	for _, g := range layers {
		roleLayer |= EffectivePerms(g.Perms, g.Allow, g.Deny)
	}
	return EffectivePerms(roleLayer, userAllow, userDeny)
}
