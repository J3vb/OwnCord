package admin

// httperr's log message (the JSON error reply outside api and admin). It lives
// beside support_event_codes.go because that table is at the file-size
// ceiling; init folds it in.
func init() {
	supportEventCodes["httperr: failed to encode error reply"] = "httperr_failed_to_encode_error_reply"
}
