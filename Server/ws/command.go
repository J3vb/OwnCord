package ws

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Command is the minimal interface for all client-to-server commands.
type Command interface {
	// Type returns the message type constant (e.g. MsgTypeChatSend).
	Type() string
	// UserID returns the authenticated user who sent this command.
	UserID() int64
}

// ── Concrete command structs ────────────────────────────────────────────────

// PingCmd represents a client ping (heartbeat).
type PingCmd struct {
	userID int64
}

func (c PingCmd) Type() string  { return MsgTypePing }
func (c PingCmd) UserID() int64 { return c.userID }

// ChatSendCmd represents a chat_send message.
type ChatSendCmd struct {
	ClientMessageID string
	userID          int64
	ReqID           string
	ChannelID       int64
	Content         string
	ReplyTo         *int64
	// ReplyPing is true only when the client sent reply_ping=true on a reply.
	ReplyPing   bool
	attachments []string
	// StickerID is the sticker a sticker message carries, 0 for an
	// ordinary send.
	StickerID int64
}

func (c ChatSendCmd) Type() string          { return MsgTypeChatSend }
func (c ChatSendCmd) UserID() int64         { return c.userID }
func (c ChatSendCmd) Attachments() []string { return slices.Clone(c.attachments) }

// ChatEditCmd represents a chat_edit message.
type ChatEditCmd struct {
	userID    int64
	ReqID     string
	MessageID int64
	Content   string
}

func (c ChatEditCmd) Type() string  { return MsgTypeChatEdit }
func (c ChatEditCmd) UserID() int64 { return c.userID }

// ChatDeleteCmd represents a chat_delete message.
type ChatDeleteCmd struct {
	userID    int64
	ReqID     string
	MessageID int64
}

func (c ChatDeleteCmd) Type() string  { return MsgTypeChatDelete }
func (c ChatDeleteCmd) UserID() int64 { return c.userID }

// TypingStartCmd represents a typing_start message.
type TypingStartCmd struct {
	userID    int64
	ChannelID int64
}

func (c TypingStartCmd) Type() string  { return MsgTypeTypingStart }
func (c TypingStartCmd) UserID() int64 { return c.userID }

// PresenceUpdateCmd represents a presence_update message.
type PresenceUpdateCmd struct {
	userID int64
	Status string
	// CustomStatus is nil when the payload carried no custom_status field at
	// all, which means "leave the stored text alone". A present-but-empty
	// string clears it. The distinction matters because the auto-idle timer
	// sends a bare status flip several times an hour and must not wipe the
	// text the user typed.
	CustomStatus *string
	// ExpiresIn is custom_status_expires_in (seconds), nil when absent.
	ExpiresIn *int64
}

func (c PresenceUpdateCmd) Type() string  { return MsgTypePresenceUpdate }
func (c PresenceUpdateCmd) UserID() int64 { return c.userID }

// ReactionAddCmd represents a reaction_add message.
type ReactionAddCmd struct {
	userID    int64
	MessageID int64
	Emoji     string
}

func (c ReactionAddCmd) Type() string  { return MsgTypeReactionAdd }
func (c ReactionAddCmd) UserID() int64 { return c.userID }

// ReactionRemoveCmd represents a reaction_remove message.
type ReactionRemoveCmd struct {
	userID    int64
	MessageID int64
	Emoji     string
}

func (c ReactionRemoveCmd) Type() string  { return MsgTypeReactionRemove }
func (c ReactionRemoveCmd) UserID() int64 { return c.userID }

// VoiceJoinCmd represents a voice_join message.
type VoiceJoinCmd struct {
	userID    int64
	ChannelID int64
}

func (c VoiceJoinCmd) Type() string  { return MsgTypeVoiceJoin }
func (c VoiceJoinCmd) UserID() int64 { return c.userID }

// VoiceLeaveCmd represents a voice_leave message.
type VoiceLeaveCmd struct {
	userID int64
}

func (c VoiceLeaveCmd) Type() string  { return MsgTypeVoiceLeave }
func (c VoiceLeaveCmd) UserID() int64 { return c.userID }

// VoiceTokenRefreshCmd represents a voice_token_refresh message.
type VoiceTokenRefreshCmd struct {
	userID int64
}

func (c VoiceTokenRefreshCmd) Type() string  { return MsgTypeVoiceTokenRefresh }
func (c VoiceTokenRefreshCmd) UserID() int64 { return c.userID }

// VoiceMuteCmd represents a voice_mute message.
type VoiceMuteCmd struct {
	userID int64
	Muted  bool
}

func (c VoiceMuteCmd) Type() string  { return MsgTypeVoiceMute }
func (c VoiceMuteCmd) UserID() int64 { return c.userID }

// VoiceDeafenCmd represents a voice_deafen message.
type VoiceDeafenCmd struct {
	userID   int64
	Deafened bool
}

func (c VoiceDeafenCmd) Type() string  { return MsgTypeVoiceDeafen }
func (c VoiceDeafenCmd) UserID() int64 { return c.userID }

// VoiceCameraCmd represents a voice_camera message.
type VoiceCameraCmd struct {
	userID  int64
	Enabled bool
}

func (c VoiceCameraCmd) Type() string  { return MsgTypeVoiceCamera }
func (c VoiceCameraCmd) UserID() int64 { return c.userID }

