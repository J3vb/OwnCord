package admin

// The server icon's log messages: a change that could not be stored, the row mirror that did not follow it,
// and a read of the icon file that failed. They live beside support_event_codes.go because that table is at the
// file-size ceiling; init folds them in.
func init() {
	supportEventCodes["server icon update failed"] = "server_icon_update_failed"
	supportEventCodes["server icon read failed"] = "server_icon_read_failed"
}
