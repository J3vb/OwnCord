package ws

// ClientError represents an error to send back to the requesting client.
// It implements the error interface so it can be used as Result.Error.
type ClientError struct {
	Code    string
	Message string
}

func (e ClientError) Error() string { return e.Code + ": " + e.Message }

// Result is returned by V2 handlers. It describes the outcome of processing
// a Command: zero or more Events to emit, an optional error, and an optional
// Reply (ACK) to send back to the sender.
type Result struct {
	// Events to route to other clients via EmitEvents.
	Events []Event
	// Error, if non-nil, is sent to the client. Use ClientError for
	// user-facing errors; other error types are treated as internal.
	Error error
	// Reply is an optional raw JSON ACK sent only to the sender
	// (e.g. chat_send_ok with the new message ID).
	Reply []byte
	// SetChannelID, if non-nil, updates the client's focused channel.
	// Used by channel_focus to mutate client state from a V2 handler.
	SetChannelID *int64
	// SetE2EEPubKey, if non-nil, stores the ECDH public key on the client.
	// Used by voice_e2ee_announce to persist the key for later retrieval.
	SetE2EEPubKey *string
	// SetVoiceJoinToken, if non-nil, caches the voice join token on the client.
	// Used by voice_token_refresh when falling back to the DB for the token.
	SetVoiceJoinToken *string
	// JoinVoice, if true, triggers the hub's voice-join routine after the handler
	// returns. voice_join's effect is a large, hub-coupled sequence (DB
	// persistence, LiveKit token, existing-state fan-out, key-holder election,
	// topic subscription) that also invokes the leave routine on a channel
	// switch, so the applier runs handleVoiceJoin (re-parsing the envelope
	// payload it already validated) rather than re-expressing it as pure events.
	JoinVoice bool
	// LeaveVoice, if true, triggers the hub's voice-leave routine after the
	// handler returns. handleVoiceLeave stays hub-internal because disconnect and
	// channel-switch cleanup call it un-throttled; only the message dispatch
	// moved to V2 (which does the rate-limit before setting this flag).
	LeaveVoice bool
}

// Event is the base interface for all server-to-client events.
type Event interface {
	// EventType returns the outbound message type constant (e.g. MsgTypeChatMessage).
	EventType() string
}

// ── Routing interfaces ──────────────────────────────────────────────────────
// EmitEvents will type-switch on these interfaces to decide how to deliver
// each Event. The check order matters: SequencedDMEvent MUST be checked
// before ChannelEvent because DM events implement both.

// ChannelEvent routes to Hub.BroadcastToChannel (sequenced, replayable).
type ChannelEvent interface {
	Event
	ChannelID() int64
	Payload() []byte
}

