package ws

import (
	"slices"

	"github.com/J3vb/OwnCord/Server/db"
)

// ClientError is an error to send back to the requesting client; usable as Result.Error.
type ClientError struct {
	Code     string
	Message  string
	ThreadID int64
}

func (e ClientError) Error() string { return e.Code + ": " + e.Message }

// Result is returned by V2 handlers: Events to emit, an optional error and an optional Reply (ACK)
// to the sender.
type Result struct {
	Events []Event
	// Error, if non-nil, is sent to the client; ClientError is user-facing,
	// others are internal.
	Error        error
	Reply        []byte
	SetChannelID *int64
	// DeferChannelFocus, if non-nil, is set by channel_focus when the focus
	// budget is spent. The applier keeps it as the latest intent and applies it
	// when the rate window frees, so a burst of switches ends on the channel the
	// user landed on.
	DeferChannelFocus *int64
	// DeferChannelFocusNoRead is true when the deferred frame said read:false;
	// only meaningful with DeferChannelFocus.
	DeferChannelFocusNoRead bool
	// SetThreadID, if non-nil, moves the second focus slot (0 closes it);
	// revalidated live like SetChannelID.
	SetThreadID *int64
	// SetPresence records the committed presence as the client's live presence,
	// applied before Events are emitted so a ready or snapshot built after the
	// frame was queued cannot miss it.
	SetPresence *livePresence
	// SetActivity swaps the connection's game (nil clears) and broadcasts the
	// presence frame, only while the connection still holds its user's slot.
	// Built in the applier because only it sees the live status the frame must
	// carry.
	SetActivity  *activityChange
	SetListening *listeningChange
	// SetE2EEAnnounce replaces the client's stored voice E2EE announce so late-
	// joiner replay, resume and grace-window paths relay it.
	SetE2EEAnnounce *e2eeAnnounce
	// SetVoiceWatching stores the watched-screen-share set on the voice slot and
	// relays it (voice_watch) from the applier only if the slot is still in that
	// channel.
	SetVoiceWatching *voiceWatchSet
	// SetVoiceJoinToken caches the voice join token on the client
	// (voice_token_refresh falls back to the DB).
	SetVoiceJoinToken *string
	// JoinVoice runs the hub's voice-join routine after the handler returns: it
	// also invokes the leave routine on a channel switch, so the applier runs
	// handleVoiceJoin instead of re-expressing it as events.
	JoinVoice bool
	// LeaveVoice runs the voice-leave routine after the handler returns;
	// handleVoiceLeave stays hub-internal because disconnect and channel-switch
	// cleanup call it un-throttled.
	LeaveVoice bool
	// LeaveVoiceReason is logged on the "voice leave" line to tell teardown paths
	// apart; use a voiceLeaveReason* constant.
	LeaveVoiceReason string
	// AfterEmit runs once Events are emitted, so work that must be sequenced behind
	// them (a link preview for the message just sent) cannot overtake them.
	AfterEmit func()
}

// Event is the base interface for all server-to-client events.
type Event interface {
	EventType() string
	// deliveryClass names the route emitEventsFrom delivers on. Unexported, so
	// Event is sealed to this package and every event type must choose a route.
	deliveryClass() deliveryClass
}

// emitEventsFrom switches on Event.deliveryClass, then asserts the one interface
// its class needs (a DM event implements both SequencedDMEvent and ChannelEvent).

// ChannelEvent routes through Hub.broadcastChannelEvent (sequenced, replayable):
// content-bearing kinds (contentBearingKinds) are narrowed to
// channelContentAudience so a labelled channel's content is withheld from an
// unacknowledged subscriber.
type ChannelEvent interface {
	Event
	ChannelID() int64
	Payload() []byte
}

