package ws

// deliveryClass names the route emitEventsFrom takes for an Event. Each event
// declares its own through the unexported Event.deliveryClass, which seals Event
// to this package: a new event cannot compile until it chooses a route, so none
// falls through to a server-wide broadcast.
// The zero value is deliberately invalid; an event reporting it, or a class
// emitEventsFrom has no case for, is logged and dropped.
type deliveryClass int

const (
	classInvalid deliveryClass = iota
	// classChannel: sequenced, replayable, one channel's topic subscribers
	// (ChannelEvent).
	classChannel
	// classSequencedDM: sequenced, replayable, a DM's participants
	// (SequencedDMEvent).
	classSequencedDM
	// classExcludeSender: ephemeral low-priority channel broadcast skipping the
	// sender (ExcludeSenderEvent).
	classExcludeSender
	// classTypingDM: ephemeral low-priority direct delivery (UserTargetedEvent).
	classTypingDM
	// classPresence: a user-chosen presence broadcast to everyone via the
	// coalescer's drop-and-broadcast (PresenceEvent).
	classPresence
	// classPresenceOthers: an invisible user's public presence half, to everyone
	// but the owner (PresenceOthersEvent).
	classPresenceOthers
	// classPresenceSelf: the owner's own true presence, normal priority
	// (PresenceSelfEvent).
	classPresenceSelf
	// classUserTargeted: durable high-priority delivery to one user
	// (UserTargetedEvent).
	classUserTargeted
	// classCallSignal: normal-priority delivery to one user after the voice
	// dispatch barrier (UserTargetedEvent).
	classCallSignal
	// classVoiceChannel: ephemeral delivery to a voice channel's participants
	// except the sender (VoiceChannelEvent).
	classVoiceChannel
	// classVoiceChannelGuarded: atomic check-and-send to one user still in the
	// voice channel (VoiceChannelGuardedEvent).
	classVoiceChannelGuarded
	// classVoiceVisibility: server-wide, narrowed to clients that may read the
	// named channel (VoiceVisibilityEvent).
	classVoiceVisibility
	// classActivity: a note for the channel_activity coalescer; nothing is sent
	// (ActivityEvent).
	classActivity
	// classBroadcastAll: normal-priority broadcast to every client; reachable
	// only by naming this class (BroadcastAllEvent).
	classBroadcastAll
	// classThreadNote: a note for the thread_changed coalescer, which sequences
	// the frame on flush (ThreadNoteEvent).
	classThreadNote
)
