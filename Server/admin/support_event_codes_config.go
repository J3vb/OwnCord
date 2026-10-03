package admin

// support_event_codes_config.go — the event code for a non-editable key found
// in the admin panel's config-overrides.json. Split out of
// support_event_codes.go so that file stays under the file-size limit; merged
// into the same table at init so the canary test and supportEvents see one map.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"config: ignoring non-editable key in overrides file (typo, or a protected key)": "config_overrides_non_editable_key",
		"config: ignoring invalid value in overrides file (wrong type or out of range)":   "config_overrides_invalid_value",
	})
}
