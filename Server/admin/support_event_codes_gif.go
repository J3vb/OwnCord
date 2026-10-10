package admin

// The saved-GIF handlers' log messages. They live beside support_event_codes.go
// because that table is at the file-size ceiling; init folds them in.
func init() {
	supportEventCodes["add gif favorite"] = "add_gif_favorite"
	supportEventCodes["list gif favorites"] = "list_gif_favorites"
	supportEventCodes["remove gif favorite"] = "remove_gif_favorite"
}
