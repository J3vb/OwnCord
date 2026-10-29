package permissions

// The WP 8.4d owner-type predicates. They sit apart from predicates.go (file
// size) and follow the same rule: one predicate per security property, so a
// call site cannot re-derive half of it. The tiers are described on
// OwnerTierBits and AdministratorTierBits in permissions.go.

// CanChangeOwnerOnlyGrant reports whether a principal may add or remove the
// bits in OwnerOnlyGrant (the owner-tier bits, WP 8.4d) on a role or an
// override, or hand them out by assigning a role that carries them: the owner
// only, by role identity (see IsOwner). Neither ADMINISTRATOR nor MANAGE_ROLES
// nor the bit itself is enough.
func CanChangeOwnerOnlyGrant(topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition)
}

// ownerOrExplicit is the owner-tier gate: the owner by role identity, or the
// bit held explicitly. It uses HasPerm, never HasServerPerm, so
// ADMINISTRATOR does not stand in for the bit (see OwnerTierBits).
func ownerOrExplicit(rolePerms int64, bit int64, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasPerm(rolePerms, bit)
}

// CanRestoreBackups reports whether a principal may restore or delete a
// backup, download the full archive and redeem those links (WP 8.4d): the
// owner or an explicit RESTORE_BACKUPS holder. Administrator does not pass.
func CanRestoreBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, RestoreBackups, topRoleID, topRolePosition)
}

// CanListBackups reports whether a principal may list the backups on disk:
// anyone who can create one (CanManageBackups) or restore one
// (CanRestoreBackups), so a restorer can pick the backup to restore.
func CanListBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return CanManageBackups(rolePerms, topRoleID, topRolePosition) ||
		CanRestoreBackups(rolePerms, topRoleID, topRolePosition)
}

// CanManageConfig reports whether a principal may read and change the config
// overrides and restart the server (WP 8.4d): the owner or an explicit
// MANAGE_CONFIG holder. Administrator does not pass.
func CanManageConfig(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageConfig, topRoleID, topRolePosition)
}

// CanManageUpdates reports whether a principal may check for and apply server
// updates (WP 8.4d): the owner or an explicit MANAGE_UPDATES holder.
// Administrator does not pass.
func CanManageUpdates(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageUpdates, topRoleID, topRolePosition)
}

// CanManageTokens reports whether a principal may use the API token routes
// (WP 8.4d): the owner or an explicit MANAGE_TOKENS holder. A holder who is
// not the owner is confined to their own tokens by the handler. Administrator
// does not pass.
func CanManageTokens(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageTokens, topRoleID, topRolePosition)
}

// CanIssueRecovery reports whether a principal may issue a recovery
// credential (WP 8.4d): the owner or an explicit ISSUE_RECOVERY holder.
// Administrator does not pass. A holder who is not the owner may only issue to
// a member ranked strictly below them; the service enforces that.
func CanIssueRecovery(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, IssueRecovery, topRoleID, topRolePosition)
}

// CanViewDiagnostics reports whether a principal may open the server log
// stream, read or change the log level, build a support bundle and read the
// attention panel (WP 8.4d): VIEW_DIAGNOSTICS, which Administrator implies.
func CanViewDiagnostics(rolePerms int64) bool {
	return HasServerPerm(rolePerms, ViewDiagnostics)
}

// CanEraseAccounts reports whether a principal may erase a member's account
// (WP 8.4d): ERASE_ACCOUNTS, which Administrator implies. The actor must still
// strictly outrank the target; the service enforces that.
func CanEraseAccounts(rolePerms int64) bool {
	return HasServerPerm(rolePerms, EraseAccounts)
}
