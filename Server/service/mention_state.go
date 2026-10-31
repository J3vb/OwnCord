package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// mentionStateStore is what mentionState reads and writes. *db.DB satisfies it.
type mentionStateStore interface {
	mentionBatchStore
	readAdmitStore
	GetUserIDsByUsernames(ctx context.Context, usernames []string) (map[string]int64, error)
	ListRoles(ctx context.Context) ([]*db.Role, error)
	ListMentionTargetsByRoles(ctx context.Context, roleIDs []int64) ([]db.MentionTarget, error)
	ListMentionTargetsByUserIDs(ctx context.Context, userIDs []int64) ([]db.MentionTarget, error)
	ListBlockersOf(ctx context.Context, blockedID int64) ([]int64, error)
	GetChannelOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	GetChannelUserOverrides(ctx context.Context, channelID int64) (map[int64]db.ChannelOverride, error)
	// DecrementMentionCounts reverses the bumps msgIDs made and returns userID to
	// mention_count for exactly the readers the guards admitted, the live-badge signal
	// for a removal path.
	DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) (map[int64]int64, error)
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
	// MoveReadPointer moves a reader's pointer and recomputes mention_count from the
	// receipts in one writer transaction. The caller holds mentionEmitMu across it and
	// the frame it sends.
	MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error)
}

// mentionState resolves who a message mentions and owns every mention_count
// and read-pointer write, together with the frame each one emits. The two stay
// in one part because they share mentionEmitMu.
type mentionState struct {
	st    mentionStateStore
	perms *PermissionService
	// mentionIDs backs the <@id> and <@&id> forms; nil leaves those as plain text.
	mentionIDs MentionIDStore
	// liveStatus returns userID's live status, "" with no live connection. The ws
	// layer wires it (Hub.LiveStatus) so @here reads the status the member list
	// overlays (ws/serve_ready.go presentableMembers), not users.status, which keeps
	// a chosen idle/dnd/invisible across a disconnect and lags a connect by up to one
	// StampFlushInterval. Nil falls back to the row.
	liveStatus func(userID int64) string
	// mentionNotifier delivers the per-user mention_count frame (taskbar/tray badge)
	// for each reader whose badge a mention raised. Nil (tests, no hub) pushes
	// nothing; NewHub installs the hub-backed one.
	mentionNotifier MentionCountNotifier
	// mentionEmitMu serializes each mention_count write with the frame it emits, so
	// frame order matches commit order across the worker flush and the removal paths.
	// Held across write, notify and visibility check; job resolution stays outside.
	// See mentionWorker.emitMu and reverseMentionCounts.
	mentionEmitMu syncutil.Mutex
	// readStateNotifier delivers the read_state frame MoveReadPointer sends under
	// mentionEmitMu; nil leaves it off.
	readStateNotifier ReadStateNotifier
}

func newMentionState(st mentionStateStore, perms *PermissionService) *mentionState {
	m := &mentionState{st: st, perms: perms}
	m.mentionIDs, _ = st.(MentionIDStore)
	return m
}
