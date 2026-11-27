package admin

// support_event_codes_console_ctrl.go — the event code for the Windows
// sign-out filter the server installs when it runs in the services session.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"could not filter Windows sign-out events; a user signing out of this machine may stop the server": "windows_signout_filter_failed",
	})
}
