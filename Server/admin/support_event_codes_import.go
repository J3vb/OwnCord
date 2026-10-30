package admin

// Event codes for the Discord import's warnings and errors, merged into the
// main table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"discord import failed":                               "discord_import_failed",
		"discord import clean-up failed":                      "discord_import_cleanup_failed",
		"discord import: reading the finished channel failed": "discord_import_channel_read_failed",
		"failed to remove import file":                        "failed_to_remove_import_file",
		"login attempt on a system account":                   "login_attempt_on_system_account",
		"failed to clean up interrupted imports":              "failed_to_clean_up_interrupted_imports",
	})
}
