package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// Hub read seams: the hub's snapshot, visibility, member-payload and dispatch paths read
// through these consumer-side interfaces, each naming exactly the reads its consumer may
// make. *db.DB satisfies every seam; the composition root wires DBReaders.

// VisibilityReader is what visibility and audience resolution may read.
type VisibilityReader interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	ListChannels(ctx context.Context) ([]db.Channel, error)
	// ListAllChannels keeps the DM rows ListChannels leaves out.
	ListAllChannels(ctx context.Context) ([]db.Channel, error)
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error)
	// The NSFW reads back the NSFW content gate (ready's nsfw_acknowledged, replay's filter and
	// per-frame check, the per-broadcast audience). Taken live, never cached across handshakes.
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
	ListNSFWAcknowledgedUserIDs(ctx context.Context, channelID int64) ([]int64, error)
	ListNSFWAcknowledgedChannelIDs(ctx context.Context, userID int64) (map[int64]bool, error)
	// ChannelContentGate is the per-frame replay check: whether the channel exists and userID may read it
	// now.
	ChannelContentGate(ctx context.Context, userID, channelID int64) (found, readable bool, err error)
	// ListBlockersOf backs the channel_activity flush: users who blocked a message's author get no mention
	// flag.
	ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error)
	// IsGroupDM and IsTrustedSender back the sender-aware DM voice audience (filterDMAudience):
	// a 1:1 DM's voice fan-out must not reach a recipient who does not trust the event's subject.
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	IsTrustedSender(ctx context.Context, recipientID, senderID int64) (bool, error)
}

// ReadySnapshotReader is what ready may read on top of visibility: directories and unread state.
type ReadySnapshotReader interface {
	VisibilityReader
	ListRoles(ctx context.Context) ([]*db.Role, error)
	ListMembers(ctx context.Context) ([]db.MemberSummary, error)
	ListChannelCategories(ctx context.Context) ([]db.ChannelCategory, error)
	MemberGeneration(ctx context.Context) (int64, error)
	NextMemberBanLapse(ctx context.Context) (string, error)
	GetUserDMChannels(ctx context.Context, userID int64) ([]db.DMChannelInfo, error)
	GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]db.ChannelUnread, error)
	GetAllVoiceStates(ctx context.Context) ([]db.VoiceState, error)
	ListUnacknowledgedWarnings(ctx context.Context, userID int64) ([]db.ModerationNotice, error)
	// MessageDeliveryFloorMS is ready's message_retry_floor_ms: the timestamp below which a
	// redelivered message is too old to dedupe against.
	MessageDeliveryFloorMS() int64
}

// MemberPayloadReader is what member broadcast payloads may read: the user and role they announce.
type MemberPayloadReader interface {
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
}

// DispatchReader is what command dispatch (deps.go, handlers.go) may read.
type DispatchReader interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
	// The bare-hub fallback in voice_join's publish-permission derivation uses this when no PermissionService
	// is wired.
	GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error)
	GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*db.SessionWithBanStatus, error)
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	GetAFKChannel(ctx context.Context) (*db.Channel, error)
	// The voice channel password check (voice_join_password.go): hash and version, whether the
	// member already entered it, and a grant write only if the version is still the one checked.
	// The hash goes no further than the comparison.
	ChannelPasswordState(ctx context.Context, channelID int64) (hash string, version int64, found bool, err error)
	HasChannelPasswordGrant(ctx context.Context, channelID, userID int64) (bool, error)
	GrantChannelPassword(ctx context.Context, channelID, userID, version int64) (bool, error)
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
	DMRefusesSender(ctx context.Context, recipientID, senderID int64) (bool, error)
	// GetReport and GetAppeal back the mod_queue frames (moderation_queue.go), which resolve the
	// audience with no actor, so the actor-scoped service Get does not apply. Only the public
	// id and the principals to exclude are read; only the public id and state reach the wire.
	GetReport(ctx context.Context, id int64) (*db.Report, error)
	GetAppeal(ctx context.Context, id int64) (*db.Appeal, error)
	ListActiveTimeoutExpiries(ctx context.Context) ([]db.ActiveTimeoutExpiry, error)
}

// HubReaders bundles the read seams HubOptions requires, all backed by the handle. A
// collaborator that is not handle-backed (Settings, Voice, Presence) is its own HubOptions field.
type HubReaders struct {
	Visibility VisibilityReader
	Ready      ReadySnapshotReader
	Members    MemberPayloadReader
	Dispatch   DispatchReader
}

