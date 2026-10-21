package ws

// deliveryClass names the route emitEventsFrom takes for an Event. Every
// concrete event declares its own through the unexported Event.deliveryClass
// method, which also seals Event to this package: a new event type cannot
// compile until it chooses a route, and a type that matches no accessor
// interface can no longer fall through to a server-wide broadcast.
//
// The zero value is deliberately invalid. An event that reports it, or a class
// emitEventsFrom has no case for, is logged and dropped.
type deliveryClass int

const (
	// classInvalid is the zero value: never a route.
	classInvalid deliveryClass = iota
	// classChannel: sequenced, replayable, one channel's topic subscribers
	// (Hub.broadcastChannelEvent). Needs ChannelEvent.
	classChannel
	// classSequencedDM: sequenced, replayable, a DM's participants
	// (Hub.sendSequencedToUsers). Needs SequencedDMEvent.
	classSequencedDM
	// classExcludeSender: ephemeral low-priority channel broadcast that skips
	// the sender (Hub.broadcastExcludeLow). Needs ExcludeSenderEvent.
	classExcludeSender
	// classTypingDM: ephemeral low-priority direct delivery
	// (Hub.SendToUserLow). Needs UserTargetedEvent.
	classTypingDM
	// classPresence: a user-chosen presence broadcast to everyone, through the
	// presence coalescer's drop-and-broadcast. Needs PresenceEvent.
	classPresence
	// classPresenceOthers: an invisible user's public presence half, to
	// everyone but the owner. Needs PresenceOthersEvent.
	classPresenceOthers
	// classPresenceSelf: the owner's own true presence, normal priority. Needs
	// PresenceSelfEvent.
	classPresenceSelf
	// classUserTargeted: durable high-priority delivery to one user
	// (Hub.SendToUserHigh). Needs UserTargetedEvent.
	classUserTargeted
	// classCallSignal: normal-priority delivery to one user, after the
	// connection's voice dispatch barrier. Needs UserTargetedEvent.
	classCallSignal
	// classVoiceChannel: ephemeral delivery to a voice channel's participants
	// except the sender. Needs VoiceChannelEvent.
	classVoiceChannel
	// classVoiceChannelGuarded: atomic check-and-send to one user still in the
	// voice channel. Needs VoiceChannelGuardedEvent.
	classVoiceChannelGuarded
	// classVoiceVisibility: server-wide, narrowed to clients that may read the
	// named channel. Needs VoiceVisibilityEvent.
	classVoiceVisibility
	// classActivity: a note for the channel_activity coalescer; nothing is
	// sent. Needs ActivityEvent.
	classActivity
	// classBroadcastAll: normal-priority broadcast to every client. Only an
	// event that names this class explicitly can reach it. Needs
	// BroadcastAllEvent.
	classBroadcastAll
)
