package admin

// The profile banner handlers' and file-route probe's log messages,
// beside support_event_codes.go because that table is at the file-size ceiling.
func init() {
	supportEventCodes["failed to remove orphaned banner row"] = "failed_to_remove_orphaned_banner_row"
	supportEventCodes["failed to clean up orphaned banner file"] = "failed_to_clean_up_orphaned_banner"
	supportEventCodes["failed to check banner file"] = "failed_to_check_banner_file"
}
