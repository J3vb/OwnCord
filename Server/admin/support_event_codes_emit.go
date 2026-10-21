package admin

// The event router's drop log. It lives beside support_event_codes.go because
// that table is at the file-size ceiling; init folds it in.
func init() {
	supportEventCodes["EmitEvents: unroutable event dropped"] = "emitevents_unroutable_event_dropped"
}
