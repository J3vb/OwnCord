package admin

// support_event_codes_voice.go — the event codes for the voice-join handler
// and the voice reconciler.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"handleVoiceJoin: LiveKit process not running":                             "handlevoicejoin_livekit_process_not_running",
		"handleVoiceJoin: external LiveKit unreachable":                            "handlevoicejoin_external_livekit_unreachable",
		"handleVoiceJoin: could not verify voice state cleared":                    "handlevoicejoin_could_not_verify_voice_state",
		"handleVoiceJoin: nil user on client":                                      "handlevoicejoin_nil_user_on_client",
		"handleVoiceJoin: stale voice state persists after leave, aborting switch": "handlevoicejoin_stale_voice_state_persists_after_leave",
		"voice reconcile: ListRooms failed, checking rooms with rows only":         "voice_reconcile_listrooms_failed",
	})
}
