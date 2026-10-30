package admin

// The message forwarding log messages. They live beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds them in.
func init() {
	supportEventCodes["forward: could not remove an unused clone row; the orphan sweep will"] = "forward_clone_row_not_removed"
	supportEventCodes["forward: could not remove an unused clone file; the orphan sweep will"] = "forward_clone_file_not_removed"
	supportEventCodes["forward: could not remove a clone whose row failed; the reconciliation pass will"] = "forward_clone_file_orphaned"
	supportEventCodes["storage: failed to remove partial clone"] = "storage_failed_to_remove_partial_clone"
}
