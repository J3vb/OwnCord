package admin

// support_event_codes_request_deadline.go — the event code for a REST handler
// failure that landed after the request deadline and was answered 503. Split
// out of support_event_codes.go so that file stays under the file-size limit;
// merged into the same table at init so the canary test and supportEvents see
// one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"request deadline exceeded; answering 503 instead of the handler's failure": "request_deadline_exceeded",
	})
}
