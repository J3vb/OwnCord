package ws

import "github.com/J3vb/OwnCord/Server/service"

// readyCapabilities is the capabilities map a ready frame advertises. A new
// client reads each flag to decide whether the server understands a feature,
// so a flag is added here in the change that makes the feature work.
func readyCapabilities(retryFloorMS int64) map[string]any {
	return map[string]any{
		"message_deduplication":        true,
		"message_retry_window_seconds": int64(service.MessageRetryWindow.Seconds()),
		"message_retry_floor_ms":       retryFloorMS,
		"read_pointer":                 true,
		"user_notes":                   true,
		"profile_banners":              true,
		"dm_privacy":                   true,
		"polls":                        true,
	}
}
