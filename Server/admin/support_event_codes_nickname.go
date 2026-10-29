package admin

// The moderator nickname change's log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["moderator nickname re-read failed; returning locally merged row"] = "moderator_nickname_re_read_failed"
}
