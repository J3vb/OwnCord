package admin

func init() {
	// Role-change fan-out worker (ws/role_refresh_round.go).
	supportEventCodes["hub: role refresh could not resolve permissions, closing socket"] = "hub_role_refresh_resolve_permissions_failed"
	supportEventCodes["hub: role refresh member_update skipped, role unreadable"] = "hub_role_refresh_member_update_role_unreadable"
	supportEventCodes["hub: role refresh roles_update skipped, role list unreadable"] = "hub_role_refresh_roles_update_list_unreadable"
	supportEventCodes["hub: role refresh could not list channels, retrying"] = "hub_role_refresh_list_channels_retry"
	supportEventCodes["hub: role refresh could not list DM channels, retrying"] = "hub_role_refresh_list_dm_channels_retry"
	// Drain wait expired: the client resyncs instead of being disconnected.
	supportEventCodes["hub: role refresh client did not drain, marked to resync"] = "hub_role_refresh_client_resync"
	// ws/hub_visibility.go: a channel visibility walk ran out of time.
	supportEventCodes["hub: RefreshChannelVisibility timed out, unreached clients marked for resync"] = "hub_refreshchannelvisibility_timed_out"
}
