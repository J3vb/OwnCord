package ws

import "github.com/J3vb/OwnCord/Server/service"

// readyCapabilities is the capabilities object a ready frame advertises. A new
// client reads each flag to decide whether the server understands a feature,
// so a flag is added here in the change that makes the feature work.
//
// A struct, not a map: every ready builds one, and a map of boxed values cost
// about 1 KB per ready (TestWriteReady_AllocatesAFifthOfTheRoster). Fields stay
// in key order so the encoded bytes match what the map produced.
type readyCapabilitiesPayload struct {
	DMPrivacy                 bool  `json:"dm_privacy"`
	Forums                    bool  `json:"forums"`             // WP 6.9d: forum_post_create and a forum's posts
	GameActivity              bool  `json:"game_activity"`      // WP 8.3a: activity_update, presence.activity and ready.activities; WP 8.3e-2: false while an admin has it off
	ListeningActivity         bool  `json:"listening_activity"` // WP 8.10a: listening_update, presence.listening and ready.listening; follows the same switch as game_activity
	ManageNicknames           bool  `json:"manage_nicknames"`   // WP 6.4: PUT /api/v1/moderation/users/{id}/nickname
	MessageDeduplication      bool  `json:"message_deduplication"`
	MessageRetryFloorMS       int64 `json:"message_retry_floor_ms"`
	MessageRetryWindowSeconds int64 `json:"message_retry_window_seconds"`
	MultiRole                 bool  `json:"multi_role"` // WP 6.3c: role_ids, hoist, role add/remove
	Polls                     bool  `json:"polls"`
	ProfileBanners            bool  `json:"profile_banners"`
	ReadPointer               bool  `json:"read_pointer"`
	Stickers                  bool  `json:"stickers"`       // WP 8.8a: sticker_id on chat_send, chat_message.sticker and sticker_update
	ThreadFollows             bool  `json:"thread_follows"` // WP 6.9c: thread_follow, thread_follow_update and ready.threads
	Threads                   bool  `json:"threads"`        // WP 6.9c: thread_* commands and frames
	UserNotes                 bool  `json:"user_notes"`
	VoiceMessages             bool  `json:"voice_messages"` // WP 8.9: duration_ms and waveform on an upload and its attachment
}

func readyCapabilities(retryFloorMS int64, threads, forums, gameActivity bool) readyCapabilitiesPayload {
	return readyCapabilitiesPayload{
		DMPrivacy:                 true,
		Forums:                    forums,
		GameActivity:              gameActivity,
		ListeningActivity:         gameActivity,
		ManageNicknames:           true,
		MessageDeduplication:      true,
		MessageRetryFloorMS:       retryFloorMS,
		MessageRetryWindowSeconds: int64(service.MessageRetryWindow.Seconds()),
		MultiRole:                 true,
		Polls:                     true,
		ProfileBanners:            true,
		ReadPointer:               true,
		Stickers:                  true,
		ThreadFollows:             threads,
		Threads:                   threads,
		UserNotes:                 true,
		VoiceMessages:             true,
	}
}
