package admin

// support_event_codes_link_previews.go - event codes for the link preview thumbnail store and its
// maintenance step. Merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"failed to remove link preview file":                                "linkpreview_file_remove_failed",
		"failed to open link preview store; thumbnail sweep disabled":       "linkpreview_store_open_failed",
		"link preview thumbnails trimmed":                                   "linkpreview_thumbnails_trimmed",
		"link preview thumbnail sweep failed":                               "linkpreview_sweep_failed",
		"link preview thumbnail row unreadable":                             "linkpreview_image_read_failed",
		"link previews: audience unavailable":                               "linkpreview_audience_failed",
		"link previews disabled: the fetch policies were refused":           "linkpreview_policy_refused",
		"link preview workers did not stop before the close budget ran out": "linkpreview_stop_timeout",
		"history link previews unavailable":                                 "linkpreview_history_failed",
		"link preview: reading earlier cards failed":                        "linkpreview_cards_read_failed",
		"link preview: storing message previews failed":                     "linkpreview_replace_failed",
		"link preview: reading message previews failed":                     "linkpreview_previews_read_failed",
		"link preview: storing a card failed":                               "linkpreview_card_store_failed",
		"link preview last-used update failed":                              "linkpreview_touch_failed",
		"link preview queue full; job dropped":                              "linkpreview_queue_full",
		"link preview job panicked":                                         "linkpreview_job_panicked",
	})
}
