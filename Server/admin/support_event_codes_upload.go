package admin

// support_event_codes_upload.go — the event codes for the upload and avatar
// cleanup warnings. Split out of support_event_codes.go so that file stays
// under the file-size limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"failed to clean up refused upload file": "failed_to_clean_up_refused_upload",
		"file link token generation failed":      "file_link_token_generation_failed",
		"failed to delete discarded upload":      "failed_to_delete_discarded_upload",
		"failed to remove orphaned avatar row":   "failed_to_remove_orphaned_avatar_row",
		"could not convert an image preview":     "image_preview_conversion_failed",
	})
}
