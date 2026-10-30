package admin

// The custom sticker log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["failed to clean up orphaned sticker file"] = "failed_to_clean_up_orphaned_sticker"
	supportEventCodes["failed to load stickers for broadcast"] = "failed_to_load_stickers_for_broadcast"
	supportEventCodes["failed to remove sticker file"] = "failed_to_remove_sticker_file"
}
