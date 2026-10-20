package admin

// support_event_codes_seq_floor.go — event codes for the WebSocket sequence
// floor sidecar. Split out so support_event_codes.go stays under the
// file-size limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"event persistence: ws seq floor sidecar unreadable; using the settings value": "event_persistence_seq_floor_sidecar_unreadable",
		"event persistence: failed to persist ws seq floor sidecar":                    "event_persistence_persist_seq_floor_sidecar_failed",
		"event persistence: stored ws seq floor is above the limit, using the limit":   "event_persistence_seq_floor_out_of_range",
		"event persistence: ws seq floor reached its limit, keeping the limit":         "event_persistence_seq_floor_saturated",
	})
}