// ExcludeSenderEvent routes to Hub.broadcastExclude (ephemeral, not replayed),
// for non-DM typing.
type ExcludeSenderEvent interface {
	Event
	ChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// SequencedDMEvent routes to Hub.sendSequencedToUsers (sequenced, replayable),
// for DM messages, edits, deletes and reactions.
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

// VoiceVisibilityEvent routes to Hub.broadcastVoiceEvent: server-wide but only to
// clients whose role may READ the channel, tagged so replay filters the same way.
// Check before BroadcastAllEvent, which it also satisfies. UserID is the subject
// whose state changed, for the DM audience filter.
type VoiceVisibilityEvent interface {
	Event
	VisibleChannelID() int64
	UserID() int64
	Payload() []byte
}

// VoiceChannelEvent routes to Hub.sendToVoiceChannelExcept (ephemeral,
// participants excluding the sender).
type VoiceChannelEvent interface {
	Event
	VoiceChannelID() int64
	ExcludeUserID() int64
	Payload() []byte
}

// VoiceChannelGuardedEvent routes to Hub.sendToUserIfInVoiceChannel: an atomic
// check-and-send under one h.mu.RLock that the sender holds the key and the
// target is still in the channel, avoiding a TOCTOU race with
// voice_join/voice_leave.
type VoiceChannelGuardedEvent interface {
	Event
	VoiceChannelID() int64
	SenderUserID() int64
	TargetUserID() int64
	Payload() []byte
}

type channelEvt struct {
	evType    string
	channelID int64
	payload   []byte
}

func (e channelEvt) EventType() string            { return e.evType }
func (e channelEvt) deliveryClass() deliveryClass { return classChannel }
func (e channelEvt) ChannelID() int64             { return e.channelID }
func (e channelEvt) Payload() []byte              { return e.payload }

// ActivityEvent feeds the channel_activity coalescer; deliberately not a
// ChannelEvent (nothing sequenced, stored or sent to a topic).
type ActivityEvent interface {
	Event
	ActivityNote() activityNote
}

type channelActivityEvt struct {
	channelID int64
	msgID     int64
	authorID  int64
	mentions  []int64
	roleUsers []int64
	everyone  bool
	hereOnly  bool
	readBy    int64
	// readUpTo is the pointer a read mark is set to; readSet false marks through
	// everything noted (readThroughNoted).
	readUpTo int64
	readSet  bool
}

const readThroughNoted int64 = -1

// channelReadEvt tells the coalescer a user marked a channel read, so a pending
// hint is not sent. upTo is the database pointer after mark_read/mark_unread; 0
// is a real pointer, hence readThroughNoted for through-everything.
func channelReadEvt(userID, channelID, upTo int64) ActivityEvent {
	return channelActivityEvt{channelID: channelID, readBy: userID, readUpTo: upTo, readSet: upTo >= 0}
}

func (e channelActivityEvt) EventType() string            { return MsgTypeChannelActivity }
func (e channelActivityEvt) deliveryClass() deliveryClass { return classActivity }
func (e channelActivityEvt) ActivityNote() activityNote {
	return activityNote(e)
}

// dmEvt is channelEvt's DM counterpart, addressed to a DM's participants. It
// satisfies both SequencedDMEvent and ChannelEvent, so EmitEvents must check
// SequencedDMEvent first.
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

// TypingDMEvent is a DM typing indicator excluding the sender. EmitEvents routes
// it onto SendToUserLow, not SendToUserHigh, so this ephemeral frame is dropped
// on overflow instead of disconnecting the client.
type TypingDMEvent struct {
	targetUserID int64
	payload      []byte
}

func (e TypingDMEvent) EventType() string            { return MsgTypeTyping }
func (e TypingDMEvent) deliveryClass() deliveryClass { return classTypingDM }
func (e TypingDMEvent) TargetUserID() int64          { return e.targetUserID }
func (e TypingDMEvent) Payload() []byte              { return e.payload }

// PresenceEvent is a presence update broadcast to all clients. userID lets
// EmitEvents invalidate a stale coalescer entry. bare (set only when payload
// carries a game or song) is the same frame with both null, sent when member
// activity was switched off after the handler snapshotted them.
type PresenceEvent struct {
	userID  int64
	payload []byte
	bare    []byte
}

func (e PresenceEvent) EventType() string            { return MsgTypePresence }
func (e PresenceEvent) deliveryClass() deliveryClass { return classPresence }
func (e PresenceEvent) Payload() []byte              { return e.payload }

// PresenceOthersEvent is the "offline" half of an invisible user's presence, to
// everyone except the subject. EmitEvents routes it onto BroadcastToAllExcept
// (normal priority, replayable) so it shares the durable FIFO of the user's other
// presence frames, not the drop-on-overflow one.
type PresenceOthersEvent struct {
	excludeUserID int64
	payload       []byte
}

func (e PresenceOthersEvent) EventType() string            { return MsgTypePresence }
func (e PresenceOthersEvent) deliveryClass() deliveryClass { return classPresenceOthers }
func (e PresenceOthersEvent) ChannelID() int64             { return 0 }
func (e PresenceOthersEvent) ExcludeUserID() int64         { return e.excludeUserID }
func (e PresenceOthersEvent) Payload() []byte              { return e.payload }

// PresenceSelfEvent is the owner's own true status, sent only to them; otherwise
// the hiding broadcast would tell them they are offline and they would re-
// announce online on reconnect. bare is as in PresenceEvent.
type PresenceSelfEvent struct {
	targetUserID int64
	payload      []byte
	bare         []byte
}

func (e PresenceSelfEvent) EventType() string            { return MsgTypePresence }
func (e PresenceSelfEvent) deliveryClass() deliveryClass { return classPresenceSelf }
func (e PresenceSelfEvent) TargetUserID() int64          { return e.targetUserID }
func (e PresenceSelfEvent) Payload() []byte              { return e.payload }

// presenceEvents builds the events one presence change needs. For invisible, the
// broadcast excludes the owner and a second targeted event carries their real
// status. Every emitter goes through here so no call site can leak an invisible
// user.
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
			// Blanked: a free-text status, game, song or mobile flag on an
			// "offline" member would give the invisible user away (mirrors
			// BroadcastPresence and db.MemberSummary.ForViewer).
			payload: buildPresenceMsg(userID, public, nil, nil, nil, false),
		},
		PresenceSelfEvent{
			targetUserID: userID,
			payload:      buildPresenceMsg(userID, status, customStatus, activity, listening, mobile),
			bare:         bareActivityFrame(userID, status, customStatus, activity, listening, mobile),
		},
	}
}

