package admin

// The WebSocket inbound budget's log message. It lives beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds it in.

func init() {
	supportEventCodes["ws inbound frame budget exceeded"] = "ws_inbound_frame_budget_exceeded"
}
