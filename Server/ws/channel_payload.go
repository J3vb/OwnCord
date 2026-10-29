package ws

import "github.com/J3vb/OwnCord/Server/db"

type channelPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	// CategoryID / CategoryPosition (WP 6.5a) identify the category object the
	// name above belongs to: 0 and 0 for an uncategorized channel. Always
	// sent, and identical for every recipient, so the shared channel_update
	// frame stays shared.
	CategoryID       int64  `json:"category_id"`
	CategoryPosition int    `json:"category_position"`
	Topic            string `json:"topic"`
	Position         int    `json:"position"`
	// SlowMode lets the client pre-disable the composer for the cooldown
	// instead of accepting a message the server will refuse with SLOW_MODE.
	// Seconds; 0 means off.
	SlowMode int `json:"slow_mode"`
	// NSFW marks the channel as possibly carrying sensitive content. It is
	// shipped so clients can gate or label it; the server applies no content
	// behaviour of its own to a flagged channel.
	NSFW bool `json:"nsfw"`
	// AFK marks the server's one AFK voice channel (migration 068). Always
	// sent, and identical for every recipient, so the shared channel_update
	// frame stays shared. Members in it can listen but not publish.
	AFK bool `json:"afk"`
	// Private is the channel-level lock flag (3D-6): the default role cannot
	// read the channel after its override is applied. Always sent, like NSFW,
	// and identical for every recipient — never per-viewer — so the shared
	// channel_update frame stays shared. See permissions.IsChannelPrivate.
	Private bool `json:"private"`
	// Voice capacity limits (0 = unlimited), the same values the voice-join
	// path enforces with CHANNEL_FULL / VIDEO_LIMIT. Sent so the sidebar can
	// show "3/5" and the client can explain a refusal it could have predicted.
	VoiceMaxUsers int `json:"voice_max_users"`
	VoiceMaxVideo int `json:"voice_max_video"`
	// CanSend is the per-recipient composer affordance, the same value the
	// ready payload ships per channel. It is per-client, so only the targeted
	// channel_create sends (BroadcastChannelCreate, RefreshChannelVisibility)
	// populate it — the shared-buffer channel_update broadcast leaves it nil,
	// since one encoded frame is delivered to every recipient and a single
	// value would be wrong for some of them.
	//
	// Pointer + omitempty so "not stated" stays distinguishable from "false":
	// a client must keep its existing verdict when the field is absent, and an
	// older server that never sends it keeps the permissive default.
	CanSend *bool `json:"can_send,omitempty"`
	// CanModerateVoice is the per-recipient voice-moderation affordance (B9
	// Q5), the same value the ready payload ships per channel. Same
	// per-recipient, targeted-only, absent-means-unchanged rules as CanSend.
	CanModerateVoice *bool `json:"can_moderate_voice,omitempty"`
	// CanMoveVoice is the per-recipient move affordance (WP 8.4b): the verdict
	// of permissions.AuthorizeVoiceMover, independent of CanModerateVoice. Same
	// per-recipient, targeted-only, absent-means-unchanged rules as CanSend.
	CanMoveVoice *bool `json:"can_move_voice,omitempty"`
	// CanDeleteOthers, CanPin and CanReact are the per-recipient message
	// affordances (3A-13), the same values the ready payload ships per
	// channel. Same per-recipient, targeted-only, absent-means-unchanged
	// rules as CanSend.
	CanDeleteOthers *bool `json:"can_delete_others,omitempty"`
	CanPin          *bool `json:"can_pin,omitempty"`
	CanReact        *bool `json:"can_react,omitempty"`
	// Forum carries a forum channel's settings and tags (WP 6.9d). Present on
	// a type 'forum' row only, and identical for every recipient, so the shared
	// channel_update frame stays shared. Whether the frame is sent to a socket
	// at all is client_features.go's concern, not this field's.
	Forum *db.ChannelForum `json:"forum,omitempty"`
}

// channelPayloadFrom narrows a channel row to the wire shape shared by the
// channel_create and channel_update broadcasts. One constructor so the two
// events can never disagree about which fields a client is told about.
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
		Private:          private,
		VoiceMaxUsers:    ch.VoiceMaxUsers,
		VoiceMaxVideo:    ch.VoiceMaxVideo,
		Forum:            ch.Forum,
	}
}
