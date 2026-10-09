package admin

// support_event_codes_dm.go — the event code for the DM ring-reopen warning.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"DMService.OpenForRing OpenDM":  "dmservice_openforring_opendm",
		"DMService.OpenForRing summary": "dmservice_openforring_summary",
	})
}