// VoiceStateEvent is a voice state update fanned out to clients whose role may
// READ the channel.
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

// VoiceE2EEOfferGuardedEvent relays an encrypted room key via the atomic check
// that the sender still holds the key and the target is in the same voice
// channel.
type VoiceE2EEOfferGuardedEvent struct {
	voiceChannelID int64
	senderUserID   int64
	targetUserID   int64
	payload        []byte
}

func (e VoiceE2EEOfferGuardedEvent) EventType() string            { return MsgTypeVoiceE2EEOfferRelay }
func (e VoiceE2EEOfferGuardedEvent) deliveryClass() deliveryClass { return classVoiceChannelGuarded }
func (e VoiceE2EEOfferGuardedEvent) VoiceChannelID() int64        { return e.voiceChannelID }
func (e VoiceE2EEOfferGuardedEvent) SenderUserID() int64          { return e.senderUserID }
func (e VoiceE2EEOfferGuardedEvent) TargetUserID() int64          { return e.targetUserID }
func (e VoiceE2EEOfferGuardedEvent) Payload() []byte              { return e.payload }

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

// DMRequestEvent announces a message request to its recipient on creation and on
// every recipient transition. Unsequenced, not replayed: a missed frame recovers
// from GET /api/v1/dm-requests, so no visibility watermark bump is needed.
type DMRequestEvent struct {
	targetUserID int64
	payload      []byte
}

func (e DMRequestEvent) EventType() string            { return MsgTypeDMRequest }
func (e DMRequestEvent) deliveryClass() deliveryClass { return classUserTargeted }
func (e DMRequestEvent) TargetUserID() int64          { return e.targetUserID }
func (e DMRequestEvent) Payload() []byte              { return e.payload }

// CallSignalEvent delivers a DM call signal to one participant; an offline
// addressee is a no-op, correct for ringing (a late ring is worse than none).
type CallSignalEvent struct {
	eventType    string
	targetUserID int64
	payload      []byte
	// ownDevices narrows delivery to the target's sockets that declared
	// call_sync: the sender's own other devices.
	ownDevices bool
}

func (e CallSignalEvent) EventType() string            { return e.eventType }
func (e CallSignalEvent) deliveryClass() deliveryClass { return classCallSignal }
func (e CallSignalEvent) TargetUserID() int64          { return e.targetUserID }
func (e CallSignalEvent) Payload() []byte              { return e.payload }
