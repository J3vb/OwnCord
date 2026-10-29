package admin

func init() {
	// Role-change fan-out worker (ws/role_refresh_round.go).
	supportEventCodes["hub: role refresh could not resolve permissions, closing socket"] = "hub_role_refresh_resolve_permissions_failed"
	supportEventCodes["hub: role refresh member_update skipped, role unreadable"] = "hub_role_refresh_member_update_role_unreadable"
	supportEventCodes["hub: role refresh roles_update skipped, role list unreadable"] = "hub_role_refresh_roles_update_list_unreadable"
	supportEventCodes["hub: role refresh could not list channels, retrying"] = "hub_role_refresh_list_channels_retry"
}
