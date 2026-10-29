package admin

// support_event_codes_voice.go — the event codes for the voice-join handler
// the voice reconciler and the removed-identity watch.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{ //nolint:gosec // G101: false positive — log messages and event codes, not credentials
		"handleVoiceJoin: LiveKit process not running":                              "handlevoicejoin_livekit_process_not_running",
		"handleVoiceJoin: external LiveKit unreachable":                             "handlevoicejoin_external_livekit_unreachable",
		"handleVoiceJoin: could not verify voice state cleared":                     "handlevoicejoin_could_not_verify_voice_state",
		"handleVoiceJoin: nil user on client":                                       "handlevoicejoin_nil_user_on_client",
		"handleVoiceJoin: stale voice state persists after leave, aborting switch":  "handlevoicejoin_stale_voice_state_persists_after_leave",
		"voice reconcile: ListRooms failed, checking rooms with rows only":          "voice_reconcile_listrooms_failed",
		"voice removed watch: ListParticipants failed, retrying next tick":          "voice_removed_watch_listparticipants_failed",
		"voice removed watch: reading voice state failed, retrying next tick":       "voice_removed_watch_read_voice_state_failed",
		"ws voiceModTarget owner movable setting":                                   "ws_voicemodtarget_owner_movable_setting",
		"ws voice_join: channel password grant lookup failed, denying":              "ws_voice_join_password_grant_lookup_failed",
		"ws voice_join: channel password lookup failed, denying":                    "ws_voice_join_password_lookup_failed",
		"ws voice_join: storing the channel password grant failed, denying":         "ws_voice_join_password_grant_store_failed",
		"ws voice_join: channel password attempts rate limited":                     "ws_voice_join_password_rate_limited",
		"ws voice_join: wrong channel password":                                     "ws_voice_join_password_wrong",
		"ws voice_join: channel password changed during the join":                   "ws_voice_join_password_changed_during_join",
		"ws voice_mod_move: granting the destination password failed":               "ws_voice_mod_move_password_grant_failed",
		"voice afk: granting the AFK channel password failed, member left in place": "voice_afk_password_grant_failed",
		"voice afk: sweep read failed":                                              "voice_afk_sweep_read_failed",
		"voice removed watch: removing participant failed, retrying next tick":      "voice_removed_watch_remove_participant_failed",
		"hub: evicting oldest connection over the per-user cap":                     "hub_evicting_oldest_connection_over_cap",
		"handleVoiceJoin: could not verify voice state cleared after move":          "handlevoicejoin_could_not_verify_voice_state_after_move",
		"handleVoiceJoin: stale voice state persists after move, aborting join":     "handlevoicejoin_stale_voice_state_persists_after_move",
		"ws auth: identity_public_key ignored, not a string":                        "ws_auth_identity_key_ignored_not_string",
		"ws auth: identity_public_key ignored, invalid":                             "ws_auth_identity_key_ignored_invalid",
		"ws auth: recording the session identity key failed":                        "ws_auth_record_session_identity_key_failed",
		"ws voice_e2ee_announce: identity_public_key ignored, not a string":         "ws_voice_e2ee_announce_identity_key_ignored_not_string",
		"ws voice_e2ee_announce: identity_public_key ignored, invalid":              "ws_voice_e2ee_announce_identity_key_ignored_invalid",
	})
}
