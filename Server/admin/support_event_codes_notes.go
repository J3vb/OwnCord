package admin

// The private profile note and DM privacy handlers' log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["get user note"] = "get_user_note"
	supportEventCodes["put user note"] = "put_user_note"
	supportEventCodes["get privacy"] = "get_privacy"
	supportEventCodes["set privacy"] = "set_privacy"
	supportEventCodes["privacy: voice call lookup for eviction failed"] = "privacy_voice_call_lookup_for_eviction_failed"
}
