package admin

func init() {
	// Moderator timeout view.
	supportEventCodes["hub: publishMemberTimeouts skipped, timeout mirror not loaded"] = "hub_publish_member_timeouts_mirror_unloaded"
	supportEventCodes["hub: refreshTimeoutViewsAfterRoleChange skipped, timeout mirror not loaded"] = "hub_refresh_timeout_views_mirror_unloaded"
	supportEventCodes["hub: member_timeouts verdict unknown, user skipped"] = "hub_member_timeouts_verdict_unknown"
	// Timeout expiry lifting its own voice mute.
	supportEventCodes["hub: timeout expiry could not read voice state"] = "hub_timeout_expiry_read_voice_state_failed"
	supportEventCodes["hub: timeout expiry could not list active timeouts"] = "hub_timeout_expiry_list_active_failed"
}
