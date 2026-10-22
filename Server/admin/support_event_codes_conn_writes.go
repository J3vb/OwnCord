package admin

// support_event_codes_conn_writes.go — the event codes for the batched
// connection writes (service.ConnWrites: session touches and connect/disconnect
// status stamps). Split out of support_event_codes.go so that file stays under
// the file-size limit; merged into the same table at init so the canary test
// and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"connection stamps flush failed, retrying next interval":                                       "connection_stamps_flush_failed",
		"session touches flush failed, retrying next interval":                                         "session_touches_flush_failed",
		"api token touches flush failed, retrying next interval":                                       "api_token_touches_flush_failed",
		"expired session discards flush failed, retrying next interval":                                "expired_session_discards_flush_failed",
		"background jobs still running at shutdown, abandoning them":                                   "background_jobs_abandoned_at_shutdown",
		"hub background jobs still running at shutdown, abandoning them":                               "hub_background_jobs_abandoned_at_shutdown",
		"conn-writes: database already closed, dropping pending session touches and connection stamps": "conn_writes_database_closed_dropping_pending",
	})
}
