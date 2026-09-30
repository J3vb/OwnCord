package admin

// support_event_codes_update.go — the event codes for the self-update binary
// swap and the restart handoff. Split out of support_event_codes.go so that
// file stays under the file-size limit; merged into the same table at init so
// the canary test and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"update: reserving a name for the previous binary failed": "update_reserving_old_binary_name_failed",
		"failed to list old binaries":                             "failed_to_list_old_binaries",
		"restart: teardown is wedged, so this process exits to release what it still holds instead of staying behind; on a Windows console the replacement opens in a new console window": "restart_teardown_wedged_exiting",
	})
}
