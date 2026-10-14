package admin

// The hub's content-gate log messages. They live beside support_event_codes.go
// because that table is at the file-size ceiling; init folds them in.
func init() {
	supportEventCodes["hub: content gate read panicked, denying all recipients"] = "hub_content_gate_read_panicked"
}
