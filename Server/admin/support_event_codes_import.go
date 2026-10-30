package admin

// Event codes for the Discord import's warnings and errors, merged into the
// main table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"discord import failed":                                "discord_import_failed",
		"discord import clean-up failed":                       "discord_import_cleanup_failed",
		"discord import: reading the finished channel failed":  "discord_import_channel_read_failed",
		"failed to remove import file":                         "failed_to_remove_import_file",
		"login attempt on a system account":                    "login_attempt_on_system_account",
		"failed to clean up interrupted imports":               "failed_to_clean_up_interrupted_imports",
		"discord import: reading the retention window failed":  "discord_import_retention_read_failed",
		"discord import: creating the upload directory failed": "discord_import_upload_dir_failed",
		"discord import: creating the upload file failed":      "discord_import_upload_file_failed",
		"discord import: receiving the upload failed":          "discord_import_upload_receive_failed",
		"discord import: closing the export failed":            "discord_import_export_close_failed",
		"discord import: removing the upload failed":           "discord_import_upload_remove_failed",
		"discord import: starting failed":                      "discord_import_start_failed",
		"could not clear the import upload directory":          "import_upload_dir_clear_failed",
	})
}
