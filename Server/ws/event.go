package ws

import (
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
)

// ClientError is an error to send back to the requesting client; usable as Result.Error.
type ClientError struct {
	Code    string
	Message string
	// ThreadID, when non-zero, is the thread_id a THREAD_EXISTS refusal names.
	ThreadID int64
}

func (e ClientError) Error() string { return e.Code + ": " + e.Message }

// Result is returned by V2 handlers: Events to emit, an optional error and an
// optional Reply (ACK) to the sender.
type Result struct {
	Events []Event
	// Error, if non-nil, is sent to the client; ClientError is user-facing, other
	// types are treated as internal.
	Error error
	// Reply is a raw JSON ACK sent only to the sender (e.g. chat_send_ok).
	Reply []byte
	// SetChannelID, if non-nil, updates the client's focused channel (channel_focus).
	SetChannelID *int64
	// DeferChannelFocus, if non-nil, is set by channel_focus when the focus budget is
	// spent. The applier remembers it as the latest focus intent (superseding any
	// earlier deferred one) and applies it once the rate window frees, so a burst of
	// channel switches still ends on the channel the user landed on.
	DeferChannelFocus *int64
	// DeferChannelFocusNoRead is true when the deferred frame said read:false, so the
	// drain does not mark the channel read. Only meaningful with DeferChannelFocus.
	DeferChannelFocusNoRead bool
	// SetThreadID, if non-nil, moves the second focus slot (thread_focus); 0 closes
	// it. Revalidated live like SetChannelID.
	SetThreadID *int64
	// SetPresence, if non-nil, records the presence the handler just committed as the
	// client's live presence. Applied before Events are emitted so a ready or snapshot
	// built after the presence frame was queued cannot miss it.
	SetPresence *livePresence
	// SetActivity, if non-nil, swaps the connection's game activity (nil clears) and
	// broadcasts the presence frame showing it, only while the connection still holds
	// its user's slot (activity_update). The frame is built in the applier, not
	// Events, because only it sees the live status the frame must carry.
	SetActivity *activityChange
	// SetListening is SetActivity's twin for the song (listening_update).
	SetListening *listeningChange
	// SetE2EEAnnounce, if non-nil, replaces the client's stored voice E2EE announce
	// so late-joiner replay, resume and grace-window paths relay it.
	SetE2EEAnnounce *e2eeAnnounce
	// SetVoiceWatching, if non-nil, stores the sender's watched-screen-share set on
	// its voice slot and, only if the slot is still in that channel, relays it
	// (voice_watch). The relay is emitted by the applier after the guarded store
	// succeeds, not in Events.
	SetVoiceWatching *voiceWatchSet
	// SetVoiceJoinToken, if non-nil, caches the voice join token on the client
	// (voice_token_refresh falling back to the DB).
	SetVoiceJoinToken *string
	// JoinVoice, if true, runs the hub's voice-join routine after the handler returns.
	// It is a large hub-coupled sequence that also invokes the leave routine on a
	// channel switch, so the applier runs handleVoiceJoin (re-parsing the validated
	// payload) rather than re-expressing it as events.
	JoinVoice bool
	// LeaveVoice, if true, runs the hub's voice-leave routine after the handler
	// returns. handleVoiceLeave stays hub-internal because disconnect and
	// channel-switch cleanup call it un-throttled; only the message dispatch (which
	// rate-limits first) moved to V2.
	LeaveVoice bool
	// LeaveVoiceReason is the machine-readable reason, logged on the "voice leave"
	// line to tell teardown paths apart. Only meaningful with LeaveVoice; use a
	// voiceLeaveReason* constant.
	LeaveVoiceReason string
}

// Event is the base interface for all server-to-client events.
type Event interface {
	EventType() string
	// deliveryClass names the route emitEventsFrom delivers on. Unexported, so Event
	// is sealed to this package and every event type must choose a route
	// (delivery_class.go).
	deliveryClass() deliveryClass
}

// emitEventsFrom switches on Event.deliveryClass to pick the route, then asserts
// the one interface its class needs. A DM event implements both SequencedDMEvent
// and ChannelEvent; its class says which route it takes.

// ChannelEvent routes through Hub.broadcastChannelEvent (sequenced, replayable):
// metadata kinds go to BroadcastToChannel, while content-bearing kinds
// (contentBearingKinds) are narrowed to channelContentAudience (CanReadContent
// over the actual topic subscribers), so a labelled channel's content is withheld
// from an unacknowledged subscriber.
type ChannelEvent interface {
	Event
	ChannelID() int64
	Payload() []byte
}