func (r HubReaders) complete() bool {
	return r.Visibility != nil && r.Ready != nil && r.Members != nil && r.Dispatch != nil
}

// DBReaders backs every seam with the database handle (the composition root's wiring).
func DBReaders(d *db.DB) HubReaders {
	return HubReaders{Visibility: d, Ready: d, Members: d, Dispatch: d}
}

// VoiceStore is the hub's view of the voice family: every voice_states read and write plus
// the moderation audit row. service.VoiceService satisfies it; *db.DB does not, because the
// family's decisions (capacity-limited insert, compensating-write scope, restore) live on
// the service.
type VoiceStore interface {
	State(ctx context.Context, userID int64) (*db.VoiceState, error)
	ChannelStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	AllStates(ctx context.Context) ([]db.VoiceState, error)
	CountInChannel(ctx context.Context, channelID int64) (int, error)

	Join(ctx context.Context, userID, channelID int64, maxUsers int) error
	LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error)
	NoteJoinCompleted(channelID, userID int64)

	SetSelfMute(ctx context.Context, userID int64, muted bool) error
	SetSelfDeafen(ctx context.Context, userID int64, deafened bool) error
	SetCamera(ctx context.Context, userID int64, enabled bool) error
	SetScreenshare(ctx context.Context, userID int64, enabled bool) error
	ReserveCamera(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	ReserveScreenshare(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)

	SetServerMute(ctx context.Context, userID, channelID int64, muted bool) (bool, error)
	SetServerDeafen(ctx context.Context, userID, channelID int64, deafened bool) (bool, error)
	// MuteForTimeoutSession is the timeout voice half's mute: scoped to one exact session
	// (channelID, joinedAt), stamping actionID as owner atomically with the mute, only on a
	// genuine unmuted-to-muted transition. supersededIDs transfers ownership onto actionID in
	// the same transaction (service.TimeoutVoiceMuter.MuteForTimeout).
	MuteForTimeoutSession(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (matched, transitioned bool, err error)
	// ClearServerMuteOwnedBy clears the mute owned by any of actionIDs, session-bound: a stale id never
	// clears an ended or restarted session.
	ClearServerMuteOwnedBy(ctx context.Context, userID int64, actionIDs []int64) (channelID int64, joinedAt string, matched bool, err error)
	// serverMutedBy carries a timeout's ownership onto the fresh session; nil restores the ownerless (manual)
	// mute.
	RestoreModFlags(ctx context.Context, userID, channelID int64, muted, deafened bool, serverMutedBy *int64) *db.VoiceState
	RollbackServerDeafen(ctx context.Context, targetID, authorizedChannelID int64, requestedDeafen bool)
	WriteModAudit(ctx context.Context, actorID int64, action string, targetID int64, detail string)
}

// PresenceStamper is the pair of writes a session makes about itself: the status it comes
// online as and the offline stamp when its last pump exits. service.UserService satisfies
// it; *db.DB does not, because StampConnect owns which saved status survives a reconnect.
type PresenceStamper interface {
	StampConnect(ctx context.Context, userID int64, savedStatus string) (string, error)
	StampDisconnect(ctx context.Context, userID int64) error
}

// SocketAuthenticator is the hub's view of the auth family: who a bearer token
// authenticates, whether a live session is still good, and the connect audit row.
// service.SessionService satisfies it, not AuthService (its broadcaster dependency would
// close a construction cycle). Refusals are sentinels, not a boolean: a bad credential gets
// a non-recoverable auth error (client clears its token), a DB failure a retryable error
// frame; one "not authenticated" would log every user out during a blip.
type SocketAuthenticator interface {
	ResolveSocketPrincipal(ctx context.Context, tokenHash string) (*db.User, error)
	SweepSessions(ctx context.Context, tokenHashes []string) (map[string]service.SessionVerdict, error)
	RecordSocketConnect(ctx context.Context, userID int64, remoteAddr string)
	TouchSession(ctx context.Context, tokenHash string) error
	// RecordSessionIdentityKey stores the validated device identity public key on the session.
	RecordSessionIdentityKey(ctx context.Context, tokenHash, key string) error
}

// ChannelPrivacy is the channel-level private flag the hub's channel frames carry; nil means nothing is
// private.
type ChannelPrivacy interface {
	Snapshot(ctx context.Context) (service.ChannelPrivacySnapshot, error)
	ChannelIsPrivate(ctx context.Context, channelID int64) (bool, error)
}
