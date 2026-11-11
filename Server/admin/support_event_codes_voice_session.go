package admin

// support_event_codes_voice_session.go — event codes for the signalling
// proxy's voice session check. Split out of support_event_codes.go so that
// file stays under the file-size limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"livekit proxy: voice session check failed":                 "livekit_proxy_voice_session_check_failed",
		"livekit proxy: voice session confirm failed":               "livekit_proxy_voice_session_confirm_failed",
		"voice session: removing a session whose join ended failed": "voice_session_remove_ended_join_failed",
	})
}