// VoiceScreenshareCmd represents a voice_screenshare message.
type VoiceScreenshareCmd struct {
	userID  int64
	Enabled bool
}

func (c VoiceScreenshareCmd) Type() string  { return MsgTypeVoiceScreenshare }
func (c VoiceScreenshareCmd) UserID() int64 { return c.userID }

// VoiceModMuteCmd represents a voice_mod_mute message: a moderator setting
// another user's server mute. channelID is the voice channel the moderator
// believes the target is in — the handler refuses when it disagrees, so a
// stale sidebar cannot mute someone who has since moved.
type VoiceModMuteCmd struct {
	userID    int64
	ChannelID int64
	TargetID  int64
	Muted     bool
}

func (c VoiceModMuteCmd) Type() string  { return MsgTypeVoiceModMute }
func (c VoiceModMuteCmd) UserID() int64 { return c.userID }

// VoiceModDeafenCmd represents a voice_mod_deafen message. See VoiceModMuteCmd
// for the channelID contract.
type VoiceModDeafenCmd struct {
	userID    int64
	ChannelID int64
	TargetID  int64
	Deafened  bool
}

func (c VoiceModDeafenCmd) Type() string  { return MsgTypeVoiceModDeafen }
func (c VoiceModDeafenCmd) UserID() int64 { return c.userID }

// VoiceModMoveCmd represents a voice_mod_move message: a moderator moving a
// user to another voice channel.
type VoiceModMoveCmd struct {
	userID      int64
	TargetID    int64
	ToChannelID int64
}

func (c VoiceModMoveCmd) Type() string  { return MsgTypeVoiceModMove }
func (c VoiceModMoveCmd) UserID() int64 { return c.userID }

// VoiceModKickCmd represents a voice_mod_kick message: a moderator
// disconnecting a user from voice.
type VoiceModKickCmd struct {
	userID   int64
	TargetID int64
}

func (c VoiceModKickCmd) Type() string  { return MsgTypeVoiceModKick }
func (c VoiceModKickCmd) UserID() int64 { return c.userID }

// VoiceE2EEAnnounceCmd represents a voice_e2ee_announce message.
// signature is the ECDSA identity-key signature over the ephemeral public key
// (F3 TOFU); optional at the protocol level — legacy clients omit it and the
// receiving client enforces the fail-closed posture.
type VoiceE2EEAnnounceCmd struct {
	userID    int64
	PublicKey string
	Signature string
	// IdentityKey is the announcing device's identity public key from the
	// announce payload, already validated and trimmed by the parser; "" when the
	// client sent none or an invalid one (the connection's auth key is used then).
	IdentityKey string
	// VideoDecode is the sender's raw video_decode list. Unvalidated
	// here; handleVoiceE2EEAnnounceV2 runs it through sanitizeVideoDecode.
	VideoDecode []string
}

func (c VoiceE2EEAnnounceCmd) Type() string  { return MsgTypeVoiceE2EEAnnounce }
func (c VoiceE2EEAnnounceCmd) UserID() int64 { return c.userID }

// VoiceWatchCmd represents a voice_watch message: the whole set of users whose
// screen share the sender watches now. Unvalidated here; handleVoiceWatchV2
// bounds, filters, dedupes and sorts it.
type VoiceWatchCmd struct {
	userID  int64
	UserIDs []int64
}

func (c VoiceWatchCmd) Type() string  { return MsgTypeVoiceWatch }
func (c VoiceWatchCmd) UserID() int64 { return c.userID }

// ChatCommandCmd represents a chat_command (plugin slash command) message.
type ChatCommandCmd struct {
	userID    int64
	ReqID     string
	ChannelID int64
	Command   string // trimmed, including leading slash, e.g. "/hello"
	args      []string
}

func (c ChatCommandCmd) Type() string   { return MsgTypeChatCommand }
func (c ChatCommandCmd) UserID() int64  { return c.userID }
func (c ChatCommandCmd) Args() []string { return slices.Clone(c.args) }

// VoiceE2EEOfferCmd represents a voice_e2ee_offer message.
type VoiceE2EEOfferCmd struct {
	userID       int64
	TargetUserID int64
	EncryptedKey string
	IV           string
}

func (c VoiceE2EEOfferCmd) Type() string  { return MsgTypeVoiceE2EEOffer }
func (c VoiceE2EEOfferCmd) UserID() int64 { return c.userID }

// CallRingCmd represents a call_ring message: "start ringing the other people
// in this DM". It carries only the channel — who is calling is the
// authenticated sender, and there is no call id because there is no call
// record (see registerCallHandlers).
type CallRingCmd struct {
	userID    int64
	ChannelID int64
}

func (c CallRingCmd) Type() string  { return MsgTypeCallRing }
func (c CallRingCmd) UserID() int64 { return c.userID }

// CallDeclineCmd represents a call_decline message.
type CallDeclineCmd struct {
	userID    int64
	ChannelID int64
}

func (c CallDeclineCmd) Type() string  { return MsgTypeCallDecline }
func (c CallDeclineCmd) UserID() int64 { return c.userID }

// ── Command constructors ────────────────────────────────────────────────────

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

// commandConstructors maps message types to functions that parse payloads
// into typed Commands. The userID and reqID come from the envelope and
// authenticated client; raw is the JSON payload body.
// Unexported to prevent accidental mutation; use getCommandConstructor for lookups.
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
