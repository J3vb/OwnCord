package ws

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Command is the minimal interface for all client-to-server commands.
type Command interface {
	// Type returns the message type constant (e.g. MsgTypeChatSend).
	Type() string
	// UserID returns the authenticated user who sent this command.
	UserID() int64
}

// ChannelScoped is an optional interface for commands targeting a channel.
type ChannelScoped interface {
	ChannelID() int64
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
	userID      int64
	reqID       string
	channelID   int64
	content     string
	replyTo     *int64
	attachments []string
}

func (c ChatSendCmd) Type() string     { return MsgTypeChatSend }
func (c ChatSendCmd) UserID() int64    { return c.userID }
func (c ChatSendCmd) ChannelID() int64 { return c.channelID }
func (c ChatSendCmd) ReqID() string    { return c.reqID }
func (c ChatSendCmd) Content() string  { return c.content }
func (c ChatSendCmd) ReplyTo() *int64  { return c.replyTo }
func (c ChatSendCmd) Attachments() []string {
	dst := make([]string, len(c.attachments))
	copy(dst, c.attachments)
	return dst
}

// ChatEditCmd represents a chat_edit message.
type ChatEditCmd struct {
	userID    int64
	reqID     string
	messageID int64
	content   string
}

func (c ChatEditCmd) Type() string     { return MsgTypeChatEdit }
func (c ChatEditCmd) UserID() int64    { return c.userID }
func (c ChatEditCmd) ReqID() string    { return c.reqID }
func (c ChatEditCmd) MessageID() int64 { return c.messageID }
func (c ChatEditCmd) Content() string  { return c.content }

// ChatDeleteCmd represents a chat_delete message.
type ChatDeleteCmd struct {
	userID    int64
	reqID     string
	messageID int64
}

func (c ChatDeleteCmd) Type() string     { return MsgTypeChatDelete }
func (c ChatDeleteCmd) UserID() int64    { return c.userID }
func (c ChatDeleteCmd) ReqID() string    { return c.reqID }
func (c ChatDeleteCmd) MessageID() int64 { return c.messageID }

// TypingStartCmd represents a typing_start message.
type TypingStartCmd struct {
	userID    int64
	channelID int64
}

func (c TypingStartCmd) Type() string     { return MsgTypeTypingStart }
func (c TypingStartCmd) UserID() int64    { return c.userID }
func (c TypingStartCmd) ChannelID() int64 { return c.channelID }

// PresenceUpdateCmd represents a presence_update message.
type PresenceUpdateCmd struct {
	userID int64
	status string
}

func (c PresenceUpdateCmd) Type() string   { return MsgTypePresenceUpdate }
func (c PresenceUpdateCmd) UserID() int64  { return c.userID }
func (c PresenceUpdateCmd) Status() string { return c.status }

// ChannelFocusCmd represents a channel_focus message.
type ChannelFocusCmd struct {
	userID    int64
	channelID int64
}

func (c ChannelFocusCmd) Type() string     { return MsgTypeChannelFocus }
func (c ChannelFocusCmd) UserID() int64    { return c.userID }
func (c ChannelFocusCmd) ChannelID() int64 { return c.channelID }

// ReactionAddCmd represents a reaction_add message.
type ReactionAddCmd struct {
	userID    int64
	messageID int64
	emoji     string
}

func (c ReactionAddCmd) Type() string     { return MsgTypeReactionAdd }
func (c ReactionAddCmd) UserID() int64    { return c.userID }
func (c ReactionAddCmd) MessageID() int64 { return c.messageID }
func (c ReactionAddCmd) Emoji() string    { return c.emoji }

// ReactionRemoveCmd represents a reaction_remove message.
type ReactionRemoveCmd struct {
	userID    int64
	messageID int64
	emoji     string
}

func (c ReactionRemoveCmd) Type() string     { return MsgTypeReactionRemove }
func (c ReactionRemoveCmd) UserID() int64    { return c.userID }
func (c ReactionRemoveCmd) MessageID() int64 { return c.messageID }
func (c ReactionRemoveCmd) Emoji() string    { return c.emoji }

// VoiceJoinCmd represents a voice_join message.
type VoiceJoinCmd struct {
	userID    int64
	channelID int64
}

func (c VoiceJoinCmd) Type() string     { return MsgTypeVoiceJoin }
func (c VoiceJoinCmd) UserID() int64    { return c.userID }
func (c VoiceJoinCmd) ChannelID() int64 { return c.channelID }

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
	muted  bool
}

func (c VoiceMuteCmd) Type() string  { return MsgTypeVoiceMute }
func (c VoiceMuteCmd) UserID() int64 { return c.userID }
func (c VoiceMuteCmd) Muted() bool   { return c.muted }

// VoiceDeafenCmd represents a voice_deafen message.
type VoiceDeafenCmd struct {
	userID   int64
	deafened bool
}

