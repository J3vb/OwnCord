package service

import (
	"context"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/db"
)

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
	// mention_count for exactly the readers the guards admitted (the live-badge signal for a removal).
	DecrementMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) (map[int64]int64, error)
	GetReadState(ctx context.Context, userID, channelID int64) (lastMessageID, mentionCount int64, found bool, err error)
	GetLatestMessageID(ctx context.Context, channelID int64) (int64, error)
	// MoveReadPointer moves a reader's pointer and recomputes mention_count in one writer
	// transaction. The caller holds the channel's mention emit lock across it and its frame.
	MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error)
}

type mentionState struct {
	st    mentionStateStore
	perms *PermissionService
	// mentionIDs backs the <@id> and <@&id> forms; nil leaves them plain text.
	mentionIDs MentionIDStore
	// liveStatus returns userID's live status, "" with no connection. Wired by the ws layer
	// (Hub.LiveStatus) so @here reads the status the member list overlays, not users.status
	// (a chosen idle/dnd/invisible survives a disconnect; a connect lags a stamp flush).
	// Nil falls back to the row.
	liveStatus func(userID int64) string
	// mentionNotifier delivers the per-user mention_count frame (taskbar/tray badge). Nil
	// (tests, no hub) pushes nothing; NewHub installs the hub-backed one.
	mentionNotifier MentionCountNotifier
	// mentionEmitLocks serializes each mention_count write with its frame, per channel, so
	// frame order matches commit order across the worker flush and removal paths. Held across
	// write and frame enqueue; job resolution and visibility reads stay outside.
	mentionEmitLocks mentionEmitLocks
	// readStateNotifier delivers the read_state frame MoveReadPointer sends under the emit lock; nil leaves it
	// off.
	readStateNotifier ReadStateNotifier
	// mentionWorker is the single bounded worker owning every mention-badge write. Nil until
	// the composition root starts it (app.startHub); then SendMessage resolves inline. Atomic
	// because it starts while other goroutines may already be sending.
	mentionWorker atomic.Pointer[mentionWorker]
}

func newMentionState(st mentionStateStore, perms *PermissionService) *mentionState {
	m := &mentionState{st: st, perms: perms}
	m.mentionIDs, _ = st.(MentionIDStore)
	return m
}

// StartMentionWorker creates and starts the bounded worker and routes SendMessage's
// bookkeeping through it. The root calls it once (app.startHub); tests leave it uncalled
// for inline writes. ctx bounds the loop; the returned func drains and stops it.
func (s *mentionState) StartMentionWorker(ctx context.Context) func(context.Context) {
	w := newMentionWorker(s.st)
	// Share the write+emit lock with the removal paths so a coalesced increment flush cannot
	// be overtaken by an older decrement frame, or vice versa.
	w.emitLocks = &s.mentionEmitLocks
	w.prepare = s.mentionSendPreparer()
	// Start before publishing: run sets started synchronously, so a sender seeing the worker never drops a job.
	w.run(ctx)
	s.mentionWorker.Store(w)
	return w.stopAndDrain
}

func (s *mentionState) mentionWorkerForSend() *mentionWorker {
	if s == nil {
		return nil
	}
	return s.mentionWorker.Load()
}

// FlushPendingMentionCounts applies any queued badge job for msgIDs before the caller
// reverses them. Removal paths (DeleteMessage, PurgeMessages, erasure) must call it first:
// a message removed inside the coalesce window would be reversed before its increment
// landed, and the later flush would raise a phantom badge or, with the liveness guard, be
// skipped and take a genuine badge with it. No-op without a worker. ctx only bounds the
// wait; the worker applies jobs on its own context.
func (s *mentionState) FlushPendingMentionCounts(ctx context.Context, msgIDs []int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushMessages(ctx, msgIDs)
}

func (s *mentionState) flushChannelMentionCounts(ctx context.Context, channelID int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushChannel(ctx, channelID)
}

// FlushAllPendingMentionCounts applies every queued job, ignoring the coalesce window.
// Erasure calls it first since it deletes all of a user's messages. No-op without a worker.
func (s *mentionState) FlushAllPendingMentionCounts(ctx context.Context) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushNow(ctx)
}
