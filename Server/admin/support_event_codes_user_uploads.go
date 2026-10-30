package admin

// support_event_codes_user_uploads.go — the event codes for the warnings of the
// signed-in user's own upload removal. Merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"failed to check removed upload file":                                               "failed_to_check_removed_upload_file",
		"failed to delete removed upload":                                                   "failed_to_delete_removed_upload",
		"failed to announce removed upload":                                                 "failed_to_announce_removed_upload",
		"own upload removed; storage recount failed, the next recount will fix the counter": "own_upload_removed_recount_failed",
		"MessageService.AfterAttachmentRemoved ReplaceMessageMentions":                      "after_attachment_removed_replace_mentions",
		"MessageService.AfterAttachmentRemoved DMAudience":                                  "after_attachment_removed_dm_audience",
	})
}
