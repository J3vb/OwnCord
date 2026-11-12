package ws

import (
	"slices"
)

// Command is the minimal interface for all client-to-server commands.
type Command interface {
	Type() string
	UserID() int64
}

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
	ReplyPing       bool
	attachments     []string
	StickerID       int64
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
	// CustomStatus is nil when the payload carried no custom_status, meaning
	// "leave the stored text alone"; a present-but-empty string clears it. The
	// auto-idle timer sends bare status flips and must not wipe the user's text.
	CustomStatus *string
	ExpiresIn    *int64
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

// VoiceModMuteCmd is a moderator setting another user's server mute. channelID is
// the channel the moderator believes the target is in; the handler refuses on a
// mismatch, so a stale sidebar cannot mute someone who has moved.
type VoiceModMuteCmd struct {
	userID    int64
	ChannelID int64
	TargetID  int64
	Muted     bool
}

func (c VoiceModMuteCmd) Type() string  { return MsgTypeVoiceModMute }
func (c VoiceModMuteCmd) UserID() int64 { return c.userID }

// VoiceModDeafenCmd represents a voice_mod_deafen message.
type VoiceModDeafenCmd struct {
	userID    int64
	ChannelID int64
	TargetID  int64
	Deafened  bool
}

func (c VoiceModDeafenCmd) Type() string  { return MsgTypeVoiceModDeafen }
func (c VoiceModDeafenCmd) UserID() int64 { return c.userID }

// VoiceModMoveCmd represents a voice_mod_move message: a moderator moving a user to another voice
// channel.
type VoiceModMoveCmd struct {
	userID      int64
	TargetID    int64
	ToChannelID int64
}

func (c VoiceModMoveCmd) Type() string  { return MsgTypeVoiceModMove }
func (c VoiceModMoveCmd) UserID() int64 { return c.userID }

// VoiceModKickCmd represents a voice_mod_kick message: a moderator disconnecting a user from voice.
type VoiceModKickCmd struct {
	userID   int64
	TargetID int64
}

func (c VoiceModKickCmd) Type() string  { return MsgTypeVoiceModKick }
func (c VoiceModKickCmd) UserID() int64 { return c.userID }

// VoiceE2EEAnnounceCmd is a voice_e2ee_announce message. Its signature is the ECDSA identity-key
// signature over the ephemeral public key; optional at the protocol level (legacy clients omit it and
// the receiving client enforces fail-closed).
type VoiceE2EEAnnounceCmd struct {
	userID    int64
	PublicKey string
	Signature string
	// IdentityKey is the announcing device's identity public key, validated and
	// trimmed by the parser; "" when absent or invalid (the connection's auth key
	// is used then).
	IdentityKey string
	// VideoDecode is the raw video_decode list, unvalidated until
	// sanitizeVideoDecode.
	VideoDecode []string
	KeySlots    bool
	BoundOffers bool
}

func (c VoiceE2EEAnnounceCmd) Type() string  { return MsgTypeVoiceE2EEAnnounce }
func (c VoiceE2EEAnnounceCmd) UserID() int64 { return c.userID }

// VoiceWatchCmd is the whole set of users whose screen share the sender watches;
// unvalidated, handleVoiceWatchV2 bounds, filters, dedupes and sorts it.
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

// CallRingCmd starts ringing the other people in a DM. It carries only the
// channel: the caller is the authenticated sender and there is no call record
// (see registerCallHandlers).
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
