package admin

// The channel category log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["hub: channel_categories verdict unknown, user skipped"] = "hub_channel_categories_verdict_unknown"
	supportEventCodes["created category could not be read back"] = "channel_created_category_read_failed"
	supportEventCodes["category list unavailable after create"] = "channel_category_list_failed"
}