// ExcludeSenderEvent routes to Hub.broadcastExclude (ephemeral, not replayed), for
// typing indicators in non-DM channels.
type ExcludeSenderEvent interface {
	Event
	ChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// SequencedDMEvent routes to Hub.sendSequencedToUsers (sequenced, replayable), for
// DM chat messages, edits, deletes and reactions.
type SequencedDMEvent interface {
	Event
	ChannelID() int64
	ParticipantIDs() []int64
	Payload() []byte
}

type UserTargetedEvent interface {
	Event
	TargetUserID() int64
	Payload() []byte
}

type BroadcastAllEvent interface {
	Event
	Payload() []byte
}

// VoiceVisibilityEvent routes to Hub.broadcastVoiceEvent: server-wide in scope but
// delivered only to clients whose role may READ the channel, and tagged with it so
// replay filters the same way. Must be checked before BroadcastAllEvent, which it
// would otherwise satisfy. UserID is the subject whose voice state changed; the
// sender-aware DM audience needs it to filter a 1:1 DM call like chat.
type VoiceVisibilityEvent interface {
	Event
	VisibleChannelID() int64
	UserID() int64
	Payload() []byte
}

// VoiceChannelEvent routes to Hub.sendToVoiceChannelExcept (ephemeral, voice
// participants excluding the sender).
type VoiceChannelEvent interface {
	Event
	VoiceChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// VoiceChannelGuardedEvent routes to Hub.sendToUserIfInVoiceChannel: an atomic
// check-and-send under one h.mu.RLock that the target is still in the expected
// voice channel, preventing TOCTOU races with a concurrent voice_leave
// (voice_e2ee_offer).
type VoiceChannelGuardedEvent interface {
	Event
	VoiceChannelID() int64
	TargetUserID() int64
	Payload() []byte
}

// channelEvt is a sequenced, replayable event scoped to one non-DM channel (chat
// message, edit, delete, reaction update, plugin broadcast). evType carries the
// wire type, as CallSignalEvent does.
type channelEvt struct {
	evType    string
	channelID int64
	payload   []byte
}

func (e channelEvt) EventType() string            { return e.evType }
func (e channelEvt) deliveryClass() deliveryClass { return classChannel }
func (e channelEvt) ChannelID() int64             { return e.channelID }
func (e channelEvt) Payload() []byte              { return e.payload }

// ActivityEvent feeds the channel_activity coalescer. Deliberately not a
// ChannelEvent: nothing is sequenced, stored or sent to a topic.
type ActivityEvent interface {
	Event
	ActivityNote() activityNote
}

type channelActivityEvt struct {
	channelID int64
	msgID     int64
	authorID  int64
	mentions  []int64
	// roleUsers are the holders of the pinged roles; they count as direct mentions.
	roleUsers []int64
	everyone  bool
	hereOnly  bool
	readBy    int64
	// readUpTo is the pointer a read mark is set to; readSet is false for a mark
	// through everything noted so far (readThroughNoted).
	readUpTo int64
	readSet  bool
}

// readThroughNoted is the upTo for a focus that marks the channel read at its
// latest message: the coalescer reads through every message it has noted.
const readThroughNoted int64 = -1

// channelReadEvt tells the coalescer a user marked a channel read, so a pending
// hint for it is not sent. upTo is the pointer the database returned after
// mark_read or mark_unread (possibly lower than before). 0 is a real pointer
// (mark_unread of a first message), so the through-everything case is
// readThroughNoted.
func channelReadEvt(userID, channelID, upTo int64) ActivityEvent {
	return channelActivityEvt{channelID: channelID, readBy: userID, readUpTo: upTo, readSet: upTo >= 0}
}

func (e channelActivityEvt) EventType() string            { return MsgTypeChannelActivity }
func (e channelActivityEvt) deliveryClass() deliveryClass { return classActivity }
func (e channelActivityEvt) ActivityNote() activityNote {
	return activityNote(e)
}

// dmEvt is channelEvt's DM counterpart, addressed to a DM's participants instead
// of topic subscribers. It satisfies both SequencedDMEvent and ChannelEvent, so
// EmitEvents must check SequencedDMEvent first.
type dmEvt struct {
	evType         string
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e dmEvt) EventType() string            { return e.evType }
func (e dmEvt) deliveryClass() deliveryClass { return classSequencedDM }
func (e dmEvt) ChannelID() int64             { return e.channelID }
func (e dmEvt) ParticipantIDs() []int64      { return slices.Clone(e.participantIDs) }
func (e dmEvt) Payload() []byte              { return e.payload }

type TypingChannelEvent struct {
	channelID     int64
	excludeUserID int64
	payload       []byte
}

func (e TypingChannelEvent) EventType() string            { return MsgTypeTyping }
func (e TypingChannelEvent) deliveryClass() deliveryClass { return classExcludeSender }
func (e TypingChannelEvent) ChannelID() int64             { return e.channelID }
func (e TypingChannelEvent) ExcludeUserID() int64         { return e.excludeUserID }
func (e TypingChannelEvent) Payload() []byte              { return e.payload }

// TypingDMEvent is a typing indicator sent to DM participants, excluding the
// sender. It satisfies UserTargetedEvent, but EmitEvents routes it onto
// SendToUserLow (the direct counterpart of TypingChannelEvent's
// broadcastExcludeLow) instead of SendToUserHigh, so this ephemeral frame is
// dropped on overflow rather than disconnecting the client as durable targeted
// events (DM opens, mentions) do.
type TypingDMEvent struct {
	targetUserID int64
	payload      []byte
}

func (e TypingDMEvent) EventType() string            { return MsgTypeTyping }
func (e TypingDMEvent) deliveryClass() deliveryClass { return classTypingDM }
func (e TypingDMEvent) TargetUserID() int64          { return e.targetUserID }
func (e TypingDMEvent) Payload() []byte              { return e.payload }

// PresenceEvent is a presence update broadcast to all connected clients. userID
// lets EmitEvents invalidate any stale entry the connect/disconnect coalescer
// holds. bare, set only when payload carries a game or song, is the same frame
// with both null; emitPresence sends it when member activity was switched off
// after the handler snapshotted them.
// the handler snapshotted them.
type PresenceEvent struct {
	userID  int64
	payload []byte
	bare    []byte
}

func (e PresenceEvent) EventType() string            { return MsgTypePresence }
func (e PresenceEvent) deliveryClass() deliveryClass { return classPresence }
func (e PresenceEvent) Payload() []byte              { return e.payload }

// PresenceOthersEvent is the public half of an invisible user's presence: the
// mapped "offline" payload broadcast to everyone except its subject. It satisfies
// ExcludeSenderEvent with channel id 0, but EmitEvents routes it onto
// BroadcastToAllExcept (normal priority, sequenced, replayable) instead of
// broadcastExcludeLow, so it shares the durable per-client FIFO of the same user's
// other presence frames rather than the drop-on-overflow one built for typing.
type PresenceOthersEvent struct {
	excludeUserID int64
	payload       []byte
}

func (e PresenceOthersEvent) EventType() string            { return MsgTypePresence }
func (e PresenceOthersEvent) deliveryClass() deliveryClass { return classPresenceOthers }
func (e PresenceOthersEvent) ChannelID() int64             { return 0 }
func (e PresenceOthersEvent) ExcludeUserID() int64         { return e.excludeUserID }
func (e PresenceOthersEvent) Payload() []byte              { return e.payload }

// PresenceSelfEvent is the private half: the owner's own true status, sent only
// to them. Without it the broadcast that hid them would tell them they are
// offline, and they would re-announce online on the next reconnect. bare is as in
// PresenceEvent (nil when the frame has no game or song).
type PresenceSelfEvent struct {
	targetUserID int64
	payload      []byte
	bare         []byte
}

func (e PresenceSelfEvent) EventType() string            { return MsgTypePresence }
func (e PresenceSelfEvent) deliveryClass() deliveryClass { return classPresenceSelf }
func (e PresenceSelfEvent) TargetUserID() int64          { return e.targetUserID }
func (e PresenceSelfEvent) Payload() []byte              { return e.payload }

// presenceEvents builds the events one presence change needs: normally one global
// broadcast. For invisible, what others see differs from what the owner sees, so
// the broadcast excludes the owner and a second targeted event carries their real
// status. Every presence emitter goes through here so no call site can leak an
// invisible user by forgetting the mapping.
func presenceEvents(userID int64, status string, customStatus *string, activity *gameActivity, listening *listeningActivity, mobile bool) []Event {
	public := db.BroadcastStatus(status)
	if public == status {
		return []Event{PresenceEvent{
			userID:  userID,
			payload: buildPresenceMsg(userID, status, customStatus, activity, listening, mobile),
			bare:    bareActivityFrame(userID, status, customStatus, activity, listening, mobile),
		}}
	}
	return []Event{
		PresenceOthersEvent{
			excludeUserID: userID,
			// customStatus, activity and listening are blanked: the status already collapsed
			// to "offline", and a free-text status, game or song on an "offline" member would
			// give the invisible user away. Mirrors BroadcastPresence and
			// db.MemberSummary.ForViewer.
			// mobile is dropped for the same reason: it would show the member is online.
			payload: buildPresenceMsg(userID, public, nil, nil, nil, false),
		},
		PresenceSelfEvent{
			targetUserID: userID,
			payload:      buildPresenceMsg(userID, status, customStatus, activity, listening, mobile),
			bare:         bareActivityFrame(userID, status, customStatus, activity, listening, mobile),
		},
	}
}

// VoiceStateEvent is a voice state update fanned out to clients whose role may READ
// the channel.
type VoiceStateEvent struct {
	voiceChannelID int64
	userID         int64
	payload        []byte
}

func (e VoiceStateEvent) EventType() string            { return MsgTypeVoiceState }
func (e VoiceStateEvent) deliveryClass() deliveryClass { return classVoiceVisibility }
func (e VoiceStateEvent) VisibleChannelID() int64      { return e.voiceChannelID }
func (e VoiceStateEvent) UserID() int64                { return e.userID }
func (e VoiceStateEvent) Payload() []byte              { return e.payload }

type VoiceE2EEAnnounceEvent struct {
	voiceChannelID int64
	excludeUserID  int64
	payload        []byte
}

func (e VoiceE2EEAnnounceEvent) EventType() string            { return MsgTypeVoiceE2EEAnnounceBC }
func (e VoiceE2EEAnnounceEvent) deliveryClass() deliveryClass { return classVoiceChannel }
func (e VoiceE2EEAnnounceEvent) VoiceChannelID() int64        { return e.voiceChannelID }
func (e VoiceE2EEAnnounceEvent) ExcludeUserID() int64         { return e.excludeUserID }
func (e VoiceE2EEAnnounceEvent) Payload() []byte              { return e.payload }

// VoiceE2EEOfferGuardedEvent relays an encrypted room key to one user via the
// atomic check-and-send that the target is still in the same voice channel.
type VoiceE2EEOfferGuardedEvent struct {
	voiceChannelID int64
	targetUserID   int64
	payload        []byte
}

func (e VoiceE2EEOfferGuardedEvent) EventType() string            { return MsgTypeVoiceE2EEOfferRelay }
func (e VoiceE2EEOfferGuardedEvent) deliveryClass() deliveryClass { return classVoiceChannelGuarded }
func (e VoiceE2EEOfferGuardedEvent) VoiceChannelID() int64        { return e.voiceChannelID }
func (e VoiceE2EEOfferGuardedEvent) TargetUserID() int64          { return e.targetUserID }
func (e VoiceE2EEOfferGuardedEvent) Payload() []byte              { return e.payload }

// threadFollowEvt delivers a thread_follow_update to one user, unsequenced on the
// low queue: a missed frame costs nothing since ready.threads is authoritative.
type threadFollowEvt struct {
	targetUserID int64
	payload      []byte
}

func (e threadFollowEvt) EventType() string            { return MsgTypeThreadFollowUpdate }
func (e threadFollowEvt) deliveryClass() deliveryClass { return classTypingDM }
func (e threadFollowEvt) TargetUserID() int64          { return e.targetUserID }
func (e threadFollowEvt) Payload() []byte              { return e.payload }

type DMChannelOpenEvent struct {
	targetUserID int64
	payload      []byte
}

func (e DMChannelOpenEvent) EventType() string            { return MsgTypeDMChannelOpen }
func (e DMChannelOpenEvent) deliveryClass() deliveryClass { return classUserTargeted }
func (e DMChannelOpenEvent) TargetUserID() int64          { return e.targetUserID }
func (e DMChannelOpenEvent) Payload() []byte              { return e.payload }

// DMRequestEvent announces a message request to its recipient: once on creation
// (handlers_chat.go) and again with a new state on every recipient transition
// (api/dm_request_handler.go). Unsequenced and not replayed; a client that misses
// it recovers from GET /api/v1/dm-requests, the persisted source of truth, so
// unlike DMChannelOpenEvent it need not bump the visibility watermark.
type DMRequestEvent struct {
	targetUserID int64
	payload      []byte
}

func (e DMRequestEvent) EventType() string            { return MsgTypeDMRequest }
func (e DMRequestEvent) deliveryClass() deliveryClass { return classUserTargeted }
func (e DMRequestEvent) TargetUserID() int64          { return e.targetUserID }
func (e DMRequestEvent) Payload() []byte              { return e.payload }

// CallSignalEvent delivers a DM call signal (call_incoming / call_declined) to one
// participant. It satisfies UserTargetedEvent, so an offline addressee is a
// no-op, correct for ringing: a late ring is worse than none.
type CallSignalEvent struct {
	eventType    string
	targetUserID int64
	payload      []byte
}

func (e CallSignalEvent) EventType() string            { return e.eventType }
func (e CallSignalEvent) deliveryClass() deliveryClass { return classCallSignal }
func (e CallSignalEvent) TargetUserID() int64          { return e.targetUserID }
func (e CallSignalEvent) Payload() []byte              { return e.payload }