func (c VoiceDeafenCmd) Type() string   { return MsgTypeVoiceDeafen }
func (c VoiceDeafenCmd) UserID() int64  { return c.userID }
func (c VoiceDeafenCmd) Deafened() bool { return c.deafened }

// VoiceCameraCmd represents a voice_camera message.
type VoiceCameraCmd struct {
	userID  int64
	enabled bool
}

func (c VoiceCameraCmd) Type() string  { return MsgTypeVoiceCamera }
func (c VoiceCameraCmd) UserID() int64 { return c.userID }
func (c VoiceCameraCmd) Enabled() bool { return c.enabled }

// VoiceScreenshareCmd represents a voice_screenshare message.
type VoiceScreenshareCmd struct {
	userID  int64
	enabled bool
}

func (c VoiceScreenshareCmd) Type() string  { return MsgTypeVoiceScreenshare }
func (c VoiceScreenshareCmd) UserID() int64 { return c.userID }
func (c VoiceScreenshareCmd) Enabled() bool { return c.enabled }

// VoiceE2EEAnnounceCmd represents a voice_e2ee_announce message.
// signature is the ECDSA identity-key signature over the ephemeral public key
// (F3 TOFU); optional at the protocol level — legacy clients omit it and the
// receiving client enforces the fail-closed posture.
type VoiceE2EEAnnounceCmd struct {
	userID    int64
	publicKey string
	signature string
}

func (c VoiceE2EEAnnounceCmd) Type() string      { return MsgTypeVoiceE2EEAnnounce }
func (c VoiceE2EEAnnounceCmd) UserID() int64     { return c.userID }
func (c VoiceE2EEAnnounceCmd) PublicKey() string { return c.publicKey }
func (c VoiceE2EEAnnounceCmd) Signature() string { return c.signature }

// ChatCommandCmd represents a chat_command (plugin slash command) message.
type ChatCommandCmd struct {
	userID    int64
	reqID     string
	channelID int64
	command   string // trimmed, including leading slash, e.g. "/hello"
	args      []string
}

func (c ChatCommandCmd) Type() string     { return MsgTypeChatCommand }
func (c ChatCommandCmd) UserID() int64    { return c.userID }
func (c ChatCommandCmd) ChannelID() int64 { return c.channelID }
func (c ChatCommandCmd) ReqID() string    { return c.reqID }
func (c ChatCommandCmd) Command() string  { return c.command }
func (c ChatCommandCmd) Args() []string {
	dst := make([]string, len(c.args))
	copy(dst, c.args)
	return dst
}

// VoiceE2EEOfferCmd represents a voice_e2ee_offer message.
type VoiceE2EEOfferCmd struct {
	userID       int64
	targetUserID int64
	encryptedKey string
	iv           string
}

func (c VoiceE2EEOfferCmd) Type() string         { return MsgTypeVoiceE2EEOffer }
func (c VoiceE2EEOfferCmd) UserID() int64        { return c.userID }
func (c VoiceE2EEOfferCmd) TargetUserID() int64  { return c.targetUserID }
func (c VoiceE2EEOfferCmd) EncryptedKey() string { return c.encryptedKey }
func (c VoiceE2EEOfferCmd) IV() string           { return c.iv }

// ── Command constructors ────────────────────────────────────────────────────

