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
	GetSessionWithBanStatus(ctx context.Context, tokenHash string) (*db.SessionWithBanStatus, error)
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	// The three reads service.RequireDMNotBlocked makes through this seam.
	IsGroupDM(ctx context.Context, channelID int64) (bool, error)
	GetDMRecipient(ctx context.Context, channelID, userID int64) (*db.User, error)
	IsEitherBlocked(ctx context.Context, a, b int64) (bool, error)
}

// StaleVoiceCleaner is the one read-plus-write pair fresh-connect stale-voice
// cleanup (serve_ready.go) needs; it is deliberately not part of the ready
// reader — the write does not belong on a snapshot seam.
type StaleVoiceCleaner interface {
	GetVoiceState(ctx context.Context, userID int64) (*db.VoiceState, error)
	LeaveVoiceChannelIfMatch(ctx context.Context, userID, expectedChannelID int64, expectedJoinedAt string) (bool, error)
}

// HubReaders bundles the seams HubOptions requires. Production wires
// DBReaders; the test helpers default it over the test database.
type HubReaders struct {
	Visibility VisibilityReader
	Ready      ReadySnapshotReader
	Members    MemberPayloadReader
	Dispatch   DispatchReader
	StaleVoice StaleVoiceCleaner
}

// complete reports whether every seam is present.
func (r HubReaders) complete() bool {
	return r.Visibility != nil && r.Ready != nil && r.Members != nil && r.Dispatch != nil && r.StaleVoice != nil
}

// DBReaders backs every seam with the database handle — the composition
// root's wiring today. Later B3-8 families narrow individual seams onto
// their services without touching the hub.
func DBReaders(d *db.DB) HubReaders {
	return HubReaders{Visibility: d, Ready: d, Members: d, Dispatch: d, StaleVoice: d}
}
