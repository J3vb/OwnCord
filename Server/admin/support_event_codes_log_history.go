package admin

// support_event_codes_log_history.go — the event codes for the saved log
// history writer and its admin route. Merged into the same table at init so
// the canary test and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"log history: lines dropped because the disk writer fell behind": "log_history_lines_dropped",
		"log history: saving logs to disk paused until tomorrow":         "log_history_disk_write_paused",
		"log history: reading saved logs failed":                         "log_history_read_failed",
	})
}
