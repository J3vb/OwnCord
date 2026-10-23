package admin

// support_event_codes_voice_webhook.go — the event code for the LiveKit leave
// webhook's row-only removal. Split out of support_event_codes.go so that file
// stays under the file-size limit; merged into the same table at init.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"livekit webhook: LeaveVoiceChannelIfMatch failed": "livekit_webhook_leavevoicechannelifmatch_failed",
	})
}
