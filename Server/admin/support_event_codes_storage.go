package admin

// support_event_codes_storage.go — the event codes for the warnings of the
// admin Storage page: bulk delete and the leftover file cleanup. Merged into
// the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"storage page: upload removal failed":                                                       "storage_page_removal_failed",
		"storage page: shared file check failed":                                                    "storage_page_shared_check_failed",
		"storage page: file stayed on disk":                                                         "storage_page_file_kept",
		"storage page: removed file not announced":                                                  "storage_page_announce_failed",
		"storage page: a leftover file could not be removed":                                        "storage_page_leftover_kept",
		"storage page: leftover cleanup failed":                                                     "storage_page_cleanup_failed",
		"upload removed by an admin; storage recount failed, the next recount will fix the counter": "admin_upload_removed_recount_failed",
	})
}
