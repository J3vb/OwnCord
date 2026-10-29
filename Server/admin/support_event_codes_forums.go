package admin

// support_event_codes_forums.go - the event codes for the forum post
// feature's Warn/Error literals.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"forum post attachments lookup":                                            "forum_post_attachments_lookup_failed",
		"forum post channel lookup":                                                "forum_post_channel_lookup_failed",
		"ws: forum post check could not read the parent, withholding":              "ws_forum_post_check_failed",
		"ws handleReconnect: dropForumChannels failed, falling back to full ready": "ws_reconnect_drop_forum_channels_failed",
	})
}
