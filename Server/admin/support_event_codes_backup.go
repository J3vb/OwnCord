package admin

// support_event_codes_backup.go — the event codes for the owner safety net
// (pre-migration boot backup, full-archive download). Split out of
// support_event_codes.go so that file stays under the file-size limit; merged
// into the same table at init so the canary test and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"pre-migration backup written before applying migrations": "pre_migration_backup_written",
		"backup archive build failed":                             "backup_archive_build_failed",
		"backup archive downloaded":                               "backup_archive_downloaded",
		"backup archive download interrupted":                     "backup_archive_download_interrupted",
		"setup: failed to generate the recovery kit":              "setup_recovery_kit_generate_failed",
		"setup: failed to hash the recovery kit":                  "setup_recovery_kit_hash_failed",
		"setup: failed to store the recovery kit":                 "setup_recovery_kit_store_failed",
		"failed to issue archive link":                            "archive_link_issue_failed",
	})
}
