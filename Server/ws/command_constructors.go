package ws

import (
	"encoding/json"
	"fmt"
	"strings"
)

// parseModTarget parses the (channel, target user) pair every voice moderation
// payload carries; channelField names the channel key in the error. Both must
// be positive: a non-positive id can only come from a malformed client, and
// rejecting at parse time keeps the handlers free of id-shape checks.
func parseModTarget(channelID, userID json.Number, channelField string) (int64, int64, error) {
	chID, err := positiveID(channelID, channelField)
	if err != nil {
		return 0, 0, err
	}
	targetID, err := positiveID(userID, "user_id")
	if err != nil {
		return 0, 0, err
	}
	return chID, targetID, nil
}

// parseCallChannelID parses the lone channel_id the call signalling, typing,
// focus, read and voice_join payloads carry. Shared so they cannot drift on
// what counts as a valid channel reference.
func parseCallChannelID(msgType string, raw json.RawMessage) (int64, error) {
	var p struct {
		ChannelID json.Number `json:"channel_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0, fmt.Errorf("invalid %s payload: %w", msgType, err)
	}
	return positiveID(p.ChannelID, "channel_id")
}

// commandConstructors maps message types to functions that parse payloads into typed
// Commands (userID and reqID come from the envelope and authenticated client; raw is
// the JSON payload body). Unexported to prevent mutation; use getCommandConstructor.
var commandConstructors = map[string]func(userID int64, reqID string, raw json.RawMessage) (Command, error){
	MsgTypePing: func(userID int64, _ string, _ json.RawMessage) (Command, error) { //nolint:unparam // error always nil; signature dictated by map type
		return PingCmd{userID: userID}, nil
	},

	MsgTypeChatSend: parseChatSend,

	MsgTypeChatForward: parseChatForward,
	MsgTypePollCreate:  parsePollCreate,
	MsgTypePollVote:    parsePollVote,
	MsgTypePollEnd:     parsePollEnd,

	MsgTypeThreadCreate:    parseThreadCreate,
	MsgTypeThreadUpdate:    parseThreadUpdate,
	MsgTypeThreadDelete:    parseThreadDelete,
	MsgTypeThreadFocus:     parseThreadFocus,
	MsgTypeThreadFollow:    parseThreadFollow,
	MsgTypeForumPostCreate: parseForumPostCreate,

	MsgTypeChatEdit: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Content   string      `json:"content"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_edit payload: %w", err)
		}
		msgID, err := positiveID(p.MessageID, "message_id")
		if err != nil {
			return nil, err
		}
		return ChatEditCmd{
			userID:    userID,
			ReqID:     reqID,
			MessageID: msgID,
			Content:   p.Content,
		}, nil
	},

	MsgTypeChatDelete: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_delete payload: %w", err)
		}
		msgID, err := positiveID(p.MessageID, "message_id")
		if err != nil {
			return nil, err
		}
		return ChatDeleteCmd{
			userID:    userID,
			ReqID:     reqID,
			MessageID: msgID,
		}, nil
	},

	MsgTypeTypingStart: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		chID, err := parseCallChannelID(MsgTypeTypingStart, raw)
		if err != nil {
			return nil, err
		}
		return TypingStartCmd{userID: userID, ChannelID: chID}, nil
	},

	MsgTypePresenceUpdate: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		return parsePresenceUpdate(userID, raw)
	},

	MsgTypeChannelFocus: parseChannelFocus,
	MsgTypeMarkRead:     parseMarkRead,
	MsgTypeMarkUnread:   parseMarkUnread,

	MsgTypeCallRing: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		chID, err := parseCallChannelID(MsgTypeCallRing, raw)
		if err != nil {
			return nil, err
		}
		return CallRingCmd{userID: userID, ChannelID: chID}, nil
	},

	MsgTypeCallDecline: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		chID, err := parseCallChannelID(MsgTypeCallDecline, raw)
		if err != nil {
			return nil, err
		}
		return CallDeclineCmd{userID: userID, ChannelID: chID}, nil
	},

	MsgTypeReactionAdd: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Emoji     string      `json:"emoji"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid reaction_add payload: %w", err)
		}
		msgID, err := positiveID(p.MessageID, "message_id")
		if err != nil {
			return nil, err
		}
		return ReactionAddCmd{userID: userID, MessageID: msgID, Emoji: p.Emoji}, nil
	},

	MsgTypeReactionRemove: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Emoji     string      `json:"emoji"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid reaction_remove payload: %w", err)
		}
		msgID, err := positiveID(p.MessageID, "message_id")
		if err != nil {
			return nil, err
		}
		return ReactionRemoveCmd{userID: userID, MessageID: msgID, Emoji: p.Emoji}, nil
	},

	MsgTypeVoiceJoin: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		chID, err := parseCallChannelID(MsgTypeVoiceJoin, raw)
		if err != nil {
			return nil, err
		}
		return VoiceJoinCmd{userID: userID, ChannelID: chID}, nil
	},

	MsgTypeVoiceLeave: func(userID int64, _ string, _ json.RawMessage) (Command, error) { //nolint:unparam // error always nil; signature dictated by map type
		return VoiceLeaveCmd{userID: userID}, nil
	},

	MsgTypeVoiceTokenRefresh: func(userID int64, _ string, _ json.RawMessage) (Command, error) { //nolint:unparam // error always nil; signature dictated by map type
		return VoiceTokenRefreshCmd{userID: userID}, nil
	},

	MsgTypeVoiceMute: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Muted bool `json:"muted"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_mute payload: %w", err)
		}
		return VoiceMuteCmd{userID: userID, Muted: p.Muted}, nil
	},

	MsgTypeVoiceDeafen: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Deafened bool `json:"deafened"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_deafen payload: %w", err)
		}
		return VoiceDeafenCmd{userID: userID, Deafened: p.Deafened}, nil
	},

	MsgTypeVoiceCamera: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_camera payload: %w", err)
		}
		return VoiceCameraCmd{userID: userID, Enabled: p.Enabled}, nil
	},

	MsgTypeVoiceScreenshare: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_screenshare payload: %w", err)
		}
		return VoiceScreenshareCmd{userID: userID, Enabled: p.Enabled}, nil
	},

	MsgTypeVoiceModMute: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID json.Number `json:"channel_id"`
			UserID    json.Number `json:"user_id"`
			Muted     bool        `json:"muted"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_mod_mute payload: %w", err)
		}
		chID, targetID, err := parseModTarget(p.ChannelID, p.UserID, "channel_id")
		if err != nil {
			return nil, err
		}
		return VoiceModMuteCmd{userID: userID, ChannelID: chID, TargetID: targetID, Muted: p.Muted}, nil
	},

	MsgTypeVoiceModDeafen: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID json.Number `json:"channel_id"`
			UserID    json.Number `json:"user_id"`
			Deafened  bool        `json:"deafened"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_mod_deafen payload: %w", err)
		}
		chID, targetID, err := parseModTarget(p.ChannelID, p.UserID, "channel_id")
		if err != nil {
			return nil, err
		}
		return VoiceModDeafenCmd{userID: userID, ChannelID: chID, TargetID: targetID, Deafened: p.Deafened}, nil
	},

	MsgTypeVoiceModMove: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			UserID      json.Number `json:"user_id"`
			ToChannelID json.Number `json:"to_channel_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_mod_move payload: %w", err)
		}
		toChID, targetID, err := parseModTarget(p.ToChannelID, p.UserID, "to_channel_id")
		if err != nil {
			return nil, err
		}
		return VoiceModMoveCmd{userID: userID, TargetID: targetID, ToChannelID: toChID}, nil
	},

	MsgTypeVoiceModKick: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			UserID json.Number `json:"user_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_mod_kick payload: %w", err)
		}
		targetID, err := positiveID(p.UserID, "user_id")
		if err != nil {
			return nil, err
		}
		return VoiceModKickCmd{userID: userID, TargetID: targetID}, nil
	},

	MsgTypeVoiceE2EEAnnounce: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			PublicKey   string          `json:"public_key"`
			Signature   string          `json:"signature"`
			IdentityKey json.RawMessage `json:"identity_public_key"`
			VideoDecode json.RawMessage `json:"video_decode"`
			KeySlots    json.RawMessage `json:"key_slots"`
			BoundOffers json.RawMessage `json:"bound_offers"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_e2ee_announce payload: %w", err)
		}
		// A wrongly typed list is dropped like an invalid one; it must never cost the key.
		var videoDecode []string
		if len(p.VideoDecode) > 0 && json.Unmarshal(p.VideoDecode, &videoDecode) != nil {
			videoDecode = nil
		}
		return VoiceE2EEAnnounceCmd{
			userID:      userID,
			PublicKey:   p.PublicKey,
			Signature:   p.Signature,
			IdentityKey: announceIdentityKey(userID, p.IdentityKey),
			VideoDecode: videoDecode,
			KeySlots:    string(p.KeySlots) == "true",
			BoundOffers: string(p.BoundOffers) == "true",
		}, nil
	},

	MsgTypeVoiceWatch: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			UserIDs []int64 `json:"user_ids"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_watch payload: %w", err)
		}
		return VoiceWatchCmd{userID: userID, UserIDs: p.UserIDs}, nil
	},

	MsgTypeChatCommand: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID int64    `json:"channel_id"`
			Command   string   `json:"command"`
			Args      []string `json:"args"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_command payload: %w", err)
		}
		cmd := strings.TrimSpace(p.Command)
		if cmd == "" {
			return nil, fmt.Errorf("command must not be empty")
		}
		// Guard against a client flooding the plugin allocate/dispatch ABI.
		if len(p.Args) > maxCommandArgs {
			return nil, fmt.Errorf("too many command arguments (max %d)", maxCommandArgs)
		}
		args := make([]string, len(p.Args))
		copy(args, p.Args)
		return ChatCommandCmd{
			userID:    userID,
			ReqID:     reqID,
			ChannelID: p.ChannelID,
			Command:   cmd,
			args:      args,
		}, nil
	},

	MsgTypeVoiceE2EEOffer: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			TargetUserID int64  `json:"target_user_id"`
			EncryptedKey string `json:"encrypted_key"`
			IV           string `json:"iv"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_e2ee_offer payload: %w", err)
		}
		return VoiceE2EEOfferCmd{
			userID:       userID,
			TargetUserID: p.TargetUserID,
			EncryptedKey: p.EncryptedKey,
			IV:           p.IV,
		}, nil
	},
}

// getCommandConstructor returns the constructor for a message type, if registered.
func getCommandConstructor(msgType string) (func(int64, string, json.RawMessage) (Command, error), bool) {
	ctor, ok := commandConstructors[msgType]
	return ctor, ok
}
