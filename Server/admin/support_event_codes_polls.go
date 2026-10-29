package admin

// The poll log messages. They live beside support_event_codes.go
// because that table is at the file-size ceiling; init folds them in.
func init() {
	supportEventCodes["poll create: read poll block failed"] = "poll_create_block_unreadable"
}
