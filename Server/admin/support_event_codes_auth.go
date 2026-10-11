package admin

// support_event_codes_auth.go — the event codes for an auth or recovery
// refusal whose cause is logged server-side rather than sent to the client.
// Split out of support_event_codes.go so that file stays under the file-size
// limit; merged into the same table at init so the canary test and
// supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{ //nolint:gosec // G101: false positive — log messages and event codes, not credentials
		"login: reading require_2fa failed":                     "login_require_2fa_read_failed",
		"login: session issue failed":                           "login_session_issue_failed",
		"logout: session delete failed":                         "logout_session_delete_failed",
		"recovery assist: secret generation failed":             "recovery_assist_secret_generation_failed",
		"recovery assist: verifier hashing failed":              "recovery_assist_verifier_hashing_failed",
		"recovery kit: read-back failed":                        "recovery_kit_readback_failed",
		"recovery kit: secret generation failed":                "recovery_kit_secret_generation_failed",
		"recovery kit: verifier hashing failed":                 "recovery_kit_verifier_hashing_failed",
		"recovery: dummy verifier unavailable":                  "recovery_dummy_verifier_unavailable",
		"recovery: new password hashing failed":                 "recovery_password_hashing_failed",
		"recovery: re-reading the user after redeem failed":     "recovery_user_reread_failed",
		"register: counting pending applications failed":        "register_pending_count_failed",
		"register: password hashing failed":                     "register_password_hashing_failed",
		"register: reading registration_mode failed":            "register_mode_read_failed",
		"registration policy: reading registration_mode failed": "registration_policy_mode_read_failed",
		"registration policy: reading require_2fa failed":       "registration_policy_require_2fa_read_failed",
		"totp confirm: storing the secret failed":               "totp_confirm_store_failed",
		"totp disable: clearing the secret failed":              "totp_disable_clear_failed",
		"totp disable: reading require_2fa failed":              "totp_disable_require_2fa_read_failed",
		"totp enrol: secret generation failed":                  "totp_enrol_secret_generation_failed",
		"verify-totp: session issue failed":                     "verify_totp_session_issue_failed",
	})
}
