// Package permissions provides the canonical permission bit constants and
// role ID constants for the OwnCord server. All other packages must import
// from here instead of defining their own local copies.
package permissions

// ─── Permission bit constants (from SCHEMA.md) ───────────────────────────────

const (
	SendMessages    = int64(0x0001)     // bit 0
	ReadMessages    = int64(0x0002)     // bit 1
	ManageConfig    = int64(0x0004)     // bit 2 — read and change the server's config overrides and restart it (WP 8.4d); owner tier
	ManageUpdates   = int64(0x0008)     // bit 3 — check for and apply server updates (WP 8.4d); owner tier
	ManageTokens    = int64(0x0010)     // bit 4 — mint, list and revoke the holder's own API tokens (WP 8.4d); owner tier
	AttachFiles     = int64(0x0020)     // bit 5
	AddReactions    = int64(0x0040)     // bit 6
	IssueRecovery   = int64(0x0080)     // bit 7 — issue a recovery credential to a member ranked below the holder (WP 8.4d); owner tier
	ViewDiagnostics = int64(0x0100)     // bit 8 — server logs, log level, support bundles and the attention panel (WP 8.4d); administrator tier
	ConnectVoice    = int64(0x0200)     // bit 9
	SpeakVoice      = int64(0x0400)     // bit 10
	UseVideo        = int64(0x0800)     // bit 11
	ShareScreen     = int64(0x1000)     // bit 12
	MoveMembers     = int64(0x2000)     // bit 13 — move any member between voice channels, whatever their rank (WP 8.4a); server-wide, outside AdminPerimeter
	ManageBackups   = int64(0x4000)     // bit 14 — create, list and download database backups (WP 8.4c); holds more than the perimeter read surface, so owner-grant-only
	RestoreBackups  = int64(0x8000)     // bit 15 — restore, delete and download backups and the full archive (WP 8.4d); owner tier
	ManageMessages  = int64(0x10000)    // bit 16
	ManageChannels  = int64(0x20000)    // bit 17
	KickMembers     = int64(0x40000)    // bit 18
	BanMembers      = int64(0x80000)    // bit 19
	MuteMembers     = int64(0x100000)   // bit 20
	MentionEveryone = int64(0x200000)   // bit 21
	ModerateMembers = int64(0x400000)   // bit 22 — warn and time out members, work the report queue (B5-8/B5-9)
	ManageNicknames = int64(0x800000)   // bit 23 — set or clear another member's nickname (WP 6.4); server-wide, outside AdminPerimeter
	ManageRoles     = int64(0x1000000)  // bit 24
	ManageServer    = int64(0x2000000)  // bit 25
	ManageInvites   = int64(0x4000000)  // bit 26
	ViewAuditLog    = int64(0x8000000)  // bit 27
	EraseAccounts   = int64(0x10000000) // bit 28 — erase a member's account, whatever the Administrator bit says (WP 8.4d); administrator tier
	Administrator   = int64(0x40000000) // bit 30 — bypasses all permission checks
)

// AllPerms is the union of every defined permission bit. Use it to mask
// externally supplied permission values so unknown bits are dropped.
const AllPerms = SendMessages | ReadMessages | ManageConfig | ManageUpdates | ManageTokens |
	AttachFiles | AddReactions | IssueRecovery | ViewDiagnostics |
	ConnectVoice | SpeakVoice | UseVideo | ShareScreen | MoveMembers | ManageBackups | RestoreBackups |
	ManageMessages | ManageChannels | KickMembers | BanMembers | MuteMembers |
	MentionEveryone | ModerateMembers | ManageNicknames | ManageRoles | ManageServer | ManageInvites | ViewAuditLog |
	EraseAccounts | Administrator

