package admin

// The settings PATCH handler's log message. It lives beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds it in.
func init() {
	supportEventCodes["settings patch failed"] = "settings_patch_failed"
}
