package admin

// The message-history read's log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["MessageService.GetMessagesAfter"] = "messageservice_getmessagesafter"
}
