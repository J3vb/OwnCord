package admin

// The poll expirer log messages. They live beside
// support_event_codes_polls.go because support_event_codes.go is at the
// file-size ceiling; init folds them in.
func init() {
	supportEventCodes["poll expirer: read next expiry failed"] = "poll_expirer_read_next_expiry_failed"
	supportEventCodes["poll expirer: sweep failed"] = "poll_expirer_sweep_failed"
	supportEventCodes["poll expirer: unparseable expiry"] = "poll_expirer_unparseable_expiry"
	supportEventCodes["poll-expiry: boot sweep failed"] = "poll_expiry_boot_sweep_failed"
	supportEventCodes["poll write failed"] = "poll_write_failed"
	supportEventCodes["poll end: resolve DM participants failed"] = "poll_end_dm_audience_failed"
}