// ExcludeSenderEvent routes to Hub.broadcastExclude (ephemeral, not replayed).
// Used for typing indicators in non-DM channels.
type ExcludeSenderEvent interface {
	Event
	ChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// SequencedDMEvent routes to Hub.sendSequencedToUsers (sequenced, replayable).
// Used for chat messages, edits, deletes, and reactions in DM channels.
type SequencedDMEvent interface {
	Event
	ChannelID() int64
	ParticipantIDs() []int64
	Payload() []byte
}

// UserTargetedEvent routes to Hub.SendToUser (direct delivery to one user).
type UserTargetedEvent interface {
	Event
	TargetUserID() int64
	Payload() []byte
}

// BroadcastAllEvent routes to Hub.BroadcastToAll (channelID=0, all clients).
type BroadcastAllEvent interface {
	Event
	Payload() []byte
}

// VoiceChannelEvent routes to Hub.sendToVoiceChannelExcept (ephemeral,
// targets voice channel participants excluding sender).
type VoiceChannelEvent interface {
	Event
	VoiceChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// VoiceChannelGuardedEvent routes to Hub.sendToUserIfInVoiceChannel —
// atomic check-and-send that verifies the target is still in the expected
// voice channel before delivering the message, all under a single h.mu.RLock.
// Used by voice_e2ee_offer to prevent TOCTOU races with concurrent voice_leave.
type VoiceChannelGuardedEvent interface {
	Event
	VoiceChannelID() int64
	TargetUserID() int64
	Payload() []byte
}

// ── Concrete event structs ──────────────────────────────────────────────────

// MessageSentChannelEvent is a chat message broadcast to a non-DM channel.
type MessageSentChannelEvent struct {
	channelID int64
	payload   []byte
}

func (e MessageSentChannelEvent) EventType() string { return MsgTypeChatMessage }
func (e MessageSentChannelEvent) ChannelID() int64  { return e.channelID }
func (e MessageSentChannelEvent) Payload() []byte   { return e.payload }

// MessageSentDMEvent is a chat message broadcast to a DM channel's participants.
type MessageSentDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e MessageSentDMEvent) EventType() string { return MsgTypeChatMessage }
func (e MessageSentDMEvent) ChannelID() int64  { return e.channelID }
func (e MessageSentDMEvent) ParticipantIDs() []int64 {
	dst := make([]int64, len(e.participantIDs))
	copy(dst, e.participantIDs)
	return dst
}
func (e MessageSentDMEvent) Payload() []byte { return e.payload }

// MessageEditedChannelEvent is a chat_edited broadcast to a non-DM channel.
type MessageEditedChannelEvent struct {
	channelID int64
	payload   []byte
}

func (e MessageEditedChannelEvent) EventType() string { return MsgTypeChatEdited }
func (e MessageEditedChannelEvent) ChannelID() int64  { return e.channelID }
func (e MessageEditedChannelEvent) Payload() []byte   { return e.payload }

// MessageEditedDMEvent is a chat_edited broadcast to DM participants.
type MessageEditedDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e MessageEditedDMEvent) EventType() string { return MsgTypeChatEdited }
func (e MessageEditedDMEvent) ChannelID() int64  { return e.channelID }
func (e MessageEditedDMEvent) ParticipantIDs() []int64 {
	dst := make([]int64, len(e.participantIDs))
	copy(dst, e.participantIDs)
	return dst
}
func (e MessageEditedDMEvent) Payload() []byte { return e.payload }

// MessageDeletedChannelEvent is a chat_deleted broadcast to a non-DM channel.
type MessageDeletedChannelEvent struct {
	channelID int64
	payload   []byte
}

func (e MessageDeletedChannelEvent) EventType() string { return MsgTypeChatDeleted }
func (e MessageDeletedChannelEvent) ChannelID() int64  { return e.channelID }
func (e MessageDeletedChannelEvent) Payload() []byte   { return e.payload }

// MessageDeletedDMEvent is a chat_deleted broadcast to DM participants.
type MessageDeletedDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e MessageDeletedDMEvent) EventType() string { return MsgTypeChatDeleted }
func (e MessageDeletedDMEvent) ChannelID() int64  { return e.channelID }
func (e MessageDeletedDMEvent) ParticipantIDs() []int64 {
	dst := make([]int64, len(e.participantIDs))
	copy(dst, e.participantIDs)
	return dst
}
func (e MessageDeletedDMEvent) Payload() []byte { return e.payload }

// TypingChannelEvent is a typing indicator broadcast to a channel, excluding sender.
type TypingChannelEvent struct {
	channelID     int64
	excludeUserID int64
	payload       []byte
}

func (e TypingChannelEvent) EventType() string    { return MsgTypeTyping }
func (e TypingChannelEvent) ChannelID() int64     { return e.channelID }
func (e TypingChannelEvent) ExcludeUserID() int64 { return e.excludeUserID }
func (e TypingChannelEvent) Payload() []byte      { return e.payload }

// TypingDMEvent is a typing indicator sent to DM participants, excluding sender.
// It uses UserTargetedEvent routing because DM typing excludes the sender and
// is delivered directly to each other participant.
type TypingDMEvent struct {
	targetUserID int64
	payload      []byte
}

