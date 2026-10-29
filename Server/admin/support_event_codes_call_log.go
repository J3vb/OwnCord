package admin

func init() {
	// DM call log worker.
	supportEventCodes["call log: list open calls"] = "call_log_list_open_calls"
	supportEventCodes["call log: reconcile"] = "call_log_reconcile"
	supportEventCodes["call log: delivery targets"] = "call_log_delivery_targets"
	supportEventCodes["call log: author lookup"] = "call_log_author_lookup"
	supportEventCodes["call log: read ended call"] = "call_log_read_ended_call"
	supportEventCodes["call log: delivery targets for end"] = "call_log_delivery_targets_for_end"
	supportEventCodes["call log: recovery list"] = "call_log_recovery_list"
	supportEventCodes["call log: recovery end"] = "call_log_recovery_end"
	supportEventCodes["call log: stop list"] = "call_log_stop_list"
	supportEventCodes["call log: stop stamp"] = "call_log_stop_stamp"
}
