package admin

// support_event_codes_dm.go — the event code for the DM ring-reopen warning.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"DMService.OpenForRing OpenDM":  "dmservice_openforring_opendm",
		"DMService.OpenForRing summary": "dmservice_openforring_summary",
		"DMService.OpenForRing history": "dmservice_openforring_history",
		"MessageService.SendMessage GetGroupDMOwner failed, the open carries no owner_id": "messageservice_sendmessage_getgroupdmowner",
		"fanOutGroupChange: broadcaster cannot deliver group rows":                        "fanoutgroupchange_no_row_sink",
		"group row: author lookup failed":                                                 "groupevent_author_lookup",
	})
}
