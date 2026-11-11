package ws

import "github.com/J3vb/OwnCord/Server/db"

type channelPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	// CategoryID / CategoryPosition identify the category (0, 0 when
	// uncategorized). Identical for every recipient so the shared frame stays
	// shared.
	CategoryID       int64  `json:"category_id"`
	CategoryPosition int    `json:"category_position"`
	Topic            string `json:"topic"`
	Position         int    `json:"position"`
	// SlowMode is the cooldown in seconds (0 = off), so the client can pre-
	// disable the composer.
	SlowMode int `json:"slow_mode"`
	// NSFW is shipped so clients can gate or label the channel; the server
	// applies no behaviour to it.
	NSFW bool `json:"nsfw"`
	// AFK marks the one AFK voice channel; members can listen but not publish.
	// Identical for every recipient.
	AFK bool `json:"afk"`
	// JoinLocked is whether a voice channel has a password; not a per-viewer
	// flag, a client tries the join and reacts to PASSWORD_REQUIRED.
	JoinLocked bool `json:"password_protected"`
	// Private is the channel-level lock flag (see permissions.IsChannelPrivate);
	// identical for every recipient so the shared frame stays shared.
	Private bool `json:"private"`
	// Voice capacity limits (0 = unlimited), the same values the join path
	// enforces with CHANNEL_FULL / VIDEO_LIMIT.
	VoiceMaxUsers int `json:"voice_max_users"`
	VoiceMaxVideo int `json:"voice_max_video"`
	// CanSend is the per-recipient composer affordance. Only the targeted
	// channel_create sends populate it; the shared channel_update leaves it nil
	// because one encoded frame goes to every recipient.
	// Pointer + omitempty so "not stated" differs from "false": a client keeps
	// its existing verdict when the field is absent.
	CanSend *bool `json:"can_send,omitempty"`
	// CanModerateVoice is the per-recipient voice-moderation affordance; same
	// rules as CanSend.
	CanModerateVoice *bool `json:"can_moderate_voice,omitempty"`
	// CanMoveVoice is the verdict of permissions.AuthorizeVoiceMover, independent
	// of CanModerateVoice; same rules as CanSend.
	CanMoveVoice *bool `json:"can_move_voice,omitempty"`
	// CanDeleteOthers, CanPin and CanReact are per-recipient message affordances;
	// same rules as CanSend.
	CanDeleteOthers *bool `json:"can_delete_others,omitempty"`
	CanPin          *bool `json:"can_pin,omitempty"`
	CanReact        *bool `json:"can_react,omitempty"`
	// Forum carries a forum channel's settings and tags (type 'forum' only),
	// identical for every recipient. Whether a socket gets the frame is
	// client_features.go's concern.
	Forum *db.ChannelForum `json:"forum,omitempty"`
}

// channelPayloadFrom is the one constructor for the channel_create and
// channel_update wire shape, so the two events cannot disagree.
func channelPayloadFrom(ch *db.Channel, private bool) channelPayload {
	return channelPayload{
		ID:               ch.ID,
		Name:             ch.Name,
		Type:             ch.Type,
		Category:         ch.Category,
		CategoryID:       ch.CategoryID,
		CategoryPosition: ch.CategoryPosition,
		Topic:            ch.Topic,
		Position:         ch.Position,
		SlowMode:         ch.SlowMode,
		NSFW:             ch.NSFW,
		AFK:              ch.AFK,
		JoinLocked:       ch.JoinLocked,
		Private:          private,
		VoiceMaxUsers:    ch.VoiceMaxUsers,
		VoiceMaxVideo:    ch.VoiceMaxVideo,
		Forum:            ch.Forum,
	}
}
