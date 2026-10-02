package admin

// support_event_codes_file_limit.go — the event codes for the boot-time
// open-file limit (RLIMIT_NOFILE) raise and its connection-budget warning.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"could not raise the open-file limit":            "could_not_raise_the_open_file_limit",
		"could not read the open-file limit":             "could_not_read_the_open_file_limit",
		"open-file limit is below the connection budget": "open_file_limit_below_connection_budget",
	})
}
