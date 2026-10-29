package admin

// The settings PATCH handler's log message. It lives beside
// support_event_codes.go because that table is at the file-size ceiling; init
// folds it in.
func init() {
	supportEventCodes["settings patch failed"] = "settings_patch_failed"
	// The hub's game activity switch: the setting could not be
	// read, at construction (stage=init) or on a save (stage=apply).
	supportEventCodes["game_activity_policy: reading the setting failed"] = "game_activity_policy_unreadable"
}
