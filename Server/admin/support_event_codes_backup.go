package admin

// support_event_codes_backup.go — the event codes for the owner safety net
// (pre-migration boot backup, full-archive download). Split out of
// support_event_codes.go so that file stays under the file-size limit; merged
// into the same table at init so the canary test and supportEvents see one map.

func init() {
	for message, code := range map[string]string{
		"pre-migration backup written before applying migrations": "pre_migration_backup_written",
		"backup archive build failed":                             "backup_archive_build_failed",
		"backup archive downloaded":                               "backup_archive_downloaded",
		"backup archive download interrupted":                     "backup_archive_download_interrupted",
	} {
		supportEventCodes[message] = code
	}
}