// AdminPerimeter is the set of bits that admits a principal to the /admin/api
// surface. Holding ANY one of them is enough to pass the perimeter; each route
// group then re-checks the specific bit it needs. ManageMessages and
// ManageInvites are excluded: neither has an /admin/api route. ManageInvites
// does have an admin-panel page (the Invites section), but that page reaches
// the invites through the member API (/api/v1/invites, gated on the same bit),
// so holding ManageInvites alone must not open the /admin/api perimeter.
// ModerateMembers is deliberately excluded too (B5-8 plan, decision 6/Question
// 5): a warning-only moderator must not inherit the perimeter's read surface
// (/stats, the /users list, /me), which re-checks nothing by design — the
// report queue lives under /api/v1, not /admin/api.
//
// ManageBackups is inside it (WP 8.4c) because a holder has to reach /admin/api
// at all to use the backup routes. The backup itself holds far more than the
// perimeter's read surface (every message and every password hash), which is
// why the bit is owner-grant-only.
//
// The seven owner-type bits (WP 8.4d) are inside it for the same reason: a
// holder has to reach /admin/api at all to use the routes the bit opens.
const AdminPerimeter = Administrator | ManageChannels | ManageRoles |
	ManageServer | ViewAuditLog | KickMembers | BanMembers | MuteMembers | ManageBackups |
	OwnerTierBits | AdministratorTierBits

// OwnerTierBits are the owner-type bits (WP 8.4d) whose actions were
// owner-only before they were bits: restoring and deleting backups and the
// full archive, the config overrides and restart, updates, API tokens and
// recovery credentials. The gate is the owner or the bit held explicitly;
// Administrator does NOT bypass it, because the seeded Admin role carries
// ADMINISTRATOR and these actions are owner-only today, so a bypass would hand
// every default Admin the owner's powers on upgrade.
const OwnerTierBits = RestoreBackups | ManageConfig | ManageUpdates | ManageTokens | IssueRecovery

// AdministratorTierBits are the owner-type bits (WP 8.4d) whose actions an
// Administrator already had: server diagnostics and account erasure.
// Administrator keeps passing them, and the bit lets a role without
// ADMINISTRATOR do just that.
const AdministratorTierBits = ViewDiagnostics | EraseAccounts

// OwnerGrantOnly is the mask of bits that only the owner or an Administrator
// may add to or remove from a role, or hand out by assigning a role that
// carries them. Holding ManageRoles is not enough for these. It includes both
// owner-type tiers; the owner tier is narrowed further by OwnerOnlyGrant.
const OwnerGrantOnly = MoveMembers | ManageBackups | OwnerTierBits | AdministratorTierBits

// OwnerOnlyGrant is the subset of OwnerGrantOnly that only the owner may add
// to or remove from a role or an override, or hand out by assigning a role
// that carries it (WP 8.4d). An Administrator is not enough: otherwise an
// Administrator could create a role with an owner-tier bit and give it to
// themself, which the owner tier's no-bypass rule exists to prevent.
const OwnerOnlyGrant = OwnerTierBits

// bitNames maps each single permission bit to its SCHEMA.md name. Used for
// authorization error messages so the wording lives in one place.
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

// IsOwner reports whether a role with the given id and hierarchy position is
// the owner role. Position alone is the ordinary test — the seeded owner role
// (OwnerRoleID) is accepted too, so a database whose positions were edited by
// hand still recognizes the real owner. This is the one predicate for "is the
// owner"; every call site asking the question calls it instead of comparing
// role.ID or role.Position itself (OC-0405).
func IsOwner(roleID int64, position int) bool {
	return roleID == OwnerRoleID || position >= OwnerRolePosition
}

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

// RoleGrant is one held role's contribution to a channel: the role's base
// mask and that role's own channel override (Allow/Deny, zero when the role
// has none there).
type RoleGrant struct {
	Perms int64
	Allow int64
	Deny  int64
	// RoleID names the role for traces (Explain); the formula ignores it.
	RoleID int64
}

// MemberChannelPerms resolves a member's permissions in ONE channel when they
// hold several roles. Each held role is resolved with its OWN override, the
// results are OR'd, and only then does the member's override apply:
//
//	roleLayer = OR over held roles r of ((perms_r & ^deny_r) | allow_r)
//	effective = (roleLayer & ^userDeny) | userAllow
//
// A role therefore only ever adds permissions: a restrictive role (Member with
// READ denied on a private channel) cannot take away a bit another held role
// (Moderator) grants. For a single grant this is exactly EffectiveChannelPerms.
// ADMINISTRATOR is not handled here, as in EffectiveChannelPerms: callers
// short-circuit on HasAdmin of the OR of the held masks.
func MemberChannelPerms(layers []RoleGrant, userAllow, userDeny int64) int64 {
	var roleLayer int64
	for _, g := range layers {
		roleLayer |= EffectivePerms(g.Perms, g.Allow, g.Deny)
	}
	return EffectivePerms(roleLayer, userAllow, userDeny)
}
