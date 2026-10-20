package admin

// support_event_codes_deadline.go — the event code for a WebSocket command cut
// short by the per-frame deadline. Split out of support_event_codes.go so that
// file stays under the file-size limit; merged into the same table at init so
// the canary test and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"ws command deadline exceeded": "ws_command_deadline_exceeded",
	})
}
