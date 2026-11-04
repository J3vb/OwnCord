package service

import (
	"context"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/db"
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
	// receipts in one writer transaction. The caller holds the channel's mention emit
	// lock across it and the frame it sends.
	MoveReadPointer(ctx context.Context, userID, channelID int64, op db.ReadPointerOp, messageID int64) (db.ReadPointer, error)
}

// mentionState resolves who a message mentions and owns every mention_count
// and read-pointer write, together with the frame each one emits. The two stay
// in one part because they share mentionEmitLocks.
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
	// mentionEmitLocks serializes each mention_count write with the frame it emits,
	// per channel, so a channel's frame order matches its commit order across the
	// worker flush and the removal paths. Held across write and frame enqueue; job
	// resolution and the worker's visibility reads stay outside. See
	// mentionWorker.emitLocks and reverseMentionCounts.
	mentionEmitLocks mentionEmitLocks
	// readStateNotifier delivers the read_state frame MoveReadPointer sends under
	// the channel's mention emit lock; nil leaves it off.
	readStateNotifier ReadStateNotifier
	// mentionWorker is the single bounded worker owning every mention-badge write.
	// Nil until the composition root starts it (app.startHub); then SendMessage
	// resolves inline through bg. Atomic because it is started while other
	// goroutines may already be sending.
	mentionWorker atomic.Pointer[mentionWorker]
}

func newMentionState(st mentionStateStore, perms *PermissionService) *mentionState {
	m := &mentionState{st: st, perms: perms}
	m.mentionIDs, _ = st.(MentionIDStore)
	return m
}

// StartMentionWorker creates and starts the bounded mention-badge worker and
// routes SendMessage's bookkeeping through it. The root calls it once
// (app.startHub); tests leave it uncalled for deterministic inline writes. ctx
// bounds the loop; the returned func drains and stops it (App.Close's job).
func (s *mentionState) StartMentionWorker(ctx context.Context) func(context.Context) {
	w := newMentionWorker(s.st)
	// Share the write+emit lock with the removal paths so a coalesced increment
	// flush cannot be overtaken by an older decrement frame, or vice versa.
	w.emitLocks = &s.mentionEmitLocks
	// NewHub installed the hook before this runs; nil means no hub and no pushes.
	w.prepare = s.mentionSendPreparer()
	// Start before publishing: run sets started synchronously, so a sender seeing
	// the worker never observes it as not-started and drops a job.
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

// FlushPendingMentionCounts applies any still-queued mention-badge job for msgIDs
// before the caller reverses them. Removal paths (DeleteMessage, PurgeMessages,
// erasure) must call it first: a message removed inside the coalesce window would
// be reversed before its increment landed, and the later flush would raise a
// phantom badge or, with the liveness guard, be skipped and take a genuine badge
// with it. A no-op without a worker (the inline fallback already wrote the
// increment). ctx only bounds the wait; the worker applies jobs on its own loop
// context, so a canceled caller cannot drop the flush.
func (s *mentionState) FlushPendingMentionCounts(ctx context.Context, msgIDs []int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushMessages(ctx, msgIDs)
}

// flushChannelMentionCounts is FlushPendingMentionCounts for every queued job on
// a channel (PurgeMessages cannot name the ids until after the purge).
func (s *mentionState) flushChannelMentionCounts(ctx context.Context, channelID int64) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushChannel(ctx, channelID)
}

// FlushAllPendingMentionCounts applies every queued job, ignoring the coalesce
// window. Erasure calls it first since it deletes all of a user's messages and
// cannot cheaply name them. A no-op without a worker.
func (s *mentionState) FlushAllPendingMentionCounts(ctx context.Context) {
	w := s.mentionWorkerForSend()
	if w == nil {
		return
	}
	w.flushNow(ctx)
}
