package admin

// support_event_codes_archive.go — the event codes for the full-archive
// download (O3). Split out of support_event_codes.go so that file stays under
// the file-size limit; merged into the same table at init so the canary test
// and supportEvents see one map.

func init() {
	for message, code := range map[string]string{
		"backup archive build failed":         "backup_archive_build_failed",
		"backup archive downloaded":           "backup_archive_downloaded",
		"backup archive download interrupted": "backup_archive_download_interrupted",
	} {
		supportEventCodes[message] = code
	}
}
