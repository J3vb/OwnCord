package admin

// support_event_codes_registration.go — the event codes for a refused
// sign-up. Split out of support_event_codes.go so that file stays under the
// file-size limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"registration refused":                          "registration_refused",
		"registration refusal: invite read-back failed": "registration_invite_readback_failed",
	})
}