func (e TypingDMEvent) EventType() string   { return MsgTypeTyping }
func (e TypingDMEvent) TargetUserID() int64 { return e.targetUserID }
func (e TypingDMEvent) Payload() []byte     { return e.payload }

// PresenceEvent is a presence update broadcast to all connected clients.
type PresenceEvent struct {
	payload []byte
}

func (e PresenceEvent) EventType() string { return MsgTypePresence }
func (e PresenceEvent) Payload() []byte   { return e.payload }

// ReactionChannelEvent is a reaction update broadcast to a non-DM channel.
type ReactionChannelEvent struct {
	channelID int64
	payload   []byte
}

func (e ReactionChannelEvent) EventType() string { return MsgTypeReactionUpdate }
func (e ReactionChannelEvent) ChannelID() int64  { return e.channelID }
func (e ReactionChannelEvent) Payload() []byte   { return e.payload }

// ReactionDMEvent is a reaction update broadcast to DM participants.
type ReactionDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e ReactionDMEvent) EventType() string { return MsgTypeReactionUpdate }
func (e ReactionDMEvent) ChannelID() int64  { return e.channelID }
func (e ReactionDMEvent) ParticipantIDs() []int64 {
	dst := make([]int64, len(e.participantIDs))
	copy(dst, e.participantIDs)
	return dst
}
func (e ReactionDMEvent) Payload() []byte { return e.payload }

// VoiceStateEvent is a voice state broadcast to all connected clients.
type VoiceStateEvent struct {
	payload []byte
}

func (e VoiceStateEvent) EventType() string { return MsgTypeVoiceState }
func (e VoiceStateEvent) Payload() []byte   { return e.payload }

// PluginBroadcastEvent is a plugin slash-command result broadcast to a channel
// (sequenced, replayable). Emitted by the chat_command handler after the
// invoking user's post permission is verified.
type PluginBroadcastEvent struct {
	channelID int64
	payload   []byte
}

func (e PluginBroadcastEvent) EventType() string { return "plugin_broadcast" }
func (e PluginBroadcastEvent) ChannelID() int64  { return e.channelID }
func (e PluginBroadcastEvent) Payload() []byte   { return e.payload }

// VoiceE2EEAnnounceEvent relays an ECDH public key to other voice channel participants.
type VoiceE2EEAnnounceEvent struct {
	voiceChannelID int64
	excludeUserID  int64
	payload        []byte
}

func (e VoiceE2EEAnnounceEvent) EventType() string     { return MsgTypeVoiceE2EEAnnounceBC }
func (e VoiceE2EEAnnounceEvent) VoiceChannelID() int64 { return e.voiceChannelID }
func (e VoiceE2EEAnnounceEvent) ExcludeUserID() int64  { return e.excludeUserID }
func (e VoiceE2EEAnnounceEvent) Payload() []byte       { return e.payload }

// VoiceE2EEOfferGuardedEvent relays an encrypted room key to a specific user,
// using atomic check-and-send to verify the target is still in the same voice
// channel. Satisfies VoiceChannelGuardedEvent.
type VoiceE2EEOfferGuardedEvent struct {
	voiceChannelID int64
	targetUserID   int64
	payload        []byte
}

func (e VoiceE2EEOfferGuardedEvent) EventType() string     { return MsgTypeVoiceE2EEOfferRelay }
func (e VoiceE2EEOfferGuardedEvent) VoiceChannelID() int64 { return e.voiceChannelID }
func (e VoiceE2EEOfferGuardedEvent) TargetUserID() int64   { return e.targetUserID }
func (e VoiceE2EEOfferGuardedEvent) Payload() []byte       { return e.payload }

// DMChannelOpenEvent sends a dm_channel_open notification to a specific user.
type DMChannelOpenEvent struct {
	targetUserID int64
	payload      []byte
}

func (e DMChannelOpenEvent) EventType() string   { return MsgTypeDMChannelOpen }
func (e DMChannelOpenEvent) TargetUserID() int64 { return e.targetUserID }
func (e DMChannelOpenEvent) Payload() []byte     { return e.payload }
