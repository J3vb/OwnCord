package admin

// Event codes for the chunked account erasure's Warn/Error messages.
// A separate file because support_event_codes.go is at the file-size limit.
func init() {
	supportEventCodes["erasure: a stage failed after the lock; the maintenance loop finishes the erasure"] = "erasure_stage_failed_after_lock"
}