// commandConstructors maps message types to functions that parse payloads
// into typed Commands. The userID and reqID come from the envelope and
// authenticated client; raw is the JSON payload body.
// Unexported to prevent accidental mutation; use getCommandConstructor for lookups.
var commandConstructors = map[string]func(userID int64, reqID string, raw json.RawMessage) (Command, error){
	MsgTypePing: func(userID int64, _ string, _ json.RawMessage) (Command, error) { //nolint:unparam // error always nil; signature dictated by map type
		return PingCmd{userID: userID}, nil
	},

	MsgTypeChatSend: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID   json.Number `json:"channel_id"`
			Content     string      `json:"content"`
			ReplyTo     *int64      `json:"reply_to"`
			Attachments []string    `json:"attachments"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_send payload: %w", err)
		}
		chID, err := p.ChannelID.Int64()
		if err != nil {
			return nil, fmt.Errorf("channel_id must be integer: %w", err)
		}
		if len(p.Attachments) > 10 {
			return nil, fmt.Errorf("too many attachments (max 10)")
		}
		// TODO: validate attachment URL scheme (require https://) to prevent
		// javascript:, data:, or file: URLs from being stored and relayed.
		for i, url := range p.Attachments {
			if len(url) > 2048 {
				return nil, fmt.Errorf("attachment[%d] URL too long (max 2048)", i)
			}
		}
		attachments := make([]string, len(p.Attachments))
		copy(attachments, p.Attachments)
		return ChatSendCmd{
			userID:      userID,
			reqID:       reqID,
			channelID:   chID,
			content:     p.Content,
			replyTo:     p.ReplyTo,
			attachments: attachments,
		}, nil
	},

	MsgTypeChatEdit: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Content   string      `json:"content"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_edit payload: %w", err)
		}
		msgID, err := p.MessageID.Int64()
		if err != nil {
			return nil, fmt.Errorf("message_id must be integer: %w", err)
		}
		return ChatEditCmd{
			userID:    userID,
			reqID:     reqID,
			messageID: msgID,
			content:   p.Content,
		}, nil
	},

	MsgTypeChatDelete: func(userID int64, reqID string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid chat_delete payload: %w", err)
		}
		msgID, err := p.MessageID.Int64()
		if err != nil {
			return nil, fmt.Errorf("message_id must be integer: %w", err)
		}
		return ChatDeleteCmd{
			userID:    userID,
			reqID:     reqID,
			messageID: msgID,
		}, nil
	},

	MsgTypeTypingStart: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID json.Number `json:"channel_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid typing_start payload: %w", err)
		}
		chID, err := p.ChannelID.Int64()
		if err != nil {
			return nil, fmt.Errorf("channel_id must be integer: %w", err)
		}
		if chID <= 0 {
			return nil, fmt.Errorf("channel_id must be positive")
		}
		return TypingStartCmd{userID: userID, channelID: chID}, nil
	},

	MsgTypePresenceUpdate: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid presence_update payload: %w", err)
		}
		return PresenceUpdateCmd{userID: userID, status: p.Status}, nil
	},

	MsgTypeChannelFocus: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID json.Number `json:"channel_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid channel_focus payload: %w", err)
		}
		chID, err := p.ChannelID.Int64()
		if err != nil {
			return nil, fmt.Errorf("channel_id must be integer: %w", err)
		}
		if chID <= 0 {
			return nil, fmt.Errorf("channel_id must be positive")
		}
		return ChannelFocusCmd{userID: userID, channelID: chID}, nil
	},

	MsgTypeReactionAdd: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Emoji     string      `json:"emoji"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid reaction_add payload: %w", err)
		}
		msgID, err := p.MessageID.Int64()
		if err != nil {
			return nil, fmt.Errorf("message_id must be integer: %w", err)
		}
		return ReactionAddCmd{userID: userID, messageID: msgID, emoji: p.Emoji}, nil
	},

	MsgTypeReactionRemove: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			MessageID json.Number `json:"message_id"`
			Emoji     string      `json:"emoji"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid reaction_remove payload: %w", err)
		}
		msgID, err := p.MessageID.Int64()
		if err != nil {
			return nil, fmt.Errorf("message_id must be integer: %w", err)
		}
		return ReactionRemoveCmd{userID: userID, messageID: msgID, emoji: p.Emoji}, nil
	},

	MsgTypeVoiceJoin: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			ChannelID json.Number `json:"channel_id"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_join payload: %w", err)
		}
		chID, err := p.ChannelID.Int64()
		if err != nil {
			return nil, fmt.Errorf("channel_id must be integer: %w", err)
		}
		if chID <= 0 {
			return nil, fmt.Errorf("channel_id must be positive")
		}
		return VoiceJoinCmd{userID: userID, channelID: chID}, nil
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
		return VoiceMuteCmd{userID: userID, muted: p.Muted}, nil
	},

	MsgTypeVoiceDeafen: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Deafened bool `json:"deafened"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_deafen payload: %w", err)
		}
		return VoiceDeafenCmd{userID: userID, deafened: p.Deafened}, nil
	},

	MsgTypeVoiceCamera: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_camera payload: %w", err)
		}
		return VoiceCameraCmd{userID: userID, enabled: p.Enabled}, nil
	},

	MsgTypeVoiceScreenshare: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_screenshare payload: %w", err)
		}
		return VoiceScreenshareCmd{userID: userID, enabled: p.Enabled}, nil
	},

	MsgTypeVoiceE2EEAnnounce: func(userID int64, _ string, raw json.RawMessage) (Command, error) {
		var p struct {
			PublicKey string `json:"public_key"`
			Signature string `json:"signature"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("invalid voice_e2ee_announce payload: %w", err)
		}
		return VoiceE2EEAnnounceCmd{userID: userID, publicKey: p.PublicKey, signature: p.Signature}, nil
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
			reqID:     reqID,
			channelID: p.ChannelID,
			command:   cmd,
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
			targetUserID: p.TargetUserID,
			encryptedKey: p.EncryptedKey,
			iv:           p.IV,
		}, nil
	},
}

// getCommandConstructor returns the constructor for a message type, if registered.
func getCommandConstructor(msgType string) (func(int64, string, json.RawMessage) (Command, error), bool) {
	ctor, ok := commandConstructors[msgType]
	return ctor, ok
}
