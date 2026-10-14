package admin

// The hub's replay purge log messages. They live beside support_event_codes.go
// because that table is at the file-size ceiling; init folds them in.
func init() {
	supportEventCodes["hub: replay purge unfinished; cold-tier replay is off until it is retried"] = "hub_replay_purge_unfinished"
}
