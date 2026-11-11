package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// MentionCountNotifier delivers a live mention_count frame to one reader whose
// read_states.mention_count changed; count is the reader's total after the bump.
type MentionCountNotifier interface {
	NotifyMentionCount(userID, channelID, count int64)
}

// SetMentionNotifier installs the live unread-badge hook; the ws layer calls it once in
// NewHub. Nil (or never calling it) leaves the hook off.
func (s *MessageService) SetMentionNotifier(n MentionCountNotifier) {
	s.mentionNotifier = n
}

// MentionCountBatcher is an optional extension of MentionCountNotifier: the service
// resolves a flush's audience through it before taking the channel's emit lock, keeping
// the per-reader visibility reads out of the critical section.
type MentionCountBatcher interface {
	// PrepareMentionCounts decides which of userIDs may get a live mention_count frame for
	// channelID and returns the sender. The sender takes connections at call time and checks a
	// reader the preparation missed (a later connection) itself. Call it on the preparing
	// goroutine or after a happens-before such as the emit lock.
	PrepareMentionCounts(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64)
}

type mentionSendPrep func(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64)

func (s *mentionState) mentionSendPreparer() mentionSendPrep {
	n := s.mentionNotifier
	if n == nil {
		return nil
	}
	if b, ok := n.(MentionCountBatcher); ok {
		return b.PrepareMentionCounts
	}
	return func(_ context.Context, channelID int64, _ []int64) func(userID, count int64) {
		return func(userID, count int64) { n.NotifyMentionCount(userID, channelID, count) }
	}
}

func (s *mentionState) prepareMentionSend(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64) {
	prep := s.mentionSendPreparer()
	if prep == nil {
		return nil
	}
	return prep(ctx, channelID, userIDs)
}

// reverseMentionCounts lowers the bumps msgIDs made and pushes each admitted reader their
// new total, holding the channel's emit lock across write and frame. That lock orders badge
// frames (the worker's increment holds it too), so a reader's last frame carries the latest
// committed total and a delete inside the coalesce window is never overtaken by an older
// increment. Lowered readers are known only after the write, so visibility is resolved
// under the lock, once per channel. A failed reversal emits nothing.
func (s *mentionState) reverseMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) error {
	mu := s.mentionEmitLocks.forChannel(channelID)
	mu.Lock()
	defer mu.Unlock()
	return s.reverseMentionCountsLocked(ctx, channelID, msgIDs)
}

// removeAndReverseMentions runs write, which soft-deletes messages in channelID
// and returns their ids, and reverses those messages' mention badges, all under one
// hold of the channel's emit lock. A reader's read-pointer move takes the same lock
// and recomputes the badge without deleted messages, so it must see the removal
// and its reversal as one step: between them it would count the removal already,
// and the reversal would then take the same mention a second time. The lock order
// is the emit lock, then the writer, as in the mention worker's flush.
//
// Callers flush queued increments before calling, since that flush takes this lock
// itself, and call it for one channel at a time: channels share lock stripes, so
// holding two could deadlock. Waiting for the lock honours ctx and writes nothing
// when it ends. write's error comes back as err with nothing reversed; a failed
// reversal comes back as reverseErr, the removal having committed. The reversal
// runs detached from ctx.
func (s *mentionState) removeAndReverseMentions(ctx context.Context, channelID int64, write func() ([]int64, error)) (ids []int64, reverseErr, err error) {
	mu := s.mentionEmitLocks.forChannel(channelID)
	if lockErr := syncutil.LockContext(ctx, mu); lockErr != nil {
		return nil, nil, fmt.Errorf("remove messages: %w", lockErr)
	}
	defer mu.Unlock()
	ids, err = write()
	if err != nil {
		return nil, nil, err
	}
	return ids, s.reverseMentionCountsLocked(context.WithoutCancel(ctx), channelID, ids), nil
}

// reverseMentionCountsLocked is reverseMentionCounts for a caller that holds the
// channel's emit lock.
func (s *mentionState) reverseMentionCountsLocked(ctx context.Context, channelID int64, msgIDs []int64) error {
	lowered, err := s.st.DecrementMentionCounts(ctx, channelID, msgIDs)
	if err != nil {
		return err
	}
	if len(lowered) > 0 {
		emitMentionBumped(s.prepareMentionSend(ctx, channelID, bumpedUserIDs(lowered)), lowered)
	}
	return nil
}

// emitIncrement writes one channel's coalesced increment and pushes its frames under the
// emit lock, so it is never overtaken by a later decrement. Audience resolved before the
// lock. The no-worker fallback; the worker holds the same lock.
func (s *mentionState) emitIncrement(ctx context.Context, channelID int64, entries []db.MentionBatchEntry) {
	send := s.prepareMentionSend(ctx, channelID, entryUserIDs(entries))
	mu := s.mentionEmitLocks.forChannel(channelID)
	mu.Lock()
	defer mu.Unlock()
	bumped, err := s.st.IncrementMentionCountsBatch(ctx, channelID, entries)
	if err != nil {
		slog.Error("MessageService.mention fan-out IncrementMentionCounts", "err", err, "channel_id", channelID)
		return
	}
	emitMentionBumped(send, bumped)
}

// dispatchMentionBadges routes one message's badge job: to the bounded worker when
// running (production), else inline through bg (tests, directly constructed services), so
// counts are readable right after a send.
func (s *MessageService) dispatchMentionBadges(bgCtx context.Context, job mentionJob) {
	if w := s.mentionWorkerForSend(); w != nil {
		w.enqueue(job)
		return
	}
	s.runBackground(bgCtx, "mention write", func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, backgroundJobTimeout)
		defer cancel()
		entries := job.apply(ctx)
		if len(entries) == 0 {
			return
		}
		s.emitIncrement(ctx, job.channelID, entries)
	})
}
