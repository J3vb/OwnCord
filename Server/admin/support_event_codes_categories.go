package admin

// The channel category log messages (WP 6.5a). They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["hub: channel_categories verdict unknown, user skipped"] = "hub_channel_categories_verdict_unknown"
}
