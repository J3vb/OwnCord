package admin

// The message-history read's log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["MessageService.GetMessagesAfter"] = "messageservice_getmessagesafter"
	supportEventCodes["service: channel lookup timed out"] = "service_channel_lookup_timed_out"
	supportEventCodes["service: channel lookup failed"] = "service_channel_lookup_failed"
}
