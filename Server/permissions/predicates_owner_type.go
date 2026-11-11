package permissions

// Owner-type predicates; the tiers are on OwnerTierBits and AdministratorTierBits.

// CanChangeOwnerOnlyGrant reports whether a principal may change the
// OwnerOnlyGrant bits: the owner only; ADMINISTRATOR, MANAGE_ROLES or the bit is not enough.
func CanChangeOwnerOnlyGrant(topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition)
}

// ownerOrExplicit is the owner-tier gate: the owner or the bit held explicitly.
// HasPerm, never HasServerPerm, so ADMINISTRATOR does not stand in.
func ownerOrExplicit(rolePerms int64, bit int64, topRoleID int64, topRolePosition int) bool {
	return IsOwner(topRoleID, topRolePosition) || HasPerm(rolePerms, bit)
}

// CanRestoreBackups reports whether a principal may restore or delete a backup
// or download the full archive: the owner or an explicit RESTORE_BACKUPS holder.
func CanRestoreBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, RestoreBackups, topRoleID, topRolePosition)
}

// CanListBackups reports whether a principal may create or restore backups.
func CanListBackups(rolePerms, topRoleID int64, topRolePosition int) bool {
	return CanManageBackups(rolePerms, topRoleID, topRolePosition) ||
		CanRestoreBackups(rolePerms, topRoleID, topRolePosition)
}

// CanManageConfig reports whether a principal may change config overrides and
// restart the server: the owner or an explicit MANAGE_CONFIG holder.
func CanManageConfig(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageConfig, topRoleID, topRolePosition)
}

// CanManageUpdates reports whether a principal may check for and apply updates:
// the owner or an explicit MANAGE_UPDATES holder.
func CanManageUpdates(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageUpdates, topRoleID, topRolePosition)
}

// CanManageTokens reports whether a principal may use the API token routes: the
// owner or an explicit MANAGE_TOKENS holder (confined to their own tokens by the handler).
func CanManageTokens(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, ManageTokens, topRoleID, topRolePosition)
}

// CanIssueRecovery reports whether a principal may issue a recovery credential:
// the owner or an explicit ISSUE_RECOVERY holder, who must outrank the target (enforced by the service).
func CanIssueRecovery(rolePerms, topRoleID int64, topRolePosition int) bool {
	return ownerOrExplicit(rolePerms, IssueRecovery, topRoleID, topRolePosition)
}

// CanViewDiagnostics reports whether a principal holds VIEW_DIAGNOSTICS, which Administrator implies.
func CanViewDiagnostics(rolePerms int64) bool {
	return HasServerPerm(rolePerms, ViewDiagnostics)
}

// CanEraseAccounts reports whether a principal holds ERASE_ACCOUNTS, which
// Administrator implies; the service still enforces strict outranking.
func CanEraseAccounts(rolePerms int64) bool {
	return HasServerPerm(rolePerms, EraseAccounts)
}
