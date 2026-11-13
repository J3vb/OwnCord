package admin

// support_event_codes_link_previews.go - event codes for the link preview thumbnail store and its
// maintenance step. Merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"failed to remove link preview file":                          "linkpreview_file_remove_failed",
		"failed to open link preview store; thumbnail sweep disabled": "linkpreview_store_open_failed",
		"link preview thumbnails trimmed":                             "linkpreview_thumbnails_trimmed",
		"link preview thumbnail sweep failed":                         "linkpreview_sweep_failed",
	})
}
