package admin

// The private profile note handlers' log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["get user note"] = "get_user_note"
	supportEventCodes["put user note"] = "put_user_note"
}
