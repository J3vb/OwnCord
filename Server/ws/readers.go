package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── Hub read seams (B3-8 channel family, part 3) ───────────────────────────
//
// The hub's snapshot, visibility, member-payload and dispatch paths read
// through these consumer-side interfaces instead of the raw handle — the
// SettingsReader pattern, one seam per concern. Each names exactly the reads
// its consumer may make, so the contract is visible here and the inventory's
// per-file rows become type-only: the calls live behind the seam, and later
// B3-8 families take their methods onto real services without touching the
// consumers again. *db.DB satisfies every seam; the composition root wires
// DBReaders today.

// VisibilityReader is what visibility and audience resolution
// (hub_visibility.go) may read: channels, overrides, participants, users.
type VisibilityReader interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	ListChannels(ctx context.Context) ([]db.Channel, error)
	GetChannelOverridesFor(ctx context.Context, roleID, userID int64) (map[int64]db.ChannelOverride, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error)
	GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error)
}

// ReadySnapshotReader is what the ready payload (serve_ready.go) may read on
// top of visibility: the directory listings and per-user unread state the
// snapshot renders.
type ReadySnapshotReader interface {
	VisibilityReader
	ListRoles(ctx context.Context) ([]*db.Role, error)
	ListMembers(ctx context.Context) ([]db.MemberSummary, error)
	GetUserDMChannels(ctx context.Context, userID int64) ([]db.DMChannelInfo, error)
	GetChannelUnreadCounts(ctx context.Context, userID int64) (map[int64]db.ChannelUnread, error)
	GetAllVoiceStates(ctx context.Context) ([]db.VoiceState, error)
}

// MemberPayloadReader is what member broadcast payloads (hub_broadcast.go)
// may read: the user and role they announce.
type MemberPayloadReader interface {
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error)
}

// DispatchReader is what command dispatch (deps.go's permission helpers and
// handlers.go's session/membership checks) may read.
type DispatchReader interface {
	GetChannel(ctx context.Context, id int64) (*db.Channel, error)
	GetRoleForUser(ctx context.Context, userID int64) (*db.Role, error)
	// The bare-hub fallback in voice_join.go's publish-permission derivation
	// resolves overrides here when no PermissionService cache is wired.
	GetChannelOverridesFor(ctx context.Context, roleID, userID int64) (map[int64]db.ChannelOverride, error)
	GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*db.SessionWithBanStatus, error)
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	// The three reads service.RequireDMNotBlocked makes through this seam.
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
}

// DisconnectMarker is the one write the connection teardown makes on its own
// behalf: stamping the user offline when their last pump exits. It is a seam
// rather than a raw call for the same reason the read seams are — the caller
// states the single method it may use — and it is deliberately its own
// interface rather than a method on a reader, because it writes.
type DisconnectMarker interface {
	MarkUserDisconnected(ctx context.Context, userID int64) error
}

// HubReaders bundles the seams HubOptions requires. Production wires
// DBReaders; the test helpers default it over the test database.
type HubReaders struct {
	Visibility VisibilityReader
	Ready      ReadySnapshotReader
	Members    MemberPayloadReader
	Dispatch   DispatchReader
	Disconnect DisconnectMarker
}

// complete reports whether every seam is present.
func (r HubReaders) complete() bool {
	return r.Visibility != nil && r.Ready != nil && r.Members != nil &&
		r.Dispatch != nil && r.Disconnect != nil
}

// DBReaders backs every seam with the database handle — the composition
// root's wiring today. Later B3-8 families narrow individual seams onto
// their services without touching the hub: the voice family did exactly
// that, taking StaleVoiceCleaner's two methods onto VoiceService, so this
// bundle lost a field rather than gaining one.
func DBReaders(d *db.DB) HubReaders {
	return HubReaders{Visibility: d, Ready: d, Members: d, Dispatch: d, Disconnect: d}
}

// ─── Voice membership seam (B3-8 voice family) ──────────────────────────────

// VoiceStore is the hub's view of the voice family: every read and write the
// voice paths make against voice_states, plus the moderation audit row that
// accompanies a moderator's write. service.VoiceService satisfies it in
// production; test helpers back it with a service over the test database.
//
// Unlike the read seams above this one is not satisfied by *db.DB — the
// family's decisions (which insert a capacity limit selects, which channel a
// compensating write may touch, whether a restore is worth a round trip) live
// on the service, not on the handle. That is the difference between a seam
// that only narrows the handle and a family that has actually moved.
type VoiceStore interface {
	// Reads.
	State(ctx context.Context, userID int64) (*db.VoiceState, error)
	ChannelStates(ctx context.Context, channelID int64) ([]db.VoiceState, error)
	AllStates(ctx context.Context) ([]db.VoiceState, error)
	CountInChannel(ctx context.Context, channelID int64) (int, error)

	// Membership.
	Join(ctx context.Context, userID, channelID int64, maxUsers int) error
	LeaveIfMatch(ctx context.Context, userID, channelID int64, joinedAt string) (bool, error)

	// The member's own flags.
	SetSelfMute(ctx context.Context, userID int64, muted bool) error
	SetSelfDeafen(ctx context.Context, userID int64, deafened bool) error
	SetCamera(ctx context.Context, userID int64, enabled bool) error
	SetScreenshare(ctx context.Context, userID int64, enabled bool) error
	ReserveCamera(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)
	ReserveScreenshare(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error)

	// Moderator flags and their compensations.
	SetServerMute(ctx context.Context, userID, channelID int64, muted bool) (bool, error)
	SetServerDeafen(ctx context.Context, userID, channelID int64, deafened bool) (bool, error)
	RestoreModFlags(ctx context.Context, userID, channelID int64, muted, deafened bool) *db.VoiceState
	RollbackServerDeafen(ctx context.Context, targetID, authorizedChannelID int64, requestedDeafen bool)
	WriteModAudit(ctx context.Context, actorID int64, action string, targetID int64, detail string)
}
