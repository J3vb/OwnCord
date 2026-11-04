package service

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
)

// MentionCountNotifier delivers a live mention_count frame to one reader whose
// read_states.mention_count changed. channelID names the channel and
// count is the reader's total after the bump.
type MentionCountNotifier interface {
	NotifyMentionCount(userID, channelID, count int64)
}

// SetMentionNotifier installs the live unread-badge hook. The ws layer
// calls this once, in NewHub, with the hub's implementation; passing nil (or
// never calling it) leaves the hook off.
func (s *MessageService) SetMentionNotifier(n MentionCountNotifier) {
	s.mentionNotifier = n
}

// MentionCountBatcher is an optional extension of MentionCountNotifier. The
// service resolves a flush's audience through it once, before taking the
// channel's emit lock, so the per-reader visibility reads stay out of the
// critical section and only the frame enqueue runs under it.
type MentionCountBatcher interface {
	// PrepareMentionCounts decides which of userIDs may get a live mention_count
	// frame for channelID and returns the function that sends one. The sender
	// takes a reader's connections at call time and checks a reader the
	// preparation did not cover (a later connection) on its own.
	PrepareMentionCounts(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64)
}

// mentionSendPrep builds a channel's frame sender for a set of candidate readers.
type mentionSendPrep func(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64)

// mentionSendPreparer returns how this service prepares badge frames: through the
// hub's batch resolver when it has one, else one NotifyMentionCount per reader.
// Nil when no notifier is installed.
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

// prepareMentionSend is mentionSendPreparer applied; nil with no notifier. It
// reads the hook at call time, so a notifier installed after SendMessage still
// receives the frame.
func (s *mentionState) prepareMentionSend(ctx context.Context, channelID int64, userIDs []int64) func(userID, count int64) {
	prep := s.mentionSendPreparer()
	if prep == nil {
		return nil
	}
	return prep(ctx, channelID, userIDs)
}

// reverseMentionCounts lowers the mention_count bumps msgIDs made and pushes each
// admitted reader their new total, holding the channel's emit lock across both
// the write and the frame. That lock orders the badge frames: the mention
// worker's coalesced increment holds it across its write and frame, so a reader's
// last frame carries the latest committed total and a delete inside the coalesce
// window is never overtaken by an older increment total. The lowered readers are
// known only after the write, so their visibility is resolved under the lock, once
// per channel. A failed reversal emits nothing, so a reader keeps the total they
// have.
func (s *mentionState) reverseMentionCounts(ctx context.Context, channelID int64, msgIDs []int64) error {
	mu := s.mentionEmitLocks.forChannel(channelID)
	mu.Lock()
	defer mu.Unlock()
	lowered, err := s.st.DecrementMentionCounts(ctx, channelID, msgIDs)
	if err != nil {
		return err
	}
	if len(lowered) > 0 {
		emitMentionBumped(s.prepareMentionSend(ctx, channelID, bumpedUserIDs(lowered)), lowered)
	}
	return nil
}

// emitIncrement writes one channel's coalesced mention increment and pushes its
// frames, holding the channel's emit lock across both so an increment frame is
// never overtaken by a later decrement. The audience is resolved before the
// lock. It is the no-worker fallback; the bounded worker's flush holds the same
// lock (mentionWorker.emitLocks).
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

// dispatchMentionBadges routes one message's mention-badge job: to the bounded
// worker when one is running (production), or inline through bg otherwise
// (tests, and any caller built via NewMessageService directly), so a directly
// constructed service still has its counts readable right after a send.
func (s *MessageService) dispatchMentionBadges(bgCtx context.Context, job mentionJob) {
	if w := s.mentionWorkerForSend(); w != nil {
		// Production: hand the job to the single bounded worker on the caller's
		// goroutine. Enqueue never blocks, so no goroutine is spawned per send.
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
