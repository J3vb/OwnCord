package admin

func init() {
	// Moderator timeout view (WP 3C-7c).
	supportEventCodes["hub: publishMemberTimeouts skipped, timeout mirror not loaded"] = "hub_publish_member_timeouts_mirror_unloaded"
	supportEventCodes["hub: refreshTimeoutViewsAfterRoleChange skipped, timeout mirror not loaded"] = "hub_refresh_timeout_views_mirror_unloaded"
}
